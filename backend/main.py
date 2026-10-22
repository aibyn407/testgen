import json
import os
import random
import secrets
import tempfile
from pathlib import Path
from datetime import datetime, timedelta, timezone
from typing import Optional
from urllib.parse import quote

from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT = Path(__file__).parent.parent
FRONTEND = ROOT / "frontend"

if (ROOT / ".env").exists():
    for line in (ROOT / ".env").read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())

from . import ai, auth, db, export, parser, scoring  # noqa: E402  (needs .env loaded first)

MAX_UPLOAD_MB = 20
MAX_TEXT_CHARS = 500_000
LOCK_MINUTES = 15  # a student who leaves the test page may retry only after this
QUESTION_TYPES = {"multiple_choice", "open", "matching"}

db.init_db()
app = FastAPI(title="TestGen")


@app.middleware("http")
async def no_stale_frontend(request, call_next):
    # Make browsers revalidate pages/CSS/JS so a new deploy shows up without Ctrl+Shift+R.
    response = await call_next(request)
    if not request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


# ---------- helpers ----------

def _load_question(row: dict) -> dict:
    q = dict(row)
    if q.get("options"):
        try:
            q["options"] = json.loads(q["options"])
        except Exception:
            pass
    if q["type"] == "matching":
        try:
            q["correct"] = json.loads(q["correct"])
        except Exception:
            pass
    return q


def _dump_correct(correct) -> str:
    return correct if isinstance(correct, str) else json.dumps(correct, ensure_ascii=False)


def _dump_options(options) -> Optional[str]:
    return None if options is None else json.dumps(options, ensure_ascii=False)


def _own_test(c: db.Conn, test_id: int, user: dict) -> dict:
    test = c.one("SELECT * FROM tests WHERE id = ? AND owner_id = ?", (test_id, user["id"]))
    if not test:
        raise HTTPException(404, "test_not_found")
    return test


def _test_questions(c: db.Conn, test_id: int) -> list[dict]:
    rows = c.all(
        """SELECT q.*, tp.name AS topic_name FROM questions q JOIN topics tp ON tp.id = q.topic_id
           WHERE tp.test_id = ?
           ORDER BY tp.idx,
                    CASE q.type WHEN 'multiple_choice' THEN 0 WHEN 'open' THEN 1 ELSE 2 END,
                    q.id""",
        (test_id,),
    )
    return [_load_question(r) for r in rows]


def _new_share_code(c: db.Conn) -> str:
    alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
    while True:
        code = "".join(secrets.choice(alphabet) for _ in range(8))
        if not c.one("SELECT id FROM tests WHERE share_code = ?", (code,)):
            return code


def _download(content, filename: str, media_type: str) -> Response:
    return Response(
        content,
        media_type=media_type,
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"},
    )


# ---------- auth ----------

class Credentials(BaseModel):
    username: str = Field(min_length=3, max_length=40)
    password: str = Field(min_length=6, max_length=100)


@app.post("/api/auth/register")
def register(body: Credentials):
    username = body.username.strip().lower()
    with db.get_conn() as c:
        if c.one("SELECT id FROM users WHERE username = ?", (username,)):
            raise HTTPException(400, "username_taken")
        user_id = c.insert(
            "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)",
            (username, auth.hash_password(body.password), db.now()),
        )
    return {"token": auth.create_session(user_id), "username": username}


@app.post("/api/auth/login")
def login(body: Credentials):
    username = body.username.strip().lower()
    with db.get_conn() as c:
        user = c.one("SELECT * FROM users WHERE username = ?", (username,))
    if not user or not auth.verify_password(body.password, user["password_hash"]):
        raise HTTPException(401, "bad_credentials")
    return {"token": auth.create_session(user["id"]), "username": username}


@app.get("/api/auth/me")
def me(user: dict = Depends(auth.current_user)):
    return {"username": user["username"]}


@app.post("/api/auth/logout")
def logout(user: dict = Depends(auth.current_user)):
    auth.delete_session(user["token"])
    return {"ok": True}


# ---------- teacher: tests ----------

@app.post("/api/upload")
async def upload(
    file: Optional[UploadFile] = File(None),
    text: Optional[str] = Form(None),  # pasted text instead of a file
    topic: Optional[str] = Form(None),  # only topic names (one per line): AI writes from general knowledge
    language: str = Form("kz"),
    title: Optional[str] = Form(None),
    user: dict = Depends(auth.current_user),
):
    if file is not None and file.filename:
        suffix = Path(file.filename).suffix.lower()
        if suffix not in (".docx", ".pdf", ".txt", ".md"):
            raise HTTPException(400, "bad_file_type")
        data = await file.read()
        if len(data) > MAX_UPLOAD_MB * 1024 * 1024:
            raise HTTPException(400, "file_too_large")

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / f"upload{suffix}"
            path.write_bytes(data)
            try:
                text = parser.extract_text(path)
            except Exception:
                raise HTTPException(400, "cannot_read_file")
        filename = file.filename
        default_title = Path(file.filename).stem
    elif topic is not None:
        names = [ln.strip()[:200] for ln in topic.splitlines() if ln.strip()][:20]
        if not names or len(names[0]) < 3:
            raise HTTPException(400, "topic_too_short")
        display_title = (title or "").strip() or names[0]
        lang = language if language in ("kz", "ru", "en") else "kz"
        with db.get_conn() as c:
            test_id = c.insert(
                """INSERT INTO tests (owner_id, title, filename, source_text, language, share_code, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (user["id"], display_title[:200], None, "", lang, _new_share_code(c), db.now()),
            )
            for i, name in enumerate(names):
                c.execute("INSERT INTO topics (test_id, name, idx, content) VALUES (?, ?, ?, ?)",
                          (test_id, name, i, ""))
        return {"test_id": test_id, "title": display_title, "topics_count": len(names)}
    elif text is not None:
        if len(text) > MAX_TEXT_CHARS:
            raise HTTPException(400, "text_too_long")
        text = text.replace("\r\n", "\n")
        filename = None
        first_line = next((ln.strip() for ln in text.splitlines() if ln.strip()), "")
        default_title = first_line[:80]
    else:
        raise HTTPException(400, "no_input")

    if len(text.strip()) < 200:
        raise HTTPException(400, "too_little_text")

    topics = parser.split_topics(text)
    display_title = (title or "").strip() or default_title
    lang = language if language in ("kz", "ru", "en") else "kz"

    with db.get_conn() as c:
        test_id = c.insert(
            """INSERT INTO tests (owner_id, title, filename, source_text, language, share_code, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (user["id"], display_title[:200], filename, text, lang, _new_share_code(c), db.now()),
        )
        for i, t in enumerate(topics):
            c.execute(
                "INSERT INTO topics (test_id, name, idx, content) VALUES (?, ?, ?, ?)",
                (test_id, t["name"], i, t["content"]),
            )

    return {"test_id": test_id, "title": display_title, "topics_count": len(topics)}


@app.get("/api/tests")
def list_tests(user: dict = Depends(auth.current_user)):
    with db.get_conn() as c:
        return c.all(
            """SELECT t.id, t.title, t.language, t.created_at, t.is_open, t.share_code,
                      (SELECT COUNT(*) FROM questions q JOIN topics tp ON tp.id = q.topic_id
                        WHERE tp.test_id = t.id) AS questions_count,
                      (SELECT COUNT(*) FROM attempts WHERE test_id = t.id) AS attempts_count
               FROM tests t WHERE t.owner_id = ? ORDER BY t.id DESC""",
            (user["id"],),
        )


@app.get("/api/tests/{test_id}")
def get_test(test_id: int, user: dict = Depends(auth.current_user)):
    with db.get_conn() as c:
        test = _own_test(c, test_id, user)
        topics = c.all(
            """SELECT tp.id, tp.name, tp.idx,
                      (SELECT COUNT(*) FROM questions WHERE topic_id = tp.id) AS questions_count
               FROM topics tp WHERE tp.test_id = ? ORDER BY tp.idx""",
            (test_id,),
        )
        questions = _test_questions(c, test_id)
    test.pop("source_text", None)
    return {"test": test, "topics": topics, "questions": questions}


class TestSettings(BaseModel):
    title: Optional[str] = Field(None, min_length=1, max_length=200)
    is_open: Optional[bool] = None
    time_limit: Optional[int] = Field(None, ge=0, le=600)
    question_limit: Optional[int] = Field(None, ge=0, le=500)
    shuffle: Optional[bool] = None
    show_answers: Optional[bool] = None
    anti_cheat: Optional[bool] = None
    question_time: Optional[int] = Field(None, ge=0, le=600)


@app.patch("/api/tests/{test_id}")
def update_test(test_id: int, body: TestSettings, user: dict = Depends(auth.current_user)):
    changes = body.model_dump(exclude_none=True)
    with db.get_conn() as c:
        _own_test(c, test_id, user)
        for key, value in changes.items():  # keys come from the pydantic model, not the user
            c.execute(f"UPDATE tests SET {key} = ? WHERE id = ?",
                      (int(value) if isinstance(value, bool) else value, test_id))
    return {"ok": True}


@app.delete("/api/tests/{test_id}")
def delete_test(test_id: int, user: dict = Depends(auth.current_user)):
    with db.get_conn() as c:
        _own_test(c, test_id, user)
        c.execute("DELETE FROM tests WHERE id = ?", (test_id,))
    return {"ok": True}


# ---------- teacher: questions ----------

class GenerateReq(BaseModel):
    count: int = Field(15, ge=3, le=30)


@app.post("/api/topics/{topic_id}/generate")
def generate_for_topic(topic_id: int, body: GenerateReq, user: dict = Depends(auth.current_user)):
    with db.get_conn() as c:
        topic = c.one("SELECT * FROM topics WHERE id = ?", (topic_id,))
        if not topic:
            raise HTTPException(404, "topic_not_found")
        test = _own_test(c, topic["test_id"], user)
        others = [r["question"] for r in c.all(
            """SELECT q.question FROM questions q JOIN topics tp ON tp.id = q.topic_id
               WHERE tp.test_id = ? AND q.topic_id <> ? AND q.type <> 'matching'""",
            (test["id"], topic_id),
        )]

    content = topic.get("content") or test["source_text"][:8000]
    try:
        questions = ai.generate_questions(topic["name"], content, lang=test["language"], count=body.count,
                                          avoid=others)
    except Exception as e:
        raise HTTPException(502, f"ai_error: {e}")
    if not questions:
        raise HTTPException(502, "ai_empty")

    with db.get_conn() as c:
        c.execute("DELETE FROM questions WHERE topic_id = ?", (topic_id,))
        for q in questions:
            c.execute(
                "INSERT INTO questions (topic_id, type, question, options, correct) VALUES (?, ?, ?, ?, ?)",
                (topic_id, q["type"], q["question"], _dump_options(q["options"]), _dump_correct(q["correct"])),
            )
    return {"generated": len(questions)}


class QuestionEdit(BaseModel):
    type: str
    question: str = Field(min_length=1, max_length=2000)
    options: Optional[object] = None
    correct: object


def _owned_question(c: db.Conn, question_id: int, user: dict) -> dict:
    q = c.one(
        """SELECT q.* FROM questions q JOIN topics tp ON tp.id = q.topic_id
           JOIN tests t ON t.id = tp.test_id WHERE q.id = ? AND t.owner_id = ?""",
        (question_id, user["id"]),
    )
    if not q:
        raise HTTPException(404, "question_not_found")
    return q


@app.put("/api/questions/{question_id}")
def edit_question(question_id: int, body: QuestionEdit, user: dict = Depends(auth.current_user)):
    cleaned = ai.clean_questions([body.model_dump()])
    if not cleaned:
        raise HTTPException(400, "invalid_question")
    q = cleaned[0]
    with db.get_conn() as c:
        _owned_question(c, question_id, user)
        c.execute(
            "UPDATE questions SET type = ?, question = ?, options = ?, correct = ? WHERE id = ?",
            (q["type"], q["question"], _dump_options(q["options"]), _dump_correct(q["correct"]), question_id),
        )
    return {"ok": True}


@app.delete("/api/questions/{question_id}")
def delete_question(question_id: int, user: dict = Depends(auth.current_user)):
    with db.get_conn() as c:
        _owned_question(c, question_id, user)
        c.execute("DELETE FROM questions WHERE id = ?", (question_id,))
    return {"ok": True}


# ---------- teacher: results ----------

@app.get("/api/tests/{test_id}/results")
def results(test_id: int, user: dict = Depends(auth.current_user)):
    with db.get_conn() as c:
        _own_test(c, test_id, user)
        attempts = c.all("SELECT * FROM attempts WHERE test_id = ? ORDER BY id DESC", (test_id,))

    per_question: dict[int, dict] = {}
    for a in attempts:
        for d in json.loads(a.pop("details") or "[]"):
            s = per_question.setdefault(d["id"], {"id": d["id"], "question": d["question"], "points": 0, "n": 0})
            s["points"] += d["points"]
            s["n"] += 1
    question_stats = sorted(
        ({"id": s["id"], "question": s["question"], "percent": round(s["points"] / s["n"] * 100)}
         for s in per_question.values()),
        key=lambda s: s["percent"],
    )
    for a in attempts:
        a["grade_info"] = scoring.grade(a["percent"])
    return {"attempts": attempts, "question_stats": question_stats}


@app.get("/api/attempts/{attempt_id}")
def get_attempt(attempt_id: int, user: dict = Depends(auth.current_user)):
    with db.get_conn() as c:
        a = c.one(
            """SELECT a.* FROM attempts a JOIN tests t ON t.id = a.test_id
               WHERE a.id = ? AND t.owner_id = ?""",
            (attempt_id, user["id"]),
        )
    if not a:
        raise HTTPException(404, "attempt_not_found")
    a["details"] = json.loads(a["details"] or "[]")
    a["grade_info"] = scoring.grade(a["percent"])
    return a


@app.delete("/api/attempts/{attempt_id}")
def delete_attempt(attempt_id: int, user: dict = Depends(auth.current_user)):
    with db.get_conn() as c:
        a = c.one(
            "SELECT a.id FROM attempts a JOIN tests t ON t.id = a.test_id WHERE a.id = ? AND t.owner_id = ?",
            (attempt_id, user["id"]),
        )
        if not a:
            raise HTTPException(404, "attempt_not_found")
        c.execute("DELETE FROM attempts WHERE id = ?", (attempt_id,))
    return {"ok": True}


@app.get("/api/tests/{test_id}/export/{kind}")
def export_test(test_id: int, kind: str, user: dict = Depends(auth.current_user)):
    with db.get_conn() as c:
        test = _own_test(c, test_id, user)
        questions = _test_questions(c, test_id)
        attempts = c.all("SELECT * FROM attempts WHERE test_id = ? ORDER BY student_group, student_name",
                         (test_id,)) if kind == "results" else []
    name = test["title"]
    if kind == "moodle":
        return _download(export.moodle_xml(name, questions), f"{name} - Moodle.xml", "application/xml")
    if kind == "platonus":
        return _download(export.platonus_txt(questions), f"{name} - Platonus.txt", "text/plain; charset=utf-8")
    if kind == "results":
        return _download(
            export.results_xlsx(name, attempts), f"{name} - нәтижелер.xlsx",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
    raise HTTPException(404, "unknown_export")


# ---------- students (public, by share link) ----------

def _public_test(c: db.Conn, code: str) -> dict:
    test = c.one("SELECT * FROM tests WHERE share_code = ?", (code,))
    if not test:
        raise HTTPException(404, "test_not_found")
    return test


def _student_selection(questions: list[dict], limit: int, shuffle: bool) -> list[dict]:
    """Questions for one student: grouped by type (choice, written, matching).

    With a limit, each type keeps its share (e.g. 10 of 30 -> 4 choice, 3 written, 3 matching).
    """
    pools = {t: [q for q in questions if q["type"] == t] for t in ai.TYPE_ORDER}
    if shuffle:
        for pool in pools.values():
            random.shuffle(pool)
    if limit and limit < len(questions):
        plan = ai.distribution(limit)
        chosen = {t: pools[t][: plan[t]] for t in ai.TYPE_ORDER}
        # a type with too few questions gives its places to the others
        spare = limit - sum(len(v) for v in chosen.values())
        for t in ai.TYPE_ORDER:
            extra = pools[t][len(chosen[t]): len(chosen[t]) + spare]
            chosen[t] += extra
            spare -= len(extra)
        pools = chosen
    return [q for t in ai.TYPE_ORDER for q in pools[t]]


@app.get("/api/public/{code}")
def public_test(code: str):
    with db.get_conn() as c:
        test = _public_test(c, code)
        questions = _test_questions(c, test["id"]) if test["is_open"] else []

    questions = _student_selection(questions, test["question_limit"], bool(test["shuffle"]))

    public = []
    for q in questions:
        options = q["options"]
        if q["type"] == "multiple_choice" and test["shuffle"]:
            options = random.sample(options, len(options))
        if q["type"] == "matching":
            options = {"left": options["left"], "right": random.sample(options["right"], len(options["right"]))}
        public.append({"id": q["id"], "type": q["type"], "question": q["question"], "options": options})

    return {
        "title": test["title"],
        "language": test["language"],
        "is_open": bool(test["is_open"]),
        "time_limit": test["time_limit"],
        "question_time": test["question_time"],
        "anti_cheat": bool(test["anti_cheat"]),
        "lock_minutes": LOCK_MINUTES,
        "questions": public,
    }


def _same_student(a: str, b: str) -> bool:
    return " ".join(a.lower().split()) == " ".join(b.lower().split())


def _locked_seconds(c, test_id: int, name: str, group: str) -> int:
    """Seconds left until this student may take the test again after leaving the page."""
    since = datetime.now(timezone.utc) - timedelta(minutes=LOCK_MINUTES)
    rows = c.all(
        "SELECT student_name, student_group, taken_at FROM attempts WHERE test_id = ? AND violation = 1 AND taken_at > ?",
        (test_id, since.isoformat(timespec="seconds")),
    )
    left = 0
    for r in rows:
        if _same_student(r["student_name"], name) and _same_student(r["student_group"] or "", group):
            until = datetime.fromisoformat(r["taken_at"]) + timedelta(minutes=LOCK_MINUTES)
            left = max(left, int((until - datetime.now(timezone.utc)).total_seconds()))
    return left


class LockReq(BaseModel):
    student_name: str = Field(min_length=2, max_length=80)
    student_group: str = Field("", max_length=40)


@app.post("/api/public/{code}/lock")
def lock_status(code: str, body: LockReq):
    with db.get_conn() as c:
        test = _public_test(c, code)
        return {"locked_seconds": _locked_seconds(c, test["id"], body.student_name, body.student_group)}


class SubmitReq(BaseModel):
    student_name: str = Field(min_length=2, max_length=80)
    student_group: str = Field("", max_length=40)
    answers: dict  # {question_id: answer}
    duration_sec: Optional[int] = Field(None, ge=0)
    violation: bool = False  # the student left the test page: recorded as 0 points


@app.post("/api/public/{code}/submit")
def submit(code: str, body: SubmitReq):
    with db.get_conn() as c:
        test = _public_test(c, code)
        if not test["is_open"]:
            raise HTTPException(403, "test_closed")
        questions = _test_questions(c, test["id"])
        if _locked_seconds(c, test["id"], body.student_name, body.student_group) > 0:
            raise HTTPException(423, "locked")

    if test["question_limit"] and test["question_limit"] < len(questions):
        # Only the questions this student was given count; the total stays fixed so
        # skipping questions cannot raise the percentage.
        total = test["question_limit"]
        questions = [q for q in questions if str(q["id"]) in body.answers][:total]
    else:
        total = len(questions)
    if total == 0:
        raise HTTPException(400, "no_questions")

    score = 0.0
    details = []
    for q in questions:
        user_ans = body.answers.get(str(q["id"]))
        points = scoring.check_answer(q, user_ans)
        score += points
        details.append({
            "id": q["id"], "type": q["type"], "question": q["question"],
            "user": user_ans, "correct": q["correct"], "points": points,
        })

    if body.violation:
        score, details = 0, []
    score = round(score, 2)
    percent = round(score / total * 100, 1)
    g = scoring.grade(percent)
    with db.get_conn() as c:
        c.insert(
            """INSERT INTO attempts (test_id, student_name, student_group, score, total, percent, grade,
                                     details, duration_sec, violation, taken_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (test["id"], body.student_name.strip(), body.student_group.strip(), score, total, percent,
             g["letter"], json.dumps(details, ensure_ascii=False), body.duration_sec, int(body.violation),
             db.now()),
        )

    return {
        "score": score, "total": total, "percent": percent, "grade": g,
        "details": details if test["show_answers"] else None,
    }


# ---------- pages ----------

@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/t/{code}")
def take_page(code: str):
    return FileResponse(FRONTEND / "take.html")


app.mount("/", StaticFiles(directory=str(FRONTEND), html=True), name="frontend")
