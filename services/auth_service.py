import re
from werkzeug.security import generate_password_hash, check_password_hash
from config import USERS_FILE
from services.data_store import load_json, save_json, now_str
from services.audit_service import log_audit


def get_users():
    return load_json(USERS_FILE, default=[])


def save_users(users):
    save_json(USERS_FILE, users)


def find_user_by_id(user_id):
    users = get_users()
    for u in users:
        if u["user_id"].lower() == user_id.lower():
            return u
    return None


def find_user_by_email(email):
    users = get_users()
    for u in users:
        if u["email"].lower() == email.lower():
            return u
    return None


def validate_password_strength(password):
    if len(password) < 8:
        return False, "Password must be at least 8 characters"
    if not re.search(r"[A-Z]", password):
        return False, "Password must contain at least one uppercase letter"
    if not re.search(r"[a-z]", password):
        return False, "Password must contain at least one lowercase letter"
    if not re.search(r"\d", password):
        return False, "Password must contain at least one number"
    return True, ""


def register_user(full_name, user_id, email, password, role="operator"):
    if find_user_by_id(user_id):
        return False, "User ID already exists"
    if find_user_by_email(email):
        return False, "Email already registered"
    valid, msg = validate_password_strength(password)
    if not valid:
        return False, msg

    users = get_users()
    users.append({
        "user_id": user_id,
        "full_name": full_name,
        "email": email,
        "password_hash": generate_password_hash(password),
        "role": role,
        "status": "active",
        "phone": "",
        "remember_preference": False,
        "last_login": None,
        "created_at": now_str(),
    })
    save_users(users)
    log_audit("User Registration", user_id, role, affected_id=user_id,
              remarks=f"New user registered: {full_name}")
    return True, "Registration successful"


def authenticate(user_id_or_email, password):
    user = find_user_by_id(user_id_or_email)
    if not user:
        user = find_user_by_email(user_id_or_email)
    if not user:
        return None, "Invalid credentials"
    if user.get("status") != "active":
        return None, "Account is deactivated. Contact an administrator."
    if not check_password_hash(user["password_hash"], password):
        return None, "Invalid credentials"
    return user, None


def update_last_login(user_id):
    users = get_users()
    for u in users:
        if u["user_id"] == user_id:
            u["last_login"] = now_str()
            break
    save_users(users)


def change_password(user_id, current_password, new_password):
    user = find_user_by_id(user_id)
    if not user:
        return False, "User not found"
    if not check_password_hash(user["password_hash"], current_password):
        return False, "Current password is incorrect"
    valid, msg = validate_password_strength(new_password)
    if not valid:
        return False, msg

    users = get_users()
    for u in users:
        if u["user_id"] == user_id:
            u["password_hash"] = generate_password_hash(new_password)
            break
    save_users(users)
    log_audit("Password Change", user_id, user["role"], affected_id=user_id)
    return True, "Password changed successfully"


def update_profile(user_id, updates):
    users = get_users()
    user = find_user_by_id(user_id)
    if not user:
        return False, "User not found"
    allowed = ["full_name", "email", "phone"]
    for u in users:
        if u["user_id"] == user_id:
            for key in allowed:
                if key in updates and updates[key]:
                    old = u.get(key)
                    u[key] = updates[key]
                    log_audit("Profile Update", user_id, u["role"],
                              affected_id=user_id, old_value=old, new_value=updates[key])
            break
    save_users(users)
    return True, "Profile updated"


def admin_create_user(data):
    return register_user(
        data["full_name"], data["user_id"], data["email"],
        data.get("password", "TempPass1"), data.get("role", "operator")
    )


def admin_update_user(user_id, updates):
    users = get_users()
    for u in users:
        if u["user_id"] == user_id:
            for key in ["full_name", "email", "role", "status", "phone"]:
                if key in updates:
                    old = u.get(key)
                    u[key] = updates[key]
                    log_audit("Admin Override", "admin", "admin",
                              affected_id=user_id, old_value=old,
                              new_value=updates[key], remarks=f"User {key} changed")
            break
    save_users(users)
    return True, "User updated"


def admin_reset_password(user_id, new_password):
    valid, msg = validate_password_strength(new_password)
    if not valid:
        return False, msg
    users = get_users()
    for u in users:
        if u["user_id"] == user_id:
            u["password_hash"] = generate_password_hash(new_password)
            log_audit("Admin Override", "admin", "admin",
                      affected_id=user_id, remarks="Password reset by admin")
            break
    save_users(users)
    return True, "Password reset successfully"


def admin_delete_user(user_id):
    users = get_users()
    users = [u for u in users if u["user_id"] != user_id]
    save_users(users)
    log_audit("Admin Override", "admin", "admin",
              affected_id=user_id, remarks="User deleted")
    return True, "User deleted"
