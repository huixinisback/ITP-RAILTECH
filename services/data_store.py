import json
import os
import uuid
from datetime import datetime

# Global GCS client cache
_gcs_client = None
_gcs_bucket = None


def _get_gcs_bucket():
    global _gcs_client, _gcs_bucket
    bucket_name = os.environ.get("GCS_BUCKET_NAME")
    if not bucket_name:
        return None
    if _gcs_bucket is None:
        try:
            from google.cloud import storage
            _gcs_client = storage.Client()
            _gcs_bucket = _gcs_client.bucket(bucket_name)
        except Exception as e:
            print(f"Error initializing GCS client for bucket {bucket_name}: {e}")
            return None
    return _gcs_bucket


def load_json(file_path, default=None):
    if default is None:
        default = []

    bucket = _get_gcs_bucket()
    if bucket:
        # Standardize the file path to a blob name (e.g. data/trains.json)
        blob_name = os.path.normpath(file_path).replace("\\", "/")
        if ":" in blob_name:
            blob_name = blob_name.split(":", 1)[1].lstrip("/")
        blob_name = blob_name.lstrip("./")

        blob = bucket.blob(blob_name)
        try:
            if not blob.exists():
                return default if not isinstance(default, dict) else default.copy()
            content = blob.download_as_text(encoding="utf-8")
            return json.loads(content)
        except Exception as e:
            print(f"Error loading {blob_name} from GCS: {e}")
            return default if not isinstance(default, dict) else default.copy()

    # Local fallback
    if not os.path.exists(file_path):
        return default if not isinstance(default, dict) else default.copy()
    with open(file_path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_json(file_path, data):
    bucket = _get_gcs_bucket()
    if bucket:
        blob_name = os.path.normpath(file_path).replace("\\", "/")
        if ":" in blob_name:
            blob_name = blob_name.split(":", 1)[1].lstrip("/")
        blob_name = blob_name.lstrip("./")

        blob = bucket.blob(blob_name)
        try:
            blob.upload_from_string(json.dumps(data, indent=2), content_type="application/json", encoding="utf-8")
            return
        except Exception as e:
            print(f"Error saving {blob_name} to GCS: {e}")

    os.makedirs(os.path.dirname(file_path), exist_ok=True)
    with open(file_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


def now_str():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def new_id(prefix=""):
    uid = str(uuid.uuid4())[:8].upper()
    return f"{prefix}{uid}" if prefix else uid

