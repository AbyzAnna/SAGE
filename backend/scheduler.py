from datetime import datetime, timedelta
from typing import Dict, List

import database
from models import Event


def find_conflicts(candidate: Event, existing: List[Event]) -> List[Event]:
    conflicts = []
    for e in existing:
        if candidate.id is not None and e.id == candidate.id:
            continue
        if candidate.start < e.end and e.start < candidate.end:
            conflicts.append(e)
    return conflicts


def overloaded_days(events: List[Event], threshold_hours: float = 10.0) -> List[str]:
    by_day: Dict[str, float] = {}
    for e in events:
        day = e.start.date().isoformat()
        hours = (e.end - e.start).total_seconds() / 3600.0
        by_day[day] = by_day.get(day, 0) + hours
    return [day for day, hrs in by_day.items() if hrs >= threshold_hours]


def suggest_break(after_event: Event, minutes: int = 15) -> dict:
    return {
        "title": "Break",
        "start": after_event.end,
        "end": after_event.end + timedelta(minutes=minutes),
        "category": "personal",
        "priority": "low",
        "description": "Suggested rest period",
    }


def events_for_window(days_ahead: int = 14) -> List[Event]:
    now = datetime.now()
    return database.list_events(start=now - timedelta(days=1), end=now + timedelta(days=days_ahead))
