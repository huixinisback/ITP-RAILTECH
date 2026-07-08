from config import AUDIT_FILE
from services.data_store import load_json, save_json, now_str, new_id


def log_audit(action_type, user_id, user_role, affected_id=None,
              old_value=None, new_value=None, remarks=None):
    """Append an audit log entry."""
    logs = load_json(AUDIT_FILE, default=[])
    entry = {
        "log_id": new_id("LOG-"),
        "timestamp": now_str(),
        "user_id": user_id,
        "user_role": user_role,
        "action_type": action_type,
        "affected_id": affected_id,
        "old_value": str(old_value) if old_value is not None else None,
        "new_value": str(new_value) if new_value is not None else None,
        "remarks": remarks,
    }
    logs.insert(0, entry)
    logs = logs[:500]
    save_json(AUDIT_FILE, logs)
    return entry


def get_audit_logs(filters=None):
    """Retrieve audit logs with optional filtering."""
    logs = load_json(AUDIT_FILE, default=[])
    if not filters:
        return logs
    result = logs
    if filters.get("user_id"):
        result = [l for l in result if l.get("user_id") == filters["user_id"]]
    if filters.get("action_type"):
        result = [l for l in result if l.get("action_type") == filters["action_type"]]
    if filters.get("affected_id"):
        result = [l for l in result if l.get("affected_id") == filters["affected_id"]]
    if filters.get("search"):
        q = filters["search"].lower()
        result = [l for l in result if q in str(l).lower()]
    return result
