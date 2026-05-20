(() => {
  const state = {
    events: [],
    weekStart: startOfWeek(new Date()),
    ws: null,
  };

  const $ = (id) => document.getElementById(id);
  const messagesEl = $("messages");
  const chatForm = $("chat-form");
  const chatInput = $("chat-input");
  const sendBtn = $("send-btn");
  const calendarEl = $("calendar");
  const weekTitle = $("week-title");
  const wsDot = $("ws-dot");
  const wsText = $("ws-text");
  const toastEl = $("toast");

  // ---------- date helpers ----------
  function startOfWeek(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    const dow = x.getDay(); // 0=Sun
    x.setDate(x.getDate() - dow);
    return x;
  }
  function addDays(d, n) {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
  }
  function sameDay(a, b) {
    return (
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate()
    );
  }
  function fmtTime(d) {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  function fmtDateRange(start, end) {
    const opts = { month: "short", day: "numeric" };
    return `${start.toLocaleDateString([], opts)} – ${end.toLocaleDateString([], opts)}`;
  }

  // ---------- toast ----------
  let toastTimer;
  function toast(msg, kind = "ok") {
    clearTimeout(toastTimer);
    toastEl.textContent = msg;
    toastEl.className = `toast toast--show toast--${kind}`;
    toastTimer = setTimeout(() => {
      toastEl.className = "toast";
    }, 3200);
  }

  // ---------- chat ----------
  function addMessage(role, html) {
    const el = document.createElement("div");
    el.className = `message message--${role}`;
    el.innerHTML = `<div class="bubble">${html}</div>`;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  async function sendMessage(text) {
    addMessage("user", escapeHtml(text));
    const typingEl = addMessage("bot", '<span class="typing"><span></span><span></span><span></span></span>');

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, now: new Date().toISOString() }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      typingEl.querySelector(".bubble").innerHTML = escapeHtml(data.reply || "Done.");

      const summaryLines = [];
      if (data.created_events?.length) summaryLines.push(`✓ added ${data.created_events.length}`);
      if (data.updated_events?.length) summaryLines.push(`↻ updated ${data.updated_events.length}`);
      if (data.deleted_event_ids?.length) summaryLines.push(`✗ removed ${data.deleted_event_ids.length}`);
      if (summaryLines.length) {
        const sysEl = document.createElement("div");
        sysEl.className = "message message--system";
        sysEl.innerHTML = `<div class="bubble">${summaryLines.join(" · ")}</div>`;
        messagesEl.appendChild(sysEl);
      }
      if (data.conflicts?.length) {
        data.conflicts.forEach((c) => toast(c, "warn"));
      }
    } catch (err) {
      typingEl.querySelector(".bubble").innerHTML =
        `<span style="color:var(--danger)">Error: ${escapeHtml(err.message)}</span>`;
    }
  }

  chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    chatInput.value = "";
    sendBtn.disabled = true;
    sendMessage(text).finally(() => {
      sendBtn.disabled = false;
      chatInput.focus();
    });
  });

  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      chatForm.requestSubmit();
    }
  });

  // ---------- calendar ----------
  function renderCalendar() {
    calendarEl.innerHTML = "";
    const weekEnd = addDays(state.weekStart, 6);
    weekTitle.textContent = fmtDateRange(state.weekStart, weekEnd);
    const today = new Date();
    const overloaded = computeOverloadedDays();

    for (let i = 0; i < 7; i++) {
      const date = addDays(state.weekStart, i);
      const dayEvents = state.events
        .filter((ev) => sameDay(new Date(ev.start), date))
        .sort((a, b) => new Date(a.start) - new Date(b.start));

      const dayEl = document.createElement("div");
      dayEl.className = "day";
      if (sameDay(date, today)) dayEl.classList.add("day--today");
      const dayKey = date.toISOString().slice(0, 10);
      if (overloaded.has(dayKey)) dayEl.classList.add("day--overloaded");

      const header = document.createElement("div");
      header.className = "day-header";
      header.innerHTML = `
        <span class="day-name">${date.toLocaleDateString([], { weekday: "short" })}</span>
        <span class="day-num">${date.getDate()}</span>
      `;
      dayEl.appendChild(header);

      dayEvents.forEach((ev) => {
        const evEl = document.createElement("div");
        evEl.className = `event event--${ev.category} event--${ev.priority}`;
        const start = new Date(ev.start);
        const end = new Date(ev.end);
        evEl.innerHTML = `
          <div class="event-title">${escapeHtml(ev.title)}</div>
          <div class="event-time">${fmtTime(start)} – ${fmtTime(end)}</div>
        `;
        evEl.addEventListener("click", () => openModal(ev));
        dayEl.appendChild(evEl);
      });

      calendarEl.appendChild(dayEl);
    }
  }

  function computeOverloadedDays() {
    const byDay = {};
    state.events.forEach((ev) => {
      const key = new Date(ev.start).toISOString().slice(0, 10);
      const hrs = (new Date(ev.end) - new Date(ev.start)) / 3_600_000;
      byDay[key] = (byDay[key] || 0) + hrs;
    });
    return new Set(Object.entries(byDay).filter(([, h]) => h >= 10).map(([k]) => k));
  }

  $("prev-week").addEventListener("click", () => {
    state.weekStart = addDays(state.weekStart, -7);
    renderCalendar();
  });
  $("next-week").addEventListener("click", () => {
    state.weekStart = addDays(state.weekStart, 7);
    renderCalendar();
  });
  $("today-btn").addEventListener("click", () => {
    state.weekStart = startOfWeek(new Date());
    renderCalendar();
  });

  // ---------- modal ----------
  function openModal(ev) {
    const existing = document.querySelector(".modal-backdrop");
    if (existing) existing.remove();

    const start = new Date(ev.start);
    const end = new Date(ev.end);
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop modal-backdrop--show";
    backdrop.innerHTML = `
      <div class="modal">
        <h3>${escapeHtml(ev.title)}</h3>
        <div class="meta">
          ${start.toLocaleString()} → ${end.toLocaleString()}<br />
          <span style="color: var(--cat-${ev.category})">●</span>
          ${ev.category} · ${ev.priority} priority
        </div>
        <div class="desc">${escapeHtml(ev.description || "(no description)")}</div>
        <div class="modal-actions">
          <button class="btn" data-act="close">Close</button>
          <button class="btn btn--danger" data-act="delete">Delete</button>
        </div>
      </div>
    `;
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) backdrop.remove();
    });
    backdrop.querySelector('[data-act="close"]').addEventListener("click", () => backdrop.remove());
    backdrop.querySelector('[data-act="delete"]').addEventListener("click", async () => {
      try {
        const res = await fetch(`/api/events/${ev.id}`, { method: "DELETE" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        toast("Event deleted", "ok");
        backdrop.remove();
      } catch (err) {
        toast(`Delete failed: ${err.message}`, "err");
      }
    });
    document.body.appendChild(backdrop);
  }

  // ---------- websocket ----------
  function connectWS() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    state.ws = ws;

    ws.addEventListener("open", () => {
      wsDot.className = "dot dot--online";
      wsText.textContent = "live";
    });

    ws.addEventListener("close", () => {
      wsDot.className = "dot dot--offline";
      wsText.textContent = "reconnecting…";
      setTimeout(connectWS, 1500);
    });

    ws.addEventListener("error", () => ws.close());

    ws.addEventListener("message", (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }

      switch (msg.type) {
        case "snapshot":
          state.events = msg.events || [];
          renderCalendar();
          break;
        case "event_created":
          state.events.push(msg.event);
          renderCalendar();
          toast(`Added: ${msg.event.title}`, "ok");
          break;
        case "event_updated":
          state.events = state.events.map((e) => (e.id === msg.event.id ? msg.event : e));
          renderCalendar();
          break;
        case "event_deleted":
          state.events = state.events.filter((e) => e.id !== msg.id);
          renderCalendar();
          break;
        case "chat_result":
          // already applied via REST broadcast for created/updated/deleted
          break;
      }
    });
  }

  // ---------- bootstrap ----------
  async function loadEvents() {
    try {
      const res = await fetch("/api/events");
      state.events = await res.json();
      renderCalendar();
    } catch {
      renderCalendar();
    }
  }

  loadEvents();
  connectWS();
})();
