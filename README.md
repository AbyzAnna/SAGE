# SAGE — AI Scheduling Assistant

Converts natural conversation into a real schedule. Built for students and professionals who want to stop wrestling with calendars and just *talk* about what they need to do.

## What it does

- **Conversation → Schedule** — Tell SAGE "I need to study for my chem exam Tuesday, finish the project by Friday, and call mom Sunday afternoon." It extracts events, durations, and priorities automatically.
- **Automated planning** — SAGE proposes time blocks, balances workload, and resolves conflicts.
- **Real-time updates** — All clients sync over WebSocket. Add an event in one tab, it appears instantly in another.
- **Stress-reducing** — Suggests breaks, flags overloaded days, batches similar tasks.
- **Local & private** — Runs on your machine with a local LLM. Your schedule never leaves your computer.

## Stack

- **Backend:** Python 3.9+ with FastAPI + WebSockets + SQLite
- **AI:** [Ollama](https://ollama.com) running `llama3.2` (free, local, ~2GB)
- **Frontend:** Vanilla HTML/CSS/JS (no build step)

## Prerequisites

You already have these if you ran setup:

```bash
ollama --version    # >= 0.1
python3 --version   # >= 3.9
```

If `llama3.2` isn't pulled yet:

```bash
ollama pull llama3.2
```

## Setup

```bash
cd "SAGE "
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Run

In one terminal, make sure Ollama is running:

```bash
ollama serve     # usually auto-starts; safe to skip if already running
```

In another terminal:

```bash
source .venv/bin/activate
python3 backend/main.py
```

Open http://localhost:8000 in your browser.

## Project layout

```
SAGE /
├── backend/
│   ├── main.py          # FastAPI app + WebSocket + static serving
│   ├── ai_service.py    # Ollama client + prompt engineering
│   ├── scheduler.py     # Event CRUD + conflict detection
│   ├── models.py        # Pydantic schemas
│   └── database.py      # SQLite layer
├── frontend/
│   ├── index.html       # Chat + calendar UI
│   ├── styles.css       # Styling
│   └── app.js           # WebSocket client + rendering
├── data/
│   └── schedules.db     # Auto-created on first run
├── requirements.txt
└── README.md
```

## Try saying

- *"Block out 2 hours tomorrow morning for studying calculus."*
- *"I have a dentist appointment Thursday at 3pm."*
- *"Plan my week — I need 10 hours of project work, 5 hours of study, and a workout every other day."*
- *"What's on my schedule Friday?"*
- *"Move my 4pm meeting to 5pm."*
