from conftest import FAKE_QUESTIONS, LECTURE_TEXT


def test_register_login_and_wrong_password(client):
    assert client.post("/api/auth/register", json={"username": "Mugalim1", "password": "secret123"}).status_code == 200
    assert client.post("/api/auth/register", json={"username": "mugalim1", "password": "secret123"}).status_code == 400
    assert client.post("/api/auth/login", json={"username": "mugalim1", "password": "wrong-pass"}).status_code == 401
    r = client.post("/api/auth/login", json={"username": "MUGALIM1", "password": "secret123"})
    assert r.status_code == 200
    me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {r.json()['token']}"})
    assert me.json()["username"] == "mugalim1"


def test_teacher_endpoints_require_login(client):
    assert client.get("/api/tests").status_code == 401
    assert client.get("/api/tests", headers={"Authorization": "Bearer nope"}).status_code == 401


def test_teachers_cannot_see_each_others_tests(client, teacher, ready_test):
    test_id, _ = ready_test
    other = client.post("/api/auth/register", json={"username": "other_teacher", "password": "secret123"})
    other_h = {"Authorization": f"Bearer {other.json()['token']}"}
    assert client.get("/api/tests", headers=other_h).json() == []
    assert client.get(f"/api/tests/{test_id}", headers=other_h).status_code == 404
    assert client.delete(f"/api/tests/{test_id}", headers=other_h).status_code == 404


def test_upload_rejects_bad_file(client, teacher):
    r = client.post("/api/upload", headers=teacher, files={"file": ("x.exe", b"MZ", "application/octet-stream")})
    assert r.status_code == 400


def test_student_sees_questions_without_answers(client, ready_test):
    _, code = ready_test
    data = client.get(f"/api/public/{code}").json()
    assert data["title"] == "Киберқауіпсіздік"
    assert len(data["questions"]) == 2 * len(FAKE_QUESTIONS)
    assert all("correct" not in q for q in data["questions"])


def test_full_flow_all_correct_gets_A(client, teacher, ready_test):
    test_id, code = ready_test
    questions = client.get(f"/api/tests/{test_id}", headers=teacher).json()["questions"]
    answers = {str(q["id"]): q["correct"] for q in questions}
    r = client.post(f"/api/public/{code}/submit",
                    json={"student_name": "Асан Асанов", "student_group": "ТИИ 24-11", "answers": answers})
    assert r.status_code == 200
    body = r.json()
    assert body["percent"] == 100 and body["grade"]["letter"] == "A"

    res = client.get(f"/api/tests/{test_id}/results", headers=teacher).json()
    assert res["attempts"][0]["student_name"] == "Асан Асанов"
    assert res["attempts"][0]["grade"] == "A"


def test_empty_answers_get_F(client, ready_test):
    _, code = ready_test
    r = client.post(f"/api/public/{code}/submit", json={"student_name": "Бос", "answers": {}})
    assert r.json()["percent"] == 0 and r.json()["grade"]["letter"] == "F"


def test_question_limit_keeps_total_fixed(client, teacher, ready_test):
    test_id, code = ready_test
    client.patch(f"/api/tests/{test_id}", headers=teacher, json={"question_limit": 4})
    served = client.get(f"/api/public/{code}").json()["questions"]
    assert len(served) == 4
    # student answers only one question correctly and skips the rest
    q = next(q for q in client.get(f"/api/tests/{test_id}", headers=teacher).json()["questions"]
             if q["id"] == served[0]["id"])
    r = client.post(f"/api/public/{code}/submit",
                    json={"student_name": "Бекзат", "answers": {str(q["id"]): q["correct"]}}).json()
    assert r["total"] == 4 and r["score"] == 1


def test_closed_test_rejects_students(client, teacher, ready_test):
    test_id, code = ready_test
    client.patch(f"/api/tests/{test_id}", headers=teacher, json={"is_open": False})
    assert client.get(f"/api/public/{code}").json()["questions"] == []
    assert client.post(f"/api/public/{code}/submit", json={"student_name": "Кеш", "answers": {}}).status_code == 403


def test_hide_answers_setting(client, teacher, ready_test):
    test_id, code = ready_test
    client.patch(f"/api/tests/{test_id}", headers=teacher, json={"show_answers": False})
    r = client.post(f"/api/public/{code}/submit", json={"student_name": "Дана", "answers": {}})
    assert r.json()["details"] is None


def test_edit_and_delete_question(client, teacher, ready_test):
    test_id, _ = ready_test
    q = client.get(f"/api/tests/{test_id}", headers=teacher).json()["questions"][0]
    edited = {**q, "question": "Жаңа мәтін"}
    assert client.put(f"/api/questions/{q['id']}", headers=teacher, json=edited).status_code == 200
    broken = {**q, "correct": "мүлдем басқа"} if q["type"] == "multiple_choice" else {**q, "type": "bad"}
    assert client.put(f"/api/questions/{q['id']}", headers=teacher, json=broken).status_code == 400
    assert client.delete(f"/api/questions/{q['id']}", headers=teacher).status_code == 200
    left = client.get(f"/api/tests/{test_id}", headers=teacher).json()["questions"]
    assert q["id"] not in [x["id"] for x in left]


def test_exports(client, teacher, ready_test):
    test_id, code = ready_test
    client.post(f"/api/public/{code}/submit", json={"student_name": "Айгүл", "student_group": "ИС-24", "answers": {}})

    moodle = client.get(f"/api/tests/{test_id}/export/moodle", headers=teacher)
    assert moodle.status_code == 200
    assert '<question type="multichoice">' in moodle.text and '<question type="matching">' in moodle.text

    platonus = client.get(f"/api/tests/{test_id}/export/platonus", headers=teacher).text
    first = platonus.split("\n\n")[0].splitlines()
    assert first[0].startswith("<question>") and first[1] == "<variant>Құпиялылық үшін"

    xlsx = client.get(f"/api/tests/{test_id}/export/results", headers=teacher)
    assert xlsx.status_code == 200 and xlsx.content[:2] == b"PK"


def test_share_page_is_served(client, ready_test):
    _, code = ready_test
    r = client.get(f"/t/{code}")
    assert r.status_code == 200 and "<html" in r.text.lower()


def test_leaving_the_page_gives_zero_and_locks_student(client, teacher, ready_test):
    test_id, code = ready_test
    data = client.get(f"/api/public/{code}").json()
    assert data["anti_cheat"] is True and data["question_time"] == 40

    questions = client.get(f"/api/tests/{test_id}", headers=teacher).json()["questions"]
    answers = {str(q["id"]): q["correct"] for q in questions}
    student = {"student_name": "Ерлан Серік", "student_group": "ТИИ 24-11"}
    r = client.post(f"/api/public/{code}/submit", json={**student, "answers": answers, "violation": True})
    assert r.status_code == 200 and r.json()["score"] == 0 and r.json()["grade"]["letter"] == "F"

    # same student (name typed differently) is locked; another student is not
    lock = client.post(f"/api/public/{code}/lock", json={"student_name": "  ерлан  СЕРІК", "student_group": "тии 24-11"})
    assert 0 < lock.json()["locked_seconds"] <= 15 * 60
    assert client.post(f"/api/public/{code}/submit", json={**student, "answers": answers}).status_code == 423
    other = client.post(f"/api/public/{code}/lock", json={"student_name": "Басқа студент"})
    assert other.json()["locked_seconds"] == 0

    res = client.get(f"/api/tests/{test_id}/results", headers=teacher).json()
    assert res["attempts"][0]["violation"] == 1


def test_anti_cheat_and_question_time_settings(client, teacher, ready_test):
    test_id, code = ready_test
    client.patch(f"/api/tests/{test_id}", headers=teacher, json={"anti_cheat": False, "question_time": 0})
    data = client.get(f"/api/public/{code}").json()
    assert data["anti_cheat"] is False and data["question_time"] == 0


def test_create_test_from_pasted_text(client, teacher):
    r = client.post("/api/upload", headers=teacher, data={"text": LECTURE_TEXT, "language": "kz"})
    assert r.status_code == 200, r.text
    detail = client.get(f"/api/tests/{r.json()['test_id']}", headers=teacher).json()
    assert detail["topics"] and detail["test"]["filename"] is None
    assert detail["test"]["title"] == LECTURE_TEXT.strip().splitlines()[0].strip()[:80]

    assert client.post("/api/upload", headers=teacher, data={"text": "тым қысқа"}).json()["detail"] == "too_little_text"
    assert client.post("/api/upload", headers=teacher, data={"language": "kz"}).json()["detail"] == "no_input"


def test_create_test_from_topic_only(client, teacher):
    r = client.post("/api/upload", headers=teacher,
                    data={"topic": "Қазақ хандығы\n\nАбылай хан (9-сынып)", "language": "kz"})
    assert r.status_code == 200, r.text
    test_id = r.json()["test_id"]
    detail = client.get(f"/api/tests/{test_id}", headers=teacher).json()
    assert detail["test"]["title"] == "Қазақ хандығы"
    assert [t["name"] for t in detail["topics"]] == ["Қазақ хандығы", "Абылай хан (9-сынып)"]
    gen = client.post(f"/api/topics/{detail['topics'][0]['id']}/generate", headers=teacher, json={"count": 3})
    assert gen.status_code == 200

    assert client.post("/api/upload", headers=teacher, data={"topic": "  "}).json()["detail"] == "topic_too_short"
