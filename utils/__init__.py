from functools import wraps
from flask import session, redirect, url_for, flash, request, jsonify
from config import EDIT_ROLES, ADMIN_ROLES


def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if "user_id" not in session:
            flash("Please log in to continue.", "warning")
            return redirect(url_for("login", next=request.url))
        return f(*args, **kwargs)
    return decorated


def role_required(roles):
    def decorator(f):
        @wraps(f)
        def decorated(*args, **kwargs):
            if "user_id" not in session:
                flash("Please log in to continue.", "warning")
                return redirect(url_for("login"))
            if session.get("role") not in roles:
                flash("You do not have permission to perform this action.", "danger")
                return redirect(url_for("dashboard"))
            return f(*args, **kwargs)
        return decorated
    return decorator


def edit_required(f):
    return role_required(EDIT_ROLES)(f)


def admin_required(f):
    return role_required(ADMIN_ROLES)(f)


def api_login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if "user_id" not in session:
            return jsonify({"success": False, "message": "Authentication required"}), 401
        return f(*args, **kwargs)
    return decorated


def api_edit_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if "user_id" not in session:
            return jsonify({"success": False, "message": "Authentication required"}), 401
        if session.get("role") not in EDIT_ROLES:
            return jsonify({"success": False, "message": "Insufficient permissions"}), 403
        return f(*args, **kwargs)
    return decorated
