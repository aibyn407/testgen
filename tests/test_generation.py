"""AI generation: exact number of each question type, no duplicates, sections for students."""
from backend import ai, main


def mc(i):
    return {"type": "multiple_choice", "question": f"Таңдау сұрағы {i}?", "options": ["a", "b", "c", "d"], "correct": "a"}


def op(i):
    return {"type": "open", "question": f"Жазбаша сұрақ {i}?", "options": None, "correct": f"жауап {i}"}


def mt(i):
    left = [f"T{i}-{k}" for k in range(4)]
    right = [f"D{i}-{k}" for k in range(4)]
    return {"type": "matching", "question": "Сәйкестендіріңіз", "options": {"left": left, "right": right},
            "correct": dict(zip(left, right))}


def test_distribution_table():
    # written questions were dropped; their share now goes to multiple-choice
    assert ai.distribution(10) == {"multiple_choice": 7, "matching": 3}
    assert ai.distribution(15) == {"multiple_choice": 12, "matching": 3}
    assert ai.distribution(20) == {"multiple_choice": 16, "matching": 4}
    assert ai.distribution(25) == {"multiple_choice": 20, "matching": 5}
    assert sum(ai.distribution(12).values()) == 12


def test_open_questions_from_the_model_are_dropped():
    cleaned = ai.clean_questions([op(1), mc(1), mt(1)])
    assert [q["type"] for q in cleaned] == ["multiple_choice", "matching"]


def test_extra_questions_are_trimmed_and_sorted(monkeypatch):
    # model returns too many of every type, mixed order — and a stray written one to be dropped
    batch = [mt(1), op(99), mc(1), mt(2), mc(2), mc(3), mt(3), mc(4), mc(5), mc(6), mc(7), mc(8), mt(4)]
    monkeypatch.setattr(ai, "_ask_model", lambda prompt: batch)
    qs = ai.generate_questions("T", "content", count=10)
    assert [q["type"] for q in qs] == ["multiple_choice"] * 7 + ["matching"] * 3


def test_missing_questions_are_requested_again_and_duplicates_dropped(monkeypatch):
    calls = []

    def fake(prompt):
        calls.append(prompt)
        if len(calls) == 1:  # first answer: duplicates and too few matching questions
            return [mc(1), mc(1), mc(2), mc(3), mc(4), mc(5), mc(6), mc(7), mt(1), mt(1)]
        return [mt(1), mt(2), mt(3)]  # mt(1) is a repeat, must be skipped

    monkeypatch.setattr(ai, "_ask_model", fake)
    qs = ai.generate_questions("T", "content", count=10)
    assert len(calls) == 2
    assert 'ровно 2 вопросов типа "matching"' in calls[1]
    assert [q["type"] for q in qs].count("matching") == 3
    assert len({ai.question_key(q) for q in qs}) == 10


def test_questions_from_other_topics_are_not_repeated(monkeypatch):
    monkeypatch.setattr(ai, "_ask_model", lambda prompt: [mc(1), mc(2), mc(3), mc(4), mt(1)])
    qs = ai.generate_questions("T", "content", count=5, avoid=["Таңдау сұрағы 1?"])
    assert "Таңдау сұрағы 1?" not in [q["question"] for q in qs]


def test_student_gets_sections_in_order_and_fair_share():
    questions = [dict(q, id=i) for i, q in enumerate(
        [mt(i) for i in range(6)] + [mc(i) for i in range(20)])]
    full = main._student_selection(questions, 0, shuffle=True)
    types = [q["type"] for q in full]
    assert types == sorted(types, key=ai.TYPE_ORDER.index)

    part = main._student_selection(questions, 10, shuffle=True)
    assert [q["type"] for q in part] == ["multiple_choice"] * 7 + ["matching"] * 3


def test_short_type_pool_gives_places_to_others():
    # only 2 matching questions available, so multiple-choice fills the rest
    questions = [dict(q, id=i) for i, q in enumerate([mc(i) for i in range(12)] + [mt(0), mt(1)])]
    part = main._student_selection(questions, 10, shuffle=False)
    assert len(part) == 10 and [q["type"] for q in part].count("matching") == 2


def test_prompt_without_material_uses_general_knowledge():
    need = {"multiple_choice": 2, "matching": 1}
    with_text = ai._build_prompt("Тема", "Мәтін " * 50, "kz", need, [])
    topic_only = ai._build_prompt("Қазақ хандығы", "", "kz", need, [])
    assert "МАТЕРИАЛ:" in with_text and "МАТЕРИАЛА НЕТ" not in with_text
    assert "МАТЕРИАЛА НЕТ" in topic_only and "Қазақ хандығы" in topic_only
    # the generator must not ASK for written questions (though it may mention "open" in a negative rule)
    assert 'вопросов типа "open"' not in with_text
