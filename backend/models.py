from datetime import datetime
from typing import Optional, List, Literal
from pydantic import BaseModel, Field


Priority = Literal["low", "medium", "high"]
Category = Literal["study", "work", "personal", "health", "social", "other"]


class Event(BaseModel):
    id: Optional[int] = None
    title: str
    description: str = ""
    start: datetime
    end: datetime
    category: Category = "other"
    priority: Priority = "medium"
    created_at: Optional[datetime] = None


class EventCreate(BaseModel):
    title: str
    description: str = ""
    start: datetime
    end: datetime
    category: Category = "other"
    priority: Priority = "medium"


class EventUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    start: Optional[datetime] = None
    end: Optional[datetime] = None
    category: Optional[Category] = None
    priority: Optional[Priority] = None


class ChatMessage(BaseModel):
    message: str
    now: Optional[datetime] = Field(default_factory=datetime.now)


class ChatResponse(BaseModel):
    reply: str
    created_events: List[Event] = []
    updated_events: List[Event] = []
    deleted_event_ids: List[int] = []
    conflicts: List[str] = []
