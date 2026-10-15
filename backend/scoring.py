import json
import re


def _norm(s) -> str:
    s = str(s if s is not None else "").lower().strip()
    s = s.replace("ё", "е")
    s = re.sub(r"[\s\.,;:!?\"'`«»\-–—()\[\]]+", " ", s)
    return s.strip()


def _parse(value):
    if isinstance(value, str):
        try:
            return json.loads(value)
        except Exception:
            return value
    return value


def check_answer(q: dict, user_answer) -> float:
    """Returns points for one question, from 0 to 1.

    Matching questions give partial credit: each correct pair counts.
    """
    qt = q["type"]
    correct = _parse(q["correct"])

    if qt == "multiple_choice":
        return 1.0 if user_answer and _norm(user_answer) == _norm(correct) else 0.0

    if qt == "open":
        ua, ca = _norm(user_answer), _norm(correct)
        if not ua:
            return 0.0
        if ua == ca:
            return 1.0
        # accept small differences, e.g. "шифрлау" vs "шифрлау әдісі"
        if ua in ca or ca in ua:
            if min(len(ua), len(ca)) / max(len(ua), len(ca)) > 0.6:
                return 1.0
        return 0.0

    if qt == "matching":
        if not isinstance(user_answer, dict) or not isinstance(correct, dict) or not correct:
            return 0.0
        hits = sum(1 for k, v in correct.items() if _norm(user_answer.get(k, "")) == _norm(v))
        return round(hits / len(correct), 2)

    return 0.0


# Credit (letter) grading system used in Kazakhstan universities.
GRADE_SCALE = [
    (95, "A", 4.0, "Өте жақсы"),
    (90, "A-", 3.67, "Өте жақсы"),
    (85, "B+", 3.33, "Жақсы"),
    (80, "B", 3.0, "Жақсы"),
    (75, "B-", 2.67, "Жақсы"),
    (70, "C+", 2.33, "Қанағаттанарлық"),
    (65, "C", 2.0, "Қанағаттанарлық"),
    (60, "C-", 1.67, "Қанағаттанарлық"),
    (55, "D+", 1.33, "Қанағаттанарлық"),
    (50, "D", 1.0, "Қанағаттанарлық"),
    (0, "F", 0.0, "Қанағаттанарлықсыз"),
]


def grade(percent: float) -> dict:
    for threshold, letter, gpa, text in GRADE_SCALE:
        if percent >= threshold:
            return {"letter": letter, "gpa": gpa, "text": text}
    return {"letter": "F", "gpa": 0.0, "text": "Қанағаттанарлықсыз"}
