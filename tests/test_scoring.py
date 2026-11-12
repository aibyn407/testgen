from backend import ai, parser, scoring


def test_multiple_choice():
    q = {"type": "multiple_choice", "correct": "Құпиялылық үшін"}
    assert scoring.check_answer(q, "құпиялылық үшін") == 1
    assert scoring.check_answer(q, "Жылдамдық үшін") == 0
    assert scoring.check_answer(q, "") == 0


def test_open_answer_tolerates_small_differences():
    q = {"type": "open", "correct": "Троян"}
    assert scoring.check_answer(q, " троян. ") == 1
    assert scoring.check_answer(q, "трояндар") == 1
    assert scoring.check_answer(q, "вирус") == 0
    assert scoring.check_answer(q, None) == 0


def test_matching_gives_partial_credit():
    q = {"type": "matching", "correct": '{"A": "1", "B": "2", "C": "3", "D": "4"}'}
    assert scoring.check_answer(q, {"A": "1", "B": "2", "C": "3", "D": "4"}) == 1
    assert scoring.check_answer(q, {"A": "1", "B": "2", "C": "4", "D": "3"}) == 0.5
    assert scoring.check_answer(q, "not a dict") == 0


def test_grade_scale():
    assert scoring.grade(100)["letter"] == "A"
    assert scoring.grade(94.9)["letter"] == "A-"
    assert scoring.grade(80)["letter"] == "B"
    assert scoring.grade(50)["letter"] == "D"
    assert scoring.grade(49.9)["letter"] == "F"
    assert scoring.grade(0)["gpa"] == 0


def test_clean_questions_drops_broken_ones():
    raw = [
        {"type": "multiple_choice", "question": "Q", "options": ["a", "b"], "correct": "c"},  # correct not in options
        {"type": "matching", "question": "Q", "options": {"left": ["x"], "right": ["y"]}, "correct": {"z": "y"}},
        {"type": "essay", "question": "Q", "correct": "x"},
        {"type": "open", "question": "Q", "options": None, "correct": "ok"},  # written questions were dropped
        {"type": "multiple_choice", "question": "Q2", "options": ["a", "b"], "correct": "a"},
    ]
    cleaned = ai.clean_questions(raw)
    assert len(cleaned) == 1 and cleaned[0]["type"] == "multiple_choice"


def test_split_topics_by_lectures():
    text = "\n".join(f"ДӘРІС №{i}. Тақырып {i}\n" + "мәтін " * 50 for i in (1, 2, 3))
    topics = parser.split_topics(text)
    assert [t["name"] for t in topics] == ["№1. Тақырып 1", "№2. Тақырып 2", "№3. Тақырып 3"]


def test_suspicion_score():
    assert scoring.suspicion([]) == 0
    assert scoring.suspicion([{"type": "look_away", "at": 5, "dur": 0}]) == 8
    assert scoring.suspicion([{"type": "phone", "at": 5, "dur": 30}]) == 60  # long episode counts double
    assert scoring.suspicion([{"type": "phone", "dur": 30}] * 5) == 100
