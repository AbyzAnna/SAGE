import asyncio
import json
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional, Set

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

sys.path.insert(0, str(Path(__file__).resolve().parent))

import database
from ai_service import AIService
from models import ChatMessage, EventCreate, EventUpdate


FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
PORT = int(os.environ.get("SAGE_PORT", "8000"))


class Broadcaster:
    def __init__(self) -> None:
        self.connections: Set[WebSocket] = set()
        self.lock = asyncio.Lock()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        async with self.lock:
            self.connections.add(ws)

    async def disconnect(self, ws: WebSocket) -> None:
        async with self.lock:
            self.connections.discard(ws)

    async def broadcast(self, payload: dict) -> None:
        async with self.lock:
            stale = []
            for ws in self.connections:
                try:
                    await ws.send_text(json.dumps(payload, default=str))
                except Exception:
                    stale.append(ws)
            for ws in stale:
                self.connections.discard(ws)


broadcaster = Broadcaster()
ai_service: Optional[AIService] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global ai_service
    database.init_db()
    ai_service = AIService()
    yield
    if ai_service:
        await ai_service.close()


app = FastAPI(title="SAGE — AI Scheduling Assistant", lifespan=lifespan)


@app.get("/")
async def root():
    return FileResponse(FRONTEND_DIR / "index.html")


@app.get("/api/events")
async def list_events_endpoint():
    events = database.list_events()
    return [e.model_dump(mode="json") for e in events]


@app.post("/api/events")
async def create_event_endpoint(data: EventCreate):
    ev = database.create_event(data)
    payload = ev.model_dump(mode="json")
    await broadcaster.broadcast({"type": "event_created", "event": payload})
    return payload


@app.patch("/api/events/{event_id}")
async def update_event_endpoint(event_id: int, data: EventUpdate):
    ev = database.update_event(event_id, data)
    if not ev:
        raise HTTPException(404, "Event not found")
    payload = ev.model_dump(mode="json")
    await broadcaster.broadcast({"type": "event_updated", "event": payload})
    return payload


@app.delete("/api/events/{event_id}")
async def delete_event_endpoint(event_id: int):
    if not database.delete_event(event_id):
        raise HTTPException(404, "Event not found")
    await broadcaster.broadcast({"type": "event_deleted", "id": event_id})
    return {"deleted": event_id}


@app.post("/api/chat")
async def chat_endpoint(msg: ChatMessage):
    if ai_service is None:
        raise HTTPException(503, "AI service not ready")
    result = await ai_service.chat(msg.message, msg.now)
    await broadcaster.broadcast({"type": "chat_result", "result": result})
    return result


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await broadcaster.connect(ws)
    try:
        events = database.list_events()
        await ws.send_text(
            json.dumps(
                {"type": "snapshot", "events": [e.model_dump(mode="json") for e in events]},
                default=str,
            )
        )
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        await broadcaster.disconnect(ws)
    except Exception:
        await broadcaster.disconnect(ws)


app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=PORT, reload=False)
