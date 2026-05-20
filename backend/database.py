import sqlite3
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import List, Optional

from models import Event, EventCreate, EventUpdate


DB_PATH = Path(__file__).resolve().parent.parent / "data" / "schedules.db"


def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _conn() as c:
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS events (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                title       TEXT    NOT NULL,
                description TEXT    DEFAULT '',
                start       TEXT    NOT NULL,
                end         TEXT    NOT NULL,
                category    TEXT    DEFAULT 'other',
                priority    TEXT    DEFAULT 'medium',
                created_at  TEXT    DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        c.execute("CREATE INDEX IF NOT EXISTS idx_events_start ON events(start)")


@contextmanager
def _conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def _row_to_event(row: sqlite3.Row) -> Event:
    return Event(
        id=row["id"],
        title=row["title"],
        description=row["description"] or "",
        start=datetime.fromisoformat(row["start"]),
        end=datetime.fromisoformat(row["end"]),
        category=row["category"] or "other",
        priority=row["priority"] or "medium",
        created_at=datetime.fromisoformat(row["created_at"]) if row["created_at"] else None,
    )


def list_events(start: Optional[datetime] = None, end: Optional[datetime] = None) -> List[Event]:
    query = "SELECT * FROM events"
    params: List = []
    clauses: List[str] = []
    if start:
        clauses.append("end >= ?")
        params.append(start.isoformat())
    if end:
        clauses.append("start <= ?")
        params.append(end.isoformat())
    if clauses:
        query += " WHERE " + " AND ".join(clauses)
    query += " ORDER BY start ASC"
    with _conn() as c:
        rows = c.execute(query, params).fetchall()
    return [_row_to_event(r) for r in rows]


def get_event(event_id: int) -> Optional[Event]:
    with _conn() as c:
        row = c.execute("SELECT * FROM events WHERE id = ?", (event_id,)).fetchone()
    return _row_to_event(row) if row else None


def create_event(data: EventCreate) -> Event:
    with _conn() as c:
        cur = c.execute(
            """
            INSERT INTO events (title, description, start, end, category, priority)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                data.title,
                data.description,
                data.start.isoformat(),
                data.end.isoformat(),
                data.category,
                data.priority,
            ),
        )
        new_id = cur.lastrowid
        row = c.execute("SELECT * FROM events WHERE id = ?", (new_id,)).fetchone()
    return _row_to_event(row)


def update_event(event_id: int, data: EventUpdate) -> Optional[Event]:
    existing = get_event(event_id)
    if not existing:
        return None
    merged: dict = existing.model_dump()
    for k, v in data.model_dump(exclude_none=True).items():
        merged[k] = v
    with _conn() as c:
        c.execute(
            """
            UPDATE events
               SET title=?, description=?, start=?, end=?, category=?, priority=?
             WHERE id=?
            """,
            (
                merged["title"],
                merged["description"],
                merged["start"].isoformat() if isinstance(merged["start"], datetime) else merged["start"],
                merged["end"].isoformat() if isinstance(merged["end"], datetime) else merged["end"],
                merged["category"],
                merged["priority"],
                event_id,
            ),
        )
    return get_event(event_id)


def delete_event(event_id: int) -> bool:
    with _conn() as c:
        cur = c.execute("DELETE FROM events WHERE id = ?", (event_id,))
        return cur.rowcount > 0
