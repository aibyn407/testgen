import os
import sys
import tempfile
from pathlib import Path

import pytest

# Use a throwaway SQLite database for every test run.
_tmp = tempfile.mkdtemp()
os.environ["SQLITE_PATH"] = str(Path(_tmp) / "test.db")
os.environ.pop("DATABASE_URL", None)
sys.path.insert(0, str(Path(__file__).parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

from backend import ai, main  # noqa: E402

FAKE_QUESTIONS = [
    {"type": "multiple_choice", "question": "Ақпаратты шифрлау не үшін қажет?",
     "options": ["Құпиялылық үшін", "Жылдамдық үшін", "Безендіру үшін", "Басып шығару үшін"],
     "correct": "Құпиялылық үшін"},
    {"type": "open", "question": "Зиянды бағдарламаның бір түрі?", "options": None, "correct": "троян"},
    {"type": "matching", "question": "Сәйкестендіріңіз",
     "options": {"left": ["DoS", "Фишинг"], "right": ["Қызметтен бас тарту", "Алдау хаты"]},
     "correct": {"DoS": "Қызметтен бас тарту", "Фишинг": "Алдау хаты"}},
]

LECTURE_TEXT = "\n".join(
    f"Дәріс №{i}. Киберқауіпсіздік негіздері {i}\n" + ("Ақпараттық қауіпсіздік туралы мәтін. " * 20)
    for i in (1, 2)
)


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setattr(ai, "generate_questions", lambda *a, **k: ai.clean_questions(FAKE_QUESTIONS))
    return TestClient(main.app)


@pytest.fixture()
def teacher(client):
    import uuid
    r = client.post("/api/auth/register", json={"username": f"t_{uuid.uuid4().hex[:8]}", "password": "secret123"})
    assert r.status_code == 200
    return {"Authorization": f"Bearer {r.json()['token']}"}


@pytest.fixture()
def ready_test(client, teacher):
    """A test with generated questions; returns (test_id, share_code)."""
    r = client.post("/api/upload", headers=teacher,
                    files={"file": ("lectures.txt", LECTURE_TEXT.encode(), "text/plain")},
                    data={"language": "kz", "title": "Киберқауіпсіздік"})
    assert r.status_code == 200, r.text
    test_id = r.json()["test_id"]
    detail = client.get(f"/api/tests/{test_id}", headers=teacher).json()
    for tp in detail["topics"]:
        assert client.post(f"/api/topics/{tp['id']}/generate", headers=teacher, json={"count": 3}).status_code == 200
    return test_id, detail["test"]["share_code"]
