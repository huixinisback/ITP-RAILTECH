"""Shared OCR preprocessing for mileage digit recognition."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Optional, Tuple

import cv2
import numpy as np
import pytesseract
from PIL import Image

from config import TESSERACT_CMD

if os.path.isfile(TESSERACT_CMD):
    pytesseract.pytesseract.tesseract_cmd = TESSERACT_CMD

TESSERACT_CONFIG = r"--oem 3 -c tessedit_char_whitelist=0123456789"
PSM_MODES = (7, 8, 13)  # single line, single word, raw line

ROI_Y_OFFSET = 8
ROI_HEIGHT_RATIO = 0.55
ROI_HEIGHT_MIN = 40
ROI_HEIGHT_MAX = 75
ROI_X_PAD_RATIO = 0.40
ROI_X_PAD_MIN = 55


@dataclass
class OcrResult:
    mileage: str
    confidence: float
    raw: str = ""


def compute_mileage_roi(
    qr_x: int,
    qr_y: int,
    qr_w: int,
    qr_h: int,
    frame_w: int,
    frame_h: int,
) -> Tuple[int, int, int, int]:
    """Return (x1, y1, x2, y2) for the digit row below a QR code."""
    x_pad = max(ROI_X_PAD_MIN, int(qr_w * ROI_X_PAD_RATIO))
    roi_h = max(ROI_HEIGHT_MIN, min(ROI_HEIGHT_MAX, int(qr_h * ROI_HEIGHT_RATIO)))

    x1 = max(qr_x - x_pad, 0)
    x2 = min(qr_x + qr_w + x_pad, frame_w)
    y1 = min(qr_y + qr_h + ROI_Y_OFFSET, frame_h - 1)
    y2 = min(y1 + roi_h, frame_h)

    return x1, y1, x2, y2


def _crop_digit_band(gray: np.ndarray) -> np.ndarray:
    """Isolate the dark horizontal band that contains odometer digits."""
    h, w = gray.shape[:2]
    if h < 8 or w < 8:
        return gray

    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    _, dark_mask = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

    row_density = np.sum(dark_mask > 0, axis=1).astype(np.float32)
    if row_density.max() <= 0:
        return gray

    kernel = max(3, h // 12)
    if kernel % 2 == 0:
        kernel += 1
    smoothed = cv2.GaussianBlur(row_density.reshape(-1, 1), (1, kernel), 0).flatten()

    peak_row = int(np.argmax(smoothed))
    threshold = smoothed[peak_row] * 0.45
    rows = np.where(smoothed >= threshold)[0]
    if rows.size == 0:
        return gray

    y1 = max(int(rows[0]) - 2, 0)
    y2 = min(int(rows[-1]) + 3, h)
    if y2 - y1 < 8:
        return gray

    return gray[y1:y2, :]


def _enhance_gray(gray: np.ndarray) -> np.ndarray:
    clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)
    return cv2.bilateralFilter(enhanced, 5, 50, 50)


def _threshold_variants(gray: np.ndarray) -> list[np.ndarray]:
    """Generate multiple binarized views for OCR voting."""
    variants: list[np.ndarray] = []
    h, w = gray.shape[:2]
    block = max(11, (min(h, w) // 8) | 1)

    _, otsu = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    variants.append(otsu)
    variants.append(cv2.bitwise_not(otsu))

    adaptive = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, block, 4
    )
    variants.append(adaptive)
    variants.append(cv2.bitwise_not(adaptive))

    return variants


def _clean_binary(img: np.ndarray) -> np.ndarray:
    h_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 1))
    v_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, 3))
    closed = cv2.morphologyEx(img, cv2.MORPH_CLOSE, h_kernel, iterations=1)
    closed = cv2.morphologyEx(closed, cv2.MORPH_CLOSE, v_kernel, iterations=1)
    opened = cv2.morphologyEx(closed, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8), iterations=1)
    return opened


def preprocess_roi(bgr_roi: np.ndarray, return_debug: bool = False):
    """
    Preprocess a mileage ROI for OCR.

    Returns (best_binary, all_variants) or (best_binary, all_variants, digit_band_gray).
    """
    gray = cv2.cvtColor(bgr_roi, cv2.COLOR_BGR2GRAY)
    band = _crop_digit_band(gray)
    enhanced = _enhance_gray(band)
    upscaled = cv2.resize(enhanced, None, fx=4, fy=4, interpolation=cv2.INTER_CUBIC)

    variants = [_clean_binary(v) for v in _threshold_variants(upscaled)]
    best = variants[0] if variants else upscaled

    if return_debug:
        return best, variants, upscaled
    return best, variants


def _score_candidate(digits: str, conf: float) -> float:
    if not digits or not digits.isdigit():
        return 0.0
    if len(digits) < 4 or len(digits) > 8:
        return conf * 0.15
    length_score = 1.0 if len(digits) == 6 else max(0.35, 1.0 - abs(len(digits) - 6) * 0.18)
    return max(conf * length_score, 0.35 if 5 <= len(digits) <= 7 else 0.0)


def _extract_digits_from_data(data: dict) -> tuple[str, float]:
    """Build digit string from left-to-right OCR boxes on the same text row."""
    boxes = []
    for i, text in enumerate(data["text"]):
        token = re.sub(r"[^0-9]", "", text or "")
        if not token:
            continue
        conf = float(data["conf"][i])
        if conf < 0:
            continue
        width = int(data["width"][i])
        height = int(data["height"][i])
        if width <= 0 or height <= 0:
            continue
        boxes.append({
            "text": token,
            "conf": conf,
            "left": int(data["left"][i]),
            "top": int(data["top"][i]),
            "width": width,
            "height": height,
        })

    if not boxes:
        return "", 0.0

    boxes.sort(key=lambda b: (b["top"], b["left"]))
    row_threshold = max(8, int(np.median([b["height"] for b in boxes]) * 0.75))
    anchor_top = int(np.median([b["top"] for b in boxes]))

    row_boxes = [
        b for b in boxes
        if abs(b["top"] - anchor_top) <= row_threshold
    ]
    if len(row_boxes) < max(3, len(boxes) // 2):
        row_boxes = boxes

    row_boxes.sort(key=lambda b: b["left"])
    digits = "".join(b["text"] for b in row_boxes)
    conf = sum(b["conf"] for b in row_boxes) / len(row_boxes)
    return digits, conf


def _pick_best_candidate(candidates: list[tuple[str, float, np.ndarray]]) -> tuple[OcrResult, Optional[np.ndarray]]:
    if not candidates:
        return OcrResult(mileage="", confidence=0.0, raw=""), None

    scored = []
    for digits, conf, img in candidates:
        score = _score_candidate(digits, conf / 100.0)
        if score > 0:
            scored.append((score, digits, conf, img))

    if not scored:
        return OcrResult(mileage="", confidence=0.0, raw=""), None

    # Prefer digit strings that appear across multiple preprocessing strategies.
    counts: dict[str, int] = {}
    for _, digits, _, _ in scored:
        counts[digits] = counts.get(digits, 0) + 1

    scored.sort(
        key=lambda item: (
            counts.get(item[1], 0),
            -abs(len(item[1]) - 6),
            item[0],
        ),
        reverse=True,
    )

    _, digits, conf, img = scored[0]
    result = OcrResult(
        mileage=digits,
        confidence=_score_candidate(digits, conf / 100.0),
        raw=digits,
    )
    return result, img


def recognize_digits(
    bgr_roi: np.ndarray,
    return_processed: bool = False,
) -> OcrResult | Tuple[OcrResult, np.ndarray]:
    """Run multi-strategy OCR on a mileage ROI and return the best digit string."""
    candidates: list[tuple[str, float, np.ndarray]] = []

    _, variants = preprocess_roi(bgr_roi)
    for binary in variants:
        for psm in PSM_MODES:
            config = f"{TESSERACT_CONFIG} --psm {psm}"
            data = pytesseract.image_to_data(
                Image.fromarray(binary), config=config, output_type=pytesseract.Output.DICT
            )
            digits, conf = _extract_digits_from_data(data)
            if digits:
                candidates.append((digits, conf, binary))
                continue

            raw = pytesseract.image_to_string(Image.fromarray(binary), config=config).strip()
            digits = re.sub(r"[^0-9]", "", raw)
            if digits:
                candidates.append((digits, 55.0, binary))

    best, best_img = _pick_best_candidate(candidates)

    if return_processed:
        processed = best_img if best_img is not None else variants[0]
        return best, processed
    return best
