import json
import os
import re
from datetime import datetime, timedelta
from typing import Dict, List, Optional

import httpx
from dateutil import parser as dtparser

import database
import scheduler
from models import Event, EventCreate, EventUpdate


OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://localhost:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "llama3.2")


SYSTEM_PROMPT = """You are SAGE, an AI scheduling assistant. Your job is to take a user's natural-language message and convert it into structured calendar actions.

You ALWAYS reply with a single JSON object — no prose, no markdown fences. Schema:

{
  "reply": "<short friendly sentence to show the user>",
  "actions": [
    {"op": "create", "title": "...", "start": "ISO8601", "end": "ISO8601",
     "category": "study|work|personal|health|social|other",
     "priority": "low|medium|high",
     "description": "..."},
    {"op": "update", "id": 42, "title": "...", "start": "...", "end": "...", ...},
    {"op": "delete", "id": 42}
  ]
}

Rules:
- All datetimes are LOCAL time in ISO8601 (e.g. "2026-05-19T14:00:00").
- If the user gives a duration but no end time, infer a reasonable end.
- If they ask a question or just chat, return actions=[] and answer in "reply".
- If they mention "study" or "homework" → category="study"; "meeting"/"work" → "work";
  "doctor"/"gym"/"workout" → "health"; "friend"/"party"/"family" → "social".
- Default duration: 1 hour. Default category: "other". Default priority: "medium".
- If you can't parse a time, ask a clarifying question in "reply" and return actions=[].
- Be concise. The reply should be 1-2 sentences max.
"""


class AIService:
    def __init__(self) -> None:
        self.client = httpx.AsyncClient(timeout=120.0)

    async def close(self) -> None:
        await self.client.aclose()

    async def chat(self, user_message: str, now: Optional[datetime] = None) -> dict:
        now = now or datetime.now()
        upcoming = scheduler.events_for_window(days_ahead=14)
        context = self._build_context(now, upcoming)

        prompt = (
            f"{context}\n\n"
            f"User message: {user_message}\n\n"
            "Respond with the JSON object only."
        )

        raw = await self._ollama_generate(prompt)
        parsed = self._extract_json(raw)
        if not parsed:
            return {
                "reply": "Sorry — I couldn't understand that. Try rephrasing, e.g. 'Study calc tomorrow 2-4pm'.",
                "created_events": [],
                "updated_events": [],
                "deleted_event_ids": [],
                "conflicts": [],
            }
        return self._apply_actions(parsed, upcoming)

    def _build_context(self, now: datetime, upcoming: List[Event]) -> str:
        events_text = (
            "\n".join(
                f"- id={e.id} | {e.start.isoformat()} → {e.end.isoformat()} | "
                f"{e.title} [{e.category}/{e.priority}]"
                for e in upcoming
            )
            or "(no upcoming events)"
        )
        return (
            f"Current local datetime: {now.isoformat()}\n"
            f"Day of week: {now.strftime('%A')}\n\n"
            f"Existing events (next 14 days):\n{events_text}"
        )

    async def _ollama_generate(self, prompt: str) -> str:
        try:
            resp = await self.client.post(
                f"{OLLAMA_HOST}/api/generate",
                json={
                    "model": OLLAMA_MODEL,
                    "prompt": prompt,
                    "system": SYSTEM_PROMPT,
                    "stream": False,
                    "format": "json",
                    "options": {"temperature": 0.2},
                },
            )
            resp.raise_for_status()
            data = resp.json()
            return data.get("response", "")
        except httpx.HTTPError as e:
            return json.dumps(
                {
                    "reply": f"AI service unavailable ({e.__class__.__name__}). Is Ollama running?",
                    "actions": [],
                }
            )

    def _extract_json(self, text: str) -> Optional[dict]:
        if not text:
            return None
        text = text.strip()
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            pass
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if match:
            try:
                return json.loads(match.group(0))
            except json.JSONDecodeError:
                return None
        return None

    def _apply_actions(self, parsed: dict, existing: List[Event]) -> dict:
        reply = parsed.get("reply", "Done.")
        actions = parsed.get("actions") or []

        created: List[Event] = []
        updated: List[Event] = []
        deleted: List[int] = []
        conflicts: List[str] = []

        for action in actions:
            op = (action.get("op") or "").lower()
            try:
                if op == "create":
                    ev = self._action_to_create(action)
                    if ev is None:
                        continue
                    conflict_list = scheduler.find_conflicts(
                        Event(**ev.model_dump(), id=None), existing
                    )
                    if conflict_list:
                        conflicts.append(
                            f"'{ev.title}' overlaps with: "
                            + ", ".join(c.title for c in conflict_list)
                        )
                    new_event = database.create_event(ev)
                    created.append(new_event)
                    existing.append(new_event)
                elif op == "update":
                    event_id = action.get("id")
                    if event_id is None:
                        continue
                    upd = self._action_to_update(action)
                    result = database.update_event(int(event_id), upd)
                    if result:
                        updated.append(result)
                elif op == "delete":
                    event_id = action.get("id")
                    if event_id is None:
                        continue
                    if database.delete_event(int(event_id)):
                        deleted.append(int(event_id))
            except Exception as e:
                conflicts.append(f"Couldn't apply action ({e.__class__.__name__}): {action}")

        return {
            "reply": reply,
            "created_events": [e.model_dump(mode="json") for e in created],
            "updated_events": [e.model_dump(mode="json") for e in updated],
            "deleted_event_ids": deleted,
            "conflicts": conflicts,
        }

    def _action_to_create(self, action: dict) -> Optional[EventCreate]:
        try:
            start = self._parse_dt(action.get("start"))
            end_raw = action.get("end")
            end = self._parse_dt(end_raw) if end_raw else (start + timedelta(hours=1))
            if end <= start:
                end = start + timedelta(hours=1)
            return EventCreate(
                title=action.get("title") or "Untitled",
                description=action.get("description") or "",
                start=start,
                end=end,
                category=action.get("category") or "other",
                priority=action.get("priority") or "medium",
            )
        except Exception:
            return None

    def _action_to_update(self, action: dict) -> EventUpdate:
        payload: Dict = {}
        for key in ("title", "description", "category", "priority"):
            if key in action and action[key] is not None:
                payload[key] = action[key]
        if action.get("start"):
            payload["start"] = self._parse_dt(action["start"])
        if action.get("end"):
            payload["end"] = self._parse_dt(action["end"])
        return EventUpdate(**payload)

    def _parse_dt(self, value) -> datetime:
        if isinstance(value, datetime):
            return value
        return dtparser.parse(str(value))
