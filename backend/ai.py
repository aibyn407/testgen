import json
import os
import re
from google import genai
from google.genai import types

from .scoring import _norm

MODEL = os.getenv("GEMINI_MODEL", "gemini-flash-lite-latest")

LANG_INSTRUCTIONS = {
    "kz": "Барлық сұрақтар мен жауаптарды ТЕК ҚАЗАҚ тілінде жаз.",
    "ru": "Все вопросы и ответы пиши ТОЛЬКО на русском языке.",
    "en": "Write all questions and answers ONLY in English.",
}

SYSTEM_PROMPT = (
    "Ты — опытный педагог, составляешь образовательные тесты по учебному материалу. "
    "Всегда возвращаешь строго валидный JSON-массив без markdown, без комментариев, без текста до или после."
)


def _client() -> genai.Client:
    key = os.getenv("GEMINI_API_KEY")
    if not key:
        raise RuntimeError("GEMINI_API_KEY не задан. Получи ключ на https://aistudio.google.com/apikey")
    return genai.Client(api_key=key)


TYPE_ORDER = ("multiple_choice", "open", "matching")

# How many questions of each type (choice, written, matching) for a given total.
DISTRIBUTION = {
    5: (3, 1, 1),
    10: (4, 3, 3),
    15: (8, 4, 3),
    20: (11, 5, 4),
    25: (14, 6, 5),
}


def distribution(count: int) -> dict[str, int]:
    if count in DISTRIBUTION:
        mc, op, mt = DISTRIBUTION[count]
    else:
        mt = max(1, round(count * 0.2))
        op = max(1, round(count * 0.25))
        mc = count - op - mt
    return dict(zip(TYPE_ORDER, (mc, op, mt)))


def _build_prompt(topic_name: str, content: str, lang: str, need: dict[str, int], avoid: list[str]) -> str:
    lang_note = LANG_INSTRUCTIONS.get(lang, LANG_INSTRUCTIONS["kz"])
    total = sum(need.values())
    avoid_block = ""
    if avoid:
        listed = "\n".join(f"- {q}" for q in avoid[:80])
        avoid_block = f"\nЭТИ ВОПРОСЫ УЖЕ ЕСТЬ — не повторяй их и не задавай их другими словами:\n{listed}\n"

    if content.strip():
        source = f"МАТЕРИАЛ:\n{content[:12000]}\n\nЗАДАНИЕ: составь РОВНО {total} вопросов по этому материалу"
    else:
        # Teacher gave only a topic: rely on well-established knowledge of the subject.
        source = (
            "МАТЕРИАЛА НЕТ — преподаватель указал только тему (в ней могут быть уточнения: уровень, класс, акценты).\n"
            "Используй только общепризнанные, проверяемые факты по этой теме, как в учебниках; "
            "не выдумывай даты, имена и цифры, в которых не уверен.\n\n"
            f"ЗАДАНИЕ: составь РОВНО {total} вопросов по этой теме"
        )
    return f"""ТЕМА: {topic_name}

{source}, строго в таком количестве по типам:
- ровно {need["multiple_choice"]} вопросов типа "multiple_choice" (4 варианта, один правильный)
- ровно {need["open"]} вопросов типа "open" (короткий письменный ответ, 1-5 слов)
- ровно {need["matching"]} вопросов типа "matching" (сопоставить 4 пары термин↔определение)

{lang_note}

Каждый вопрос должен быть уникальным: не повторяй формулировки и факты, покрывай разные аспекты темы,
разной сложности. В вопросах "matching" используй разные термины, не те же, что в других вопросах.
{avoid_block}
Верни ТОЛЬКО валидный JSON-массив в таком формате:
[
  {{
    "type": "multiple_choice",
    "question": "текст вопроса",
    "options": ["A вариант", "B вариант", "C вариант", "D вариант"],
    "correct": "A вариант"
  }},
  {{
    "type": "open",
    "question": "текст вопроса",
    "options": null,
    "correct": "правильный ответ"
  }},
  {{
    "type": "matching",
    "question": "Сопоставьте термины и определения",
    "options": {{"left": ["Термин1","Термин2","Термин3","Термин4"], "right": ["Опр1","Опр2","Опр3","Опр4"]}},
    "correct": {{"Термин1":"Опр1","Термин2":"Опр2","Термин3":"Опр3","Термин4":"Опр4"}}
  }}
]
"""


def _extract_json(text: str):
    text = text.strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    start = text.find("[")
    end = text.rfind("]")
    if start == -1 or end == -1:
        raise ValueError("JSON array not found in model output")
    return json.loads(text[start:end+1])


def _ask_model(prompt: str) -> list:
    client = _client()  # keep a reference: the HTTP connection closes when the client is garbage-collected
    response = client.models.generate_content(
        model=MODEL,
        contents=prompt,
        config=types.GenerateContentConfig(
            system_instruction=SYSTEM_PROMPT,
            temperature=0.4,
            max_output_tokens=8000,
            response_mime_type="application/json",
        ),
    )
    return _extract_json(response.text or "")


def question_key(q: dict) -> str:
    """Normalized identity of a question, used to drop duplicates."""
    if q["type"] == "matching" and isinstance(q.get("correct"), dict):
        return "matching:" + "|".join(sorted(_norm(k) for k in q["correct"]))
    return _norm(q["question"])


def generate_questions(topic_name: str, content: str, lang: str = "kz", count: int = 15,
                       avoid: list[str] | None = None) -> list[dict]:
    """Generates exactly the planned number of questions of each type, without duplicates.

    If the model returns too few of some type, it is asked once more for the missing ones.
    """
    plan = distribution(count)
    avoid = list(avoid or [])
    seen = {_norm(q) for q in avoid}
    picked: list[dict] = []

    for _ in range(3):
        have = {t: sum(1 for q in picked if q["type"] == t) for t in TYPE_ORDER}
        need = {t: plan[t] - have[t] for t in TYPE_ORDER}
        if not any(need.values()):
            break
        prompt = _build_prompt(topic_name, content, lang, need, avoid + [q["question"] for q in picked])
        for q in clean_questions(_ask_model(prompt)):
            key = question_key(q)
            if need[q["type"]] > 0 and key not in seen:
                seen.add(key)
                picked.append(q)
                need[q["type"]] -= 1

    picked.sort(key=lambda q: TYPE_ORDER.index(q["type"]))
    return picked


def clean_questions(questions) -> list[dict]:
    """Drops malformed questions the model sometimes returns."""
    cleaned = []
    for q in questions if isinstance(questions, list) else []:
        if not isinstance(q, dict):
            continue
        qt = q.get("type")
        text = str(q.get("question") or "").strip()
        options = q.get("options")
        correct = q.get("correct")
        if not text or correct in (None, ""):
            continue
        if qt == "multiple_choice":
            if not isinstance(options, list) or len(options) < 2:
                continue
            options = [str(o).strip() for o in options]
            correct = str(correct).strip()
            if correct not in options:
                continue
        elif qt == "open":
            options = None
            correct = str(correct).strip()
        elif qt == "matching":
            if not isinstance(options, dict) or not isinstance(correct, dict):
                continue
            left, right = options.get("left"), options.get("right")
            if not isinstance(left, list) or not isinstance(right, list):
                continue
            if set(correct) != set(left) or not set(correct.values()) <= set(right):
                continue
        else:
            continue
        cleaned.append({"type": qt, "question": text, "options": options, "correct": correct})
    return cleaned
