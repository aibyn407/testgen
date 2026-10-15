"""Database layer.

Locally the app uses SQLite (data/testgen.db). In production set DATABASE_URL
to a PostgreSQL URL (e.g. a free Neon / Supabase database) so data survives
restarts of the free hosting instance.
"""
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

DB_PATH = Path(os.getenv("SQLITE_PATH", Path(__file__).parent.parent / "data" / "testgen.db"))


def database_url() -> str:
    return os.getenv("DATABASE_URL", "").strip()


def is_pg() -> bool:
    return database_url().startswith(("postgres://", "postgresql://"))


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id {pk},
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tests (
    id {pk},
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    filename TEXT,
    source_text TEXT,
    language TEXT NOT NULL DEFAULT 'kz',
    share_code TEXT NOT NULL UNIQUE,
    is_open INTEGER NOT NULL DEFAULT 1,
    time_limit INTEGER NOT NULL DEFAULT 0,
    question_limit INTEGER NOT NULL DEFAULT 0,
    shuffle INTEGER NOT NULL DEFAULT 1,
    show_answers INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS topics (
    id {pk},
    test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    idx INTEGER NOT NULL,
    content TEXT
);

CREATE TABLE IF NOT EXISTS questions (
    id {pk},
    topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    question TEXT NOT NULL,
    options TEXT,
    correct TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attempts (
    id {pk},
    test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
    student_name TEXT NOT NULL,
    student_group TEXT,
    score {real} NOT NULL,
    total INTEGER NOT NULL,
    percent {real} NOT NULL,
    grade TEXT NOT NULL,
    details TEXT,
    duration_sec INTEGER,
    taken_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tests_owner ON tests(owner_id);
CREATE INDEX IF NOT EXISTS idx_topics_test ON topics(test_id);
CREATE INDEX IF NOT EXISTS idx_questions_topic ON questions(topic_id);
CREATE INDEX IF NOT EXISTS idx_attempts_test ON attempts(test_id);
"""


class Conn:
    """Thin wrapper so the same SQL (with ? placeholders) runs on SQLite and PostgreSQL."""

    def __init__(self, raw, pg: bool):
        self.raw = raw
        self.pg = pg

    def _sql(self, sql: str) -> str:
        return sql.replace("?", "%s") if self.pg else sql

    def execute(self, sql: str, params=()):
        return self.raw.execute(self._sql(sql), params)

    def all(self, sql: str, params=()) -> list[dict]:
        return [dict(r) for r in self.execute(sql, params).fetchall()]

    def one(self, sql: str, params=()) -> dict | None:
        row = self.execute(sql, params).fetchone()
        return dict(row) if row else None

    def insert(self, sql: str, params=()) -> int:
        if self.pg:
            return self.execute(sql + " RETURNING id", params).fetchone()["id"]
        return self.execute(sql, params).lastrowid


@contextmanager
def get_conn():
    if is_pg():
        import psycopg
        from psycopg.rows import dict_row

        raw = psycopg.connect(database_url(), row_factory=dict_row)
        try:
            yield Conn(raw, True)
            raw.commit()
        finally:
            raw.close()
    else:
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        raw = sqlite3.connect(DB_PATH, timeout=15)
        raw.row_factory = sqlite3.Row
        raw.execute("PRAGMA foreign_keys = ON")
        raw.execute("PRAGMA journal_mode = WAL")
        try:
            yield Conn(raw, False)
            raw.commit()
        finally:
            raw.close()


def init_db():
    pk = "SERIAL PRIMARY KEY" if is_pg() else "INTEGER PRIMARY KEY AUTOINCREMENT"
    real = "DOUBLE PRECISION" if is_pg() else "REAL"
    statements = [s.strip() for s in SCHEMA.format(pk=pk, real=real).split(";") if s.strip()]
    with get_conn() as c:
        for stmt in statements:
            c.execute(stmt)
