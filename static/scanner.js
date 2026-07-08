/* Web Camera Scanner — QR + OCR mileage reading */

let videoStream = null;
let scanInterval = null;
let lastSentKey = "";
let facingMode = "environment";
let tesseractWorker = null;
let useServerOcr = false;

const SCAN_INTERVAL_MS = 2000;

// Match utils/ocr_preprocessing.py ROI sizing
const ROI_Y_OFFSET = 8;
const ROI_HEIGHT_RATIO = 0.55;
const ROI_HEIGHT_MIN = 40;
const ROI_HEIGHT_MAX = 75;
const ROI_X_PAD_RATIO = 0.40;
const ROI_X_PAD_MIN = 55;

function computeMileageRoi(qrLeft, qrTop, qrWidth, qrHeight, frameW, frameH) {
    const xPad = Math.max(ROI_X_PAD_MIN, Math.round(qrWidth * ROI_X_PAD_RATIO));
    const roiH = Math.max(
        ROI_HEIGHT_MIN,
        Math.min(ROI_HEIGHT_MAX, Math.round(qrHeight * ROI_HEIGHT_RATIO))
    );
    const qrBottom = qrTop + qrHeight;
    const x1 = Math.max(qrLeft - xPad, 0);
    const x2 = Math.min(qrLeft + qrWidth + xPad, frameW);
    const y1 = Math.min(qrBottom + ROI_Y_OFFSET, frameH - 1);
    const y2 = Math.min(y1 + roiH, frameH);
    return { x1, y1, x2, y2 };
}

function toGrayscale(imageData) {
    const { width, height, data } = imageData;
    const gray = new Uint8ClampedArray(width * height);
    for (let i = 0; i < width * height; i++) {
        const idx = i * 4;
        gray[i] = Math.round(0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2]);
    }
    return { width, height, gray };
}

function stretchContrast(gray, width, height) {
    let min = 255;
    let max = 0;
    for (let i = 0; i < gray.length; i++) {
        if (gray[i] < min) min = gray[i];
        if (gray[i] > max) max = gray[i];
    }
    const range = max - min || 1;
    const out = new Uint8ClampedArray(gray.length);
    for (let i = 0; i < gray.length; i++) {
        out[i] = Math.round(((gray[i] - min) / range) * 255);
    }
    return out;
}

function otsuThreshold(gray) {
    const hist = new Array(256).fill(0);
    for (let i = 0; i < gray.length; i++) hist[gray[i]]++;

    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0;
    let wB = 0;
    let wF = 0;
    let maxVar = 0;
    let threshold = 127;
    const total = gray.length;

    for (let t = 0; t < 256; t++) {
        wB += hist[t];
        if (!wB) continue;
        wF = total - wB;
        if (!wF) break;
        sumB += t * hist[t];
        const mB = sumB / wB;
        const mF = (sum - sumB) / wF;
        const varBetween = wB * wF * (mB - mF) * (mB - mF);
        if (varBetween > maxVar) {
            maxVar = varBetween;
            threshold = t;
        }
    }

    const binary = new Uint8ClampedArray(gray.length);
    for (let i = 0; i < gray.length; i++) {
        binary[i] = gray[i] > threshold ? 255 : 0;
    }
    return binary;
}

function cropDigitBand(gray, width, height) {
    const rowDensity = new Float32Array(height);
    for (let y = 0; y < height; y++) {
        let dark = 0;
        for (let x = 0; x < width; x++) {
            if (gray[y * width + x] < 128) dark++;
        }
        rowDensity[y] = dark;
    }

    let peakRow = 0;
    let peakVal = 0;
    for (let y = 0; y < height; y++) {
        if (rowDensity[y] > peakVal) {
            peakVal = rowDensity[y];
            peakRow = y;
        }
    }
    if (peakVal <= 0) return { gray, width, height, yOffset: 0 };

    const cutoff = peakVal * 0.45;
    let y1 = peakRow;
    let y2 = peakRow;
    while (y1 > 0 && rowDensity[y1 - 1] >= cutoff) y1--;
    while (y2 < height - 1 && rowDensity[y2 + 1] >= cutoff) y2++;

    y1 = Math.max(y1 - 2, 0);
    y2 = Math.min(y2 + 3, height);
    const bandH = y2 - y1;
    if (bandH < 8) return { gray, width, height, yOffset: 0 };

    const band = new Uint8ClampedArray(width * bandH);
    for (let y = 0; y < bandH; y++) {
        band.set(gray.subarray((y1 + y) * width, (y1 + y + 1) * width), y * width);
    }
    return { gray: band, width, height: bandH, yOffset: y1 };
}

function preprocessForOcr(imageData) {
    const { width, height, gray: rawGray } = toGrayscale(imageData);
    const stretched = stretchContrast(rawGray, width, height);
    const band = cropDigitBand(stretched, width, height);
    const scale = 4;
    const sw = band.width * scale;
    const sh = band.height * scale;

    const canvas = document.createElement("canvas");
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext("2d");
    const temp = document.createElement("canvas");
    temp.width = band.width;
    temp.height = band.height;
    const tempCtx = temp.getContext("2d");
    const tempData = tempCtx.createImageData(band.width, band.height);
    for (let i = 0; i < band.gray.length; i++) {
        const v = band.gray[i];
        const idx = i * 4;
        tempData.data[idx] = v;
        tempData.data[idx + 1] = v;
        tempData.data[idx + 2] = v;
        tempData.data[idx + 3] = 255;
    }
    tempCtx.putImageData(tempData, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(temp, 0, 0, sw, sh);

    const scaled = ctx.getImageData(0, 0, sw, sh);
    const scaledGray = toGrayscale(scaled).gray;
    const binary = otsuThreshold(scaledGray);
    const inverted = new Uint8ClampedArray(binary.length);
    for (let i = 0; i < binary.length; i++) inverted[i] = binary[i] ^ 255;

    return [
        { width: sw, height: sh, gray: binary },
        { width: sw, height: sh, gray: inverted },
    ];
}

function grayToCanvas(grayObj) {
    const canvas = document.createElement("canvas");
    canvas.width = grayObj.width;
    canvas.height = grayObj.height;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(grayObj.width, grayObj.height);
    for (let i = 0; i < grayObj.gray.length; i++) {
        const v = grayObj.gray[i];
        const idx = i * 4;
        img.data[idx] = v;
        img.data[idx + 1] = v;
        img.data[idx + 2] = v;
        img.data[idx + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
}

function scoreOcrCandidate(digits, confidence) {
    if (!digits || !/^\d+$/.test(digits)) return 0;
    if (digits.length < 4 || digits.length > 8) return confidence * 0.15;
    const lengthScore =
        digits.length === 6 ? 1 : Math.max(0.35, 1 - Math.abs(digits.length - 6) * 0.18);
    return Math.max(confidence * lengthScore, digits.length >= 5 && digits.length <= 7 ? 0.35 : 0);
}

async function initTesseract() {
    if (tesseractWorker) return tesseractWorker;
    try {
        tesseractWorker = await Tesseract.createWorker("eng", 1, {
            logger: () => {},
        });
        await tesseractWorker.setParameters({
            tessedit_char_whitelist: "0123456789",
            tessedit_pageseg_mode: "7",
        });
        return tesseractWorker;
    } catch (e) {
        console.warn("Tesseract init failed, will use server OCR:", e);
        useServerOcr = true;
        return null;
    }
}

async function startCamera() {
    const video = document.getElementById("cameraVideo");
    const overlay = document.getElementById("cameraOverlay");

    try {
        const constraints = {
            video: {
                facingMode: facingMode,
                width: { ideal: 1280 },
                height: { ideal: 720 },
            },
            audio: false,
        };

        if (videoStream) {
            videoStream.getTracks().forEach((t) => t.stop());
        }

        videoStream = await navigator.mediaDevices.getUserMedia(constraints);
        video.srcObject = videoStream;
        overlay.hidden = true;

        document.getElementById("startCameraBtn").hidden = true;
        document.getElementById("stopCameraBtn").hidden = false;
        document.getElementById("switchCameraBtn").hidden = false;

        await initTesseract();
        startScanLoop();
        setStatus("Camera active — scanning for QR and mileage...");
    } catch (err) {
        setStatus("Camera error: " + err.message + ". Check browser permissions.", "error");
        overlay.hidden = false;
        overlay.querySelector("p").textContent = "Camera access denied. Allow camera permission and try again.";
    }
}

function stopCamera() {
    if (scanInterval) {
        clearInterval(scanInterval);
        scanInterval = null;
    }
    if (videoStream) {
        videoStream.getTracks().forEach((t) => t.stop());
        videoStream = null;
    }
    document.getElementById("cameraVideo").srcObject = null;
    document.getElementById("startCameraBtn").hidden = false;
    document.getElementById("stopCameraBtn").hidden = true;
    document.getElementById("switchCameraBtn").hidden = true;
    document.getElementById("cameraOverlay").hidden = false;
    setStatus("Camera stopped");
}

async function switchCamera() {
    facingMode = facingMode === "environment" ? "user" : "environment";
    await startCamera();
}

function startScanLoop() {
    if (scanInterval) clearInterval(scanInterval);
    scanInterval = setInterval(processFrame, SCAN_INTERVAL_MS);
    processFrame();
}

async function processFrame() {
    const video = document.getElementById("cameraVideo");
    const canvas = document.getElementById("cameraCanvas");

    if (!videoStream || video.readyState < 2) return;

    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return;

    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, w, h);
    const imageData = ctx.getImageData(0, 0, w, h);

    let trainId = "";
    let qrConfidence = 0;
    let mileage = "";
    let ocrConfidence = 0;

    if (typeof jsQR !== "undefined") {
        const qr = jsQR(imageData.data, w, h, { inversionAttempts: "attemptBoth" });
        if (qr && qr.data) {
            trainId = qr.data.trim().toUpperCase();
            qrConfidence = 0.98;

            const loc = qr.location;
            const xs = [loc.topLeftCorner.x, loc.topRightCorner.x, loc.bottomRightCorner.x, loc.bottomLeftCorner.x];
            const ys = [loc.topLeftCorner.y, loc.topRightCorner.y, loc.bottomRightCorner.y, loc.bottomLeftCorner.y];
            const qrLeft = Math.min(...xs);
            const qrTop = Math.min(...ys);
            const qrRight = Math.max(...xs);
            const qrBottom = Math.max(...ys);
            const qrWidth = qrRight - qrLeft;
            const qrHeight = qrBottom - qrTop;

            const roi = computeMileageRoi(qrLeft, qrTop, qrWidth, qrHeight, w, h);

            if (roi.y2 > roi.y1 && roi.x2 > roi.x1) {
                const roiData = ctx.getImageData(roi.x1, roi.y1, roi.x2 - roi.x1, roi.y2 - roi.y1);
                const ocrResult = await runOcr(roiData, { preferServer: true });
                mileage = ocrResult.mileage;
                ocrConfidence = ocrResult.confidence;
            }
        }
    }

    if (!mileage) {
        const ocrResult = await runOcr(imageData);
        if (!trainId && ocrResult.mileage) {
            mileage = ocrResult.mileage;
            ocrConfidence = ocrResult.confidence * 0.7;
        }
    }

    updateScanDisplay(trainId, mileage, qrConfidence, ocrConfidence);

    if (trainId && mileage && VALID_TRAINS.has(trainId)) {
        const key = trainId + ":" + mileage;
        if (key !== lastSentKey) {
            await sendScan(trainId, mileage, ocrConfidence, qrConfidence);
            lastSentKey = key;
        }
    } else if (trainId && !VALID_TRAINS.has(trainId)) {
        setStatus("QR detected: " + trainId + " — not in fleet. Add via Admin → Train Management.", "warn");
    } else if (trainId && !mileage) {
        setStatus("QR found: " + trainId + " — reading mileage...", "info");
    }
}

async function runOcr(imageData, options = {}) {
    const { preferServer = false } = options;

    if (preferServer || useServerOcr || !tesseractWorker) {
        const serverResult = await runServerOcr(imageData);
        if (serverResult.mileage) return serverResult;
        if (useServerOcr || !tesseractWorker) return serverResult;
    }

    try {
        const variants = preprocessForOcr(imageData);
        let best = { mileage: "", confidence: 0 };

        for (const variant of variants) {
            const canvas = grayToCanvas(variant);
            const { data } = await tesseractWorker.recognize(canvas);
            const digits = (data.text || "").replace(/[^0-9]/g, "");
            const conf = data.confidence ? data.confidence / 100 : 0;
            const score = scoreOcrCandidate(digits, conf);
            if (score > best.confidence || (score === best.confidence && digits.length > best.mileage.length)) {
                best = { mileage: digits, confidence: digits ? Math.min(0.99, score) : 0 };
            }
        }

        if (best.mileage && best.confidence >= 0.55) {
            return best;
        }

        const serverResult = await runServerOcr(imageData);
        if (serverResult.mileage && serverResult.confidence >= best.confidence) {
            return serverResult;
        }
        return best.mileage ? best : serverResult;
    } catch (e) {
        return await runServerOcr(imageData);
    }
}

async function runServerOcr(imageData) {
    try {
        const offscreen = document.createElement("canvas");
        offscreen.width = imageData.width;
        offscreen.height = imageData.height;
        offscreen.getContext("2d").putImageData(imageData, 0, 0);
        const base64 = offscreen.toDataURL("image/png");

        const res = await fetch("/api/scan-ocr", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ image: base64 }),
        });
        const data = await res.json();
        if (data.success && data.mileage) {
            return { mileage: data.mileage, confidence: data.confidence || 0.85 };
        }
    } catch (e) {
        console.error("Server OCR failed:", e);
    }
    return { mileage: "", confidence: 0 };
}

function updateScanDisplay(trainId, mileage, qrConf, ocrConf) {
    document.getElementById("scanTrainId").textContent = trainId || "—";
    document.getElementById("scanMileage").textContent = mileage ? Number(mileage).toLocaleString() + " km" : "—";
    document.getElementById("scanQrConf").textContent = qrConf ? Math.round(qrConf * 100) + "%" : "—";
    document.getElementById("scanOcrConf").textContent = ocrConf ? Math.round(ocrConf * 100) + "%" : "—";
}

async function sendScan(trainId, mileage, ocrConf, qrConf) {
    setStatus("Sending " + trainId + " @ " + Number(mileage).toLocaleString() + " km...", "info");

    try {
        const res = await fetch("/api/update-mileage", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                train_id: trainId,
                mileage: parseInt(mileage, 10),
                ocr_confidence: ocrConf || 0.85,
                qr_confidence: qrConf || 0.95,
            }),
        });
        const data = await res.json();
        document.getElementById("scanLog").textContent = JSON.stringify(data, null, 2);

        if (data.success) {
            setStatus("✓ " + data.message, "success");
        } else {
            setStatus("✗ " + data.message, "error");
            lastSentKey = "";
        }
    } catch (e) {
        setStatus("Network error: " + e.message, "error");
        lastSentKey = "";
    }
}

async function submitManualScan(e) {
    e.preventDefault();
    const trainId = document.getElementById("manualTrainId").value.trim().toUpperCase();
    const mileage = document.getElementById("manualMileage").value;

    if (!VALID_TRAINS.has(trainId)) {
        setStatus("Train " + trainId + " not found. Add it via Admin → Train Management.", "error");
        return;
    }

    lastSentKey = "";
    await sendScan(trainId, mileage, 1.0, 1.0);
}

function setStatus(msg, type) {
    const el = document.getElementById("scanStatusText");
    el.textContent = msg;
    el.className = type ? "status-" + type : "";
}

if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    document.getElementById("cameraOverlay").querySelector("p").textContent =
        "Camera not supported in this browser. Use manual entry below.";
    document.getElementById("startCameraBtn").disabled = true;
}
