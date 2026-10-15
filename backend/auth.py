"""Teacher accounts: password hashing and session tokens."""
import hashlib
import hmac
import secrets

from fastapi import Header, HTTPException

from . import db

ITERATIONS = 200_000


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), ITERATIONS).hex()
    return f"pbkdf2${ITERATIONS}${salt}${digest}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, iterations, salt, digest = stored.split("$")
    except ValueError:
        return False
    check = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), int(iterations)).hex()
    return hmac.compare_digest(check, digest)


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def create_session(user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    with db.get_conn() as c:
        c.execute(
            "INSERT INTO sessions (token_hash, user_id, created_at) VALUES (?, ?, ?)",
            (_token_hash(token), user_id, db.now()),
        )
    return token


def delete_session(token: str):
    with db.get_conn() as c:
        c.execute("DELETE FROM sessions WHERE token_hash = ?", (_token_hash(token),))


def _bearer(authorization: str | None) -> str | None:
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    return None


def current_user(authorization: str | None = Header(None)) -> dict:
    """FastAPI dependency: returns the logged-in teacher or raises 401."""
    token = _bearer(authorization)
    if not token:
        raise HTTPException(401, "auth_required")
    with db.get_conn() as c:
        user = c.one(
            """SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id
               WHERE s.token_hash = ?""",
            (_token_hash(token),),
        )
    if not user:
        raise HTTPException(401, "auth_required")
    user["token"] = token
    return user
