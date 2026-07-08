import json
import os
import uuid
from datetime import datetime


def load_json(file_path, default=None):
    if default is None:
        default = []
    if not os.path.exists(file_path):
        return default if not isinstance(default, dict) else default.copy()
    with open(file_path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_json(file_path, data):
    os.makedirs(os.path.dirname(file_path), exist_ok=True)
    with open(file_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


def now_str():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def new_id(prefix=""):
    uid = str(uuid.uuid4())[:8].upper()
    return f"{prefix}{uid}" if prefix else uid
