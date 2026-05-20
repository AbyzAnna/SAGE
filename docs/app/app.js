/* SAGE — fully client-side AI scheduling assistant.
 *
 * Two engines try, in order, on every chat message:
 *   1. Pollinations.ai (free, keyless cloud LLM) for full conversational AI
 *   2. Deterministic parser (chrono-node + keyword classifier) — always available
 *
 * The deterministic parser ensures the app NEVER fails to handle a request,
 * even when Pollinations is down. When the cloud LLM is healthy, the chat
 * gets richer multi-event extraction and conversational replies.
 *
 * All data lives in localStorage. No backend, no signup, no API keys.
 */

(() => {
  // ---------- state ----------
  const LS_EVENTS = "sage.events.v1";
  const state = {
    events: loadEvents(),
    weekStart: startOfWeek(new Date()),
    mode: "loading",       // "loading" | "ai" | "basic" | "error"
    nextId: nextIdFrom(loadEvents()),
  };

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const messagesEl = $("messages");
  const chatForm = $("chat-form");
  const chatInput = $("chat-input");
  const sendBtn = $("send-btn");
  const calendarEl = $("calendar");
  const weekTitle = $("week-title");
  const modeDot = $("mode-dot");
  const modeText = $("mode-text");
  const toastEl = $("toast");

  // ---------- date helpers ----------
  function startOfWeek(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    x.setDate(x.getDate() - x.getDay());
    return x;
  }
  function addDays(d, n) {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
  }
  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() &&
           a.getMonth()    === b.getMonth() &&
           a.getDate()     === b.getDate();
  }
  function fmtTime(d) {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  function fmtDateRange(start, end) {
    const opts = { month: "short", day: "numeric" };
    return `${start.toLocaleDateString([], opts)} – ${end.toLocaleDateString([], opts)}`;
  }
  function toIsoLocal(d) {
    // Local ISO with no timezone suffix; matches what the LLM should produce
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
  }

  // ---------- storage ----------
  function loadEvents() {
    try {
      const raw = localStorage.getItem(LS_EVENTS);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }
  function saveEvents() {
    localStorage.setItem(LS_EVENTS, JSON.stringify(state.events));
  }
  function nextIdFrom(events) {
    return (events.reduce((m, e) => Math.max(m, e.id || 0), 0)) + 1;
  }

  // ---------- toast ----------
  let toastTimer;
  function toast(msg, kind = "ok") {
    clearTimeout(toastTimer);
    toastEl.textContent = msg;
    toastEl.className = `toast toast--show toast--${kind}`;
    toastTimer = setTimeout(() => { toastEl.className = "toast"; }, 3000);
  }

  // ---------- mode indicator ----------
  function setMode(m) {
    state.mode = m;
    const labels = {
      loading: { text: "Connecting…", cls: "dot--loading" },
      ai:      { text: "AI online",   cls: "dot--ai"      },
      basic:   { text: "Basic mode",  cls: "dot--basic"   },
      error:   { text: "Basic mode",  cls: "dot--basic"   },
    };
    const cfg = labels[m] || labels.basic;
    modeText.textContent = cfg.text;
    modeDot.className = `dot ${cfg.cls}`;
  }

  // ---------- categorization (shared by both engines) ----------
  const CATEGORY_KEYWORDS = {
    study:    ["study","homework","exam","essay","read","chapter","review","quiz","calc","calculus","math","chem","bio","history","english","lecture","class"],
    work:     ["meeting","work","standup","sync","1:1","email","call","client","project","deadline","report","ship","deploy","interview","presentation"],
    health:   ["doctor","dentist","gym","workout","run","jog","yoga","therapy","appointment","hospital","clinic","walk"],
    social:   ["party","dinner","lunch","brunch","drink","drinks","date","mom","dad","family","friends","birthday","wedding","movie"],
    personal: ["chore","laundry","grocery","groceries","clean","shopping","cook","errand","haircut","break","rest"],
  };
  function classifyCategory(text) {
    const lc = text.toLowerCase();
    for (const [cat, kws] of Object.entries(CATEGORY_KEYWORDS)) {
      if (kws.some(k => lc.includes(k))) return cat;
    }
    return "other";
  }
  function classifyPriority(text) {
    const lc = text.toLowerCase();
    if (/(urgent|asap|critical|must|important|deadline|due)/.test(lc)) return "high";
    if (/(optional|maybe|whenever|sometime)/.test(lc)) return "low";
    return "medium";
  }

  // ---------- conflict detection ----------
  function findConflicts(candidate) {
    return state.events.filter(e => {
      if (e.id === candidate.id) return false;
      return new Date(candidate.start) < new Date(e.end) &&
             new Date(e.start) < new Date(candidate.end);
    });
  }

  // ---------- CRUD ----------
  function addEvent(data) {
    const ev = {
      id: state.nextId++,
      title: data.title || "Untitled",
      description: data.description || "",
      start: data.start,
      end: data.end,
      category: data.category || classifyCategory(data.title || ""),
      priority: data.priority || classifyPriority(data.title || ""),
    };
    const conflicts = findConflicts(ev);
    state.events.push(ev);
    saveEvents();
    renderCalendar();
    return { event: ev, conflicts };
  }
  function deleteEvent(id) {
    const i = state.events.findIndex(e => e.id === id);
    if (i === -1) return false;
    state.events.splice(i, 1);
    saveEvents();
    renderCalendar();
    return true;
  }
  function updateEvent(id, patch) {
    const ev = state.events.find(e => e.id === id);
    if (!ev) return null;
    Object.assign(ev, patch);
    saveEvents();
    renderCalendar();
    return ev;
  }

  // ---------- deterministic fallback engine ----------
  // Uses chrono-node for date parsing. Handles "study calc tomorrow 2-4pm",
  // "dentist Thursday at 3", "call mom Sunday", etc.
  function basicEngine(message, now) {
    const lc = message.toLowerCase();

    // Handle "what's on" / "show" queries
    if (/^(what(?:'s| is)|show|list|tell me about)\s/.test(lc)) {
      return queryReply(lc, now);
    }

    // Handle "delete/cancel/remove X"
    const delMatch = lc.match(/^(delete|cancel|remove|drop)\s+(.+)/);
    if (delMatch) {
      const term = delMatch[2].replace(/^my\s+/, "").trim();
      const found = state.events.find(e => e.title.toLowerCase().includes(term.split(" ")[0]));
      if (found) {
        const t = found.title;
        deleteEvent(found.id);
        return {
          reply: `Removed "${t}".`,
          created: [], updated: [], deleted: [found.id], conflicts: []
        };
      }
      return { reply: `I couldn't find an event matching "${term}".`, created: [], updated: [], deleted: [], conflicts: [] };
    }

    // Parse dates with chrono — scans full message, picks up dates embedded in stories
    const results = window.chrono ? window.chrono.parse(message, now, { forwardDate: true }) : [];
    if (results.length === 0) {
      return {
        reply: "Got it. Let me know if there's anything you want me to add.",
        created: [], updated: [], deleted: [], conflicts: []
      };
    }

    const created = [];
    const allConflicts = [];

    for (const r of results) {
      const start = r.start ? r.start.date() : null;
      let end = r.end ? r.end.date() : null;
      if (!start) continue;
      // Skip past-tense narrative dates ("yesterday I was…"). Only schedule future things.
      if (start.getTime() < now.getTime() - 60_000) continue;

      // Detect "is due X" / "by X" patterns to identify deadlines
      const before = message.slice(Math.max(0, r.index - 40), r.index).toLowerCase();
      const isDeadline = /(\b(is\s+)?due\s*$|\bby\s*$|\bdeadline\s*$|\bturn\s+in.*$|\bsubmit.*$)/.test(before);
      if (isDeadline && (!r.start.isCertain || !r.start.isCertain("hour"))) {
        start.setHours(23, 0, 0, 0);
      }
      if (!end) {
        end = new Date(start);
        end.setHours(end.getHours() + 1);
      }
      if (end <= start) end = new Date(start.getTime() + 3600_000);

      // Title extraction: take the noun phrase nearest the date mention
      let title = extractTitleAround(message, r.index, r.text.length, isDeadline);
      if (!title) title = "Event";

      const category = classifyCategory(title + " " + message);
      const priority = isDeadline ? "high" : classifyPriority(message);

      const result = addEvent({
        title,
        start: toIsoLocal(start),
        end: toIsoLocal(end),
        category,
        priority,
      });
      created.push(result.event);
      result.conflicts.forEach(c => allConflicts.push(`"${title}" overlaps with "${c.title}"`));
    }

    let reply;
    if (created.length === 1) {
      const e = created[0];
      reply = `Got it — added "${e.title}" for ${new Date(e.start).toLocaleString([], { dateStyle:"medium", timeStyle:"short" })}.`;
    } else if (created.length > 1) {
      reply = `Added ${created.length} things to your schedule: ${created.map(e => `"${e.title}"`).join(", ")}.`;
    } else {
      reply = "Got it.";
    }

    return { reply, created, updated: [], deleted: [], conflicts: allConflicts };
  }

  // Extract a useful event title from text around a date phrase.
  // Handles narrative forms like:
  //   "...my chem assignment is due tomorrow night..."  →  "Chem assignment"
  //   "...we have a meeting on Friday at 3..."          →  "Meeting"
  //   "...party Saturday night..."                      →  "Party"
  function extractTitleAround(message, dateIndex, dateLen, isDeadline) {
    const before = message.slice(0, dateIndex);
    const after  = message.slice(dateIndex + dateLen);

    // Strategy 1: noun phrase right before the date (with optional "is/are due/by")
    // e.g. "my chem assignment is due", "the dentist appointment"
    let beforeTrimmed = before.replace(/\s+(is|are|will\s+be|gets?|happens?)\s+(due|by|on|at|in)?\s*$/i, "")
                              .replace(/\s+(on|at|for|in)\s*$/i, "")
                              .trim();
    // Strip conversational filler from the END going backwards into the sentence,
    // then take the last clause. Done BEFORE slicing words so we don't keep filler fragments.
    beforeTrimmed = beforeTrimmed
      .replace(/(?:^|\s)(?:oh\s+)?by\s+the\s+way\b/gi, "")
      .replace(/(?:^|\s)(?:and\s+)?anyway\b/gi, "")
      .replace(/(?:^|\s)you\s+know\b/gi, "")
      .replace(/(?:^|\s)i\s+mean\b/gi, "")
      .replace(/(?:^|\s)well\b/gi, "")
      .trim();
    const beforeWords = beforeTrimmed.split(/[,.;!?]/).pop().trim().split(/\s+/);
    let candidate = beforeWords.slice(-5).join(" ");
    // Then single-word leading filler — iterate to peel multiple layers
    for (let i = 0; i < 4; i++) {
      const next = candidate.replace(/^(and|but|so|then|because|since|also|oh|hey|like|um|uh|well|actually|i|me|my|the|a|an|some|that|this|those|these|have\s+(a|an|to|the)?|got\s+(a|an|the)?|need\s+to|got\s+to|gotta|wanna)\s+/i, "");
      if (next === candidate) break;
      candidate = next;
    }
    candidate = candidate.replace(/\s+(is|are|was|were|will\s+be|gets?|happens?)\s*$/i, "").trim();

    // Strategy 2: if before yielded nothing useful, look right after the date phrase
    if (!candidate || candidate.length < 3) {
      const afterWords = after.replace(/^[,.;!?\s]+/, "").split(/[,.;!?]/)[0].trim().split(/\s+/);
      candidate = afterWords.slice(0, 5).join(" ")
        .replace(/^(for|with|about|to)\s+/i, "")
        .trim();
    }

    // Strip command verbs if present at start
    candidate = candidate.replace(/^(add|schedule|book|create|put|block|set|plan)\s+(it|that|in|out|up)?\s*/i, "").trim();

    if (!candidate) return "";

    // Append "(deadline)" hint if it's a deadline
    if (isDeadline && !/deadline|due/i.test(candidate)) {
      candidate += " (deadline)";
    }
    return candidate[0].toUpperCase() + candidate.slice(1);
  }

  function queryReply(lc, now) {
    let windowStart, windowEnd, label;
    if (/today/.test(lc))           { windowStart = new Date(now); windowStart.setHours(0,0,0,0); windowEnd = new Date(windowStart); windowEnd.setDate(windowEnd.getDate()+1); label = "today"; }
    else if (/tomorrow/.test(lc))   { windowStart = new Date(now); windowStart.setDate(windowStart.getDate()+1); windowStart.setHours(0,0,0,0); windowEnd = new Date(windowStart); windowEnd.setDate(windowEnd.getDate()+1); label = "tomorrow"; }
    else if (/(this week|week)/.test(lc)) { windowStart = startOfWeek(now); windowEnd = addDays(windowStart, 7); label = "this week"; }
    else                            { windowStart = new Date(now); windowStart.setHours(0,0,0,0); windowEnd = addDays(windowStart, 7); label = "the next 7 days"; }

    const slice = state.events
      .filter(e => new Date(e.end) > windowStart && new Date(e.start) < windowEnd)
      .sort((a,b) => new Date(a.start) - new Date(b.start));

    if (slice.length === 0) {
      return { reply: `Nothing scheduled for ${label}.`, created: [], updated: [], deleted: [], conflicts: [] };
    }
    const lines = slice.map(e => {
      const s = new Date(e.start), x = new Date(e.end);
      const dateStr = s.toLocaleDateString([], { weekday:"short", month:"short", day:"numeric" });
      return `· ${dateStr} ${fmtTime(s)}–${fmtTime(x)} — ${e.title}`;
    });
    return { reply: `Here's ${label}:\n${lines.join("\n")}`, created: [], updated: [], deleted: [], conflicts: [] };
  }

  // ---------- cloud LLM engine (Pollinations.ai) ----------
  async function tryCloudEngine(message, now) {
    const upcoming = state.events
      .filter(e => new Date(e.end) > addDays(now, -1) && new Date(e.start) < addDays(now, 14))
      .sort((a,b) => new Date(a.start) - new Date(b.start));

    const eventsContext = upcoming.length
      ? upcoming.map(e => `id=${e.id} | ${e.start} → ${e.end} | ${e.title} [${e.category}]`).join("\n")
      : "(no upcoming events)";

    const system = `You are SAGE, an AI scheduling assistant. Reply with a SINGLE JSON object. No prose, no markdown fences. Schema:
{"reply":"<1-2 sentence friendly reply>","actions":[
  {"op":"create","title":"...","start":"YYYY-MM-DDTHH:MM:SS","end":"YYYY-MM-DDTHH:MM:SS","category":"study|work|personal|health|social|other","priority":"low|medium|high"},
  {"op":"update","id":42,"title":"...","start":"...","end":"..."},
  {"op":"delete","id":42}
]}

CRITICAL: Scan the user's entire message — including casual storytelling and chat — for ANY mention of:
  • deadlines ("X is due …", "X by …", "have to turn in X by …")
  • appointments ("doctor on Friday", "meeting at 3")
  • tasks with times ("study X tomorrow", "gym Tuesday morning")
  • events ("birthday Saturday", "concert Friday night")
Extract EVERY such mention as a create action, even if the user didn't explicitly ask you to add it. Then acknowledge them naturally in the reply (e.g. "Got it — added your chem assignment for tomorrow night.").

For deadlines without a clear time, default to 23:59 (end of day) on that day with a 1-hour block ending at 23:59.
Default duration otherwise: 1 hour. Local times only, no timezone suffix.
If the user just chats with nothing schedule-worthy, return actions=[].`;

    const userPrompt = `Current local time: ${toIsoLocal(now)} (${now.toLocaleDateString([], { weekday:"long" })}).

Existing events:
${eventsContext}

User: ${message}`;

    const fullPrompt = `${system}\n\n${userPrompt}\n\nRespond with the JSON object only.`;
    const url = `https://text.pollinations.ai/${encodeURIComponent(fullPrompt)}?model=openai-fast&json=true`;

    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 30000);
    let raw;
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      raw = await res.text();
    } catch (e) {
      clearTimeout(timeout);
      return { ok: false, error: e.message || "network error" };
    }

    // Pollinations returns its own error envelopes as JSON; detect them.
    if (raw.includes('"error"') && raw.includes('"status"')) {
      try {
        const e = JSON.parse(raw);
        if (e.error) return { ok: false, error: e.error };
      } catch { /* fall through */ }
    }

    const parsed = extractJson(raw);
    if (!parsed) return { ok: false, error: "could not parse AI response" };
    return { ok: true, parsed };
  }

  function extractJson(text) {
    if (!text) return null;
    text = text.trim();
    // Strip code fences if present
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
    try { return JSON.parse(text); } catch { /* fall through */ }
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch { return null; } }
    return null;
  }

  function applyCloudActions(parsed) {
    const created = [], updated = [], deleted = [], conflicts = [];
    const actions = parsed.actions || [];

    for (const a of actions) {
      const op = (a.op || "").toLowerCase();
      try {
        if (op === "create") {
          if (!a.start) continue;
          let end = a.end;
          if (!end) {
            const s = new Date(a.start);
            end = toIsoLocal(new Date(s.getTime() + 3600_000));
          }
          const result = addEvent({
            title: a.title, description: a.description || "",
            start: a.start, end,
            category: a.category, priority: a.priority,
          });
          created.push(result.event);
          result.conflicts.forEach(c => conflicts.push(`"${result.event.title}" overlaps with "${c.title}"`));
        } else if (op === "update" && a.id != null) {
          const patch = {};
          ["title","description","start","end","category","priority"].forEach(k => {
            if (a[k] != null) patch[k] = a[k];
          });
          const updEv = updateEvent(Number(a.id), patch);
          if (updEv) updated.push(updEv);
        } else if (op === "delete" && a.id != null) {
          if (deleteEvent(Number(a.id))) deleted.push(Number(a.id));
        }
      } catch (e) {
        console.warn("action failed", a, e);
      }
    }

    return { reply: parsed.reply || "Done.", created, updated, deleted, conflicts };
  }

  // ---------- chat orchestration ----------
  async function handleMessage(text) {
    const now = new Date();

    // Always try cloud first if we're not in confirmed-error mode
    if (state.mode !== "error") {
      const cloud = await tryCloudEngine(text, now);
      if (cloud.ok) {
        setMode("ai");
        return applyCloudActions(cloud.parsed);
      } else {
        // Demote to basic mode but allow retry next message
        setMode("basic");
        const result = basicEngine(text, now);
        result._fallbackNote = "(AI service unavailable — using basic parser)";
        return result;
      }
    }

    // Already in basic mode
    return basicEngine(text, now);
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]));
  }

  function addMessage(role, html) {
    const el = document.createElement("div");
    el.className = `message message--${role}`;
    el.innerHTML = `<div class="bubble">${html}</div>`;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  chatForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    chatInput.value = "";
    sendBtn.disabled = true;

    addMessage("user", escapeHtml(text));
    const typingEl = addMessage("bot", '<span class="typing"><span></span><span></span><span></span></span>');

    try {
      const result = await handleMessage(text);
      typingEl.querySelector(".bubble").innerHTML = escapeHtml(result.reply || "Done.");

      const summary = [];
      if (result.created?.length) summary.push(`✓ added ${result.created.length}`);
      if (result.updated?.length) summary.push(`↻ updated ${result.updated.length}`);
      if (result.deleted?.length) summary.push(`✗ removed ${result.deleted.length}`);
      if (result._fallbackNote) summary.push(result._fallbackNote);
      if (summary.length) {
        const sysEl = document.createElement("div");
        sysEl.className = "message message--system";
        sysEl.innerHTML = `<div class="bubble">${escapeHtml(summary.join(" · "))}</div>`;
        messagesEl.appendChild(sysEl);
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
      if (result.conflicts?.length) {
        result.conflicts.forEach(c => toast(c, "warn"));
      }
    } catch (err) {
      typingEl.querySelector(".bubble").innerHTML =
        `<span style="color:var(--danger)">Error: ${escapeHtml(err.message || String(err))}</span>`;
    } finally {
      sendBtn.disabled = false;
      chatInput.focus();
    }
  });

  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      chatForm.requestSubmit();
    }
  });

  // ---------- calendar rendering ----------
  function computeOverloadedDays() {
    const byDay = {};
    state.events.forEach(e => {
      const key = new Date(e.start).toISOString().slice(0,10);
      const hrs = (new Date(e.end) - new Date(e.start)) / 3600_000;
      byDay[key] = (byDay[key] || 0) + hrs;
    });
    return new Set(Object.entries(byDay).filter(([,h]) => h >= 10).map(([k]) => k));
  }

  function renderCalendar() {
    calendarEl.innerHTML = "";
    const weekEnd = addDays(state.weekStart, 6);
    weekTitle.textContent = fmtDateRange(state.weekStart, weekEnd);
    const today = new Date();
    const overloaded = computeOverloadedDays();

    for (let i = 0; i < 7; i++) {
      const date = addDays(state.weekStart, i);
      const dayEvents = state.events
        .filter(ev => sameDay(new Date(ev.start), date))
        .sort((a,b) => new Date(a.start) - new Date(b.start));

      const dayEl = document.createElement("div");
      dayEl.className = "day";
      if (sameDay(date, today)) dayEl.classList.add("day--today");
      const dayKey = date.toISOString().slice(0,10);
      if (overloaded.has(dayKey)) dayEl.classList.add("day--overloaded");

      dayEl.innerHTML = `
        <div class="day-header">
          <span class="day-name">${date.toLocaleDateString([], { weekday:"short" })}</span>
          <span class="day-num">${date.getDate()}</span>
        </div>
      `;

      dayEvents.forEach(ev => {
        const evEl = document.createElement("div");
        evEl.className = `event event--${ev.category} event--${ev.priority}`;
        const s = new Date(ev.start), x = new Date(ev.end);
        evEl.innerHTML = `
          <div class="event-title">${escapeHtml(ev.title)}</div>
          <div class="event-time">${fmtTime(s)} – ${fmtTime(x)}</div>
        `;
        evEl.addEventListener("click", () => openModal(ev));
        dayEl.appendChild(evEl);
      });

      calendarEl.appendChild(dayEl);
    }
  }

  function openModal(ev) {
    const existing = document.querySelector(".modal-backdrop");
    if (existing) existing.remove();
    const s = new Date(ev.start), x = new Date(ev.end);
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop modal-backdrop--show";
    backdrop.innerHTML = `
      <div class="modal">
        <h3>${escapeHtml(ev.title)}</h3>
        <div class="meta">
          ${s.toLocaleString()} → ${x.toLocaleString()}<br>
          ${ev.category} · ${ev.priority} priority
        </div>
        <div class="desc">${escapeHtml(ev.description || "(no description)")}</div>
        <div class="modal-actions">
          <button class="btn" data-act="close">Close</button>
          <button class="btn btn--danger" data-act="delete">Delete</button>
        </div>
      </div>
    `;
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.remove(); });
    backdrop.querySelector('[data-act="close"]').addEventListener("click", () => backdrop.remove());
    backdrop.querySelector('[data-act="delete"]').addEventListener("click", () => {
      deleteEvent(ev.id);
      toast(`Removed "${ev.title}"`, "ok");
      backdrop.remove();
    });
    document.body.appendChild(backdrop);
  }

  $("prev-week").addEventListener("click", () => { state.weekStart = addDays(state.weekStart, -7); renderCalendar(); });
  $("next-week").addEventListener("click", () => { state.weekStart = addDays(state.weekStart,  7); renderCalendar(); });
  $("today-btn").addEventListener("click", () => { state.weekStart = startOfWeek(new Date()); renderCalendar(); });

  $("reset-btn").addEventListener("click", () => {
    if (state.events.length === 0) { toast("Already empty", "ok"); return; }
    if (!confirm(`Clear all ${state.events.length} events from this browser?`)) return;
    state.events = [];
    state.nextId = 1;
    saveEvents();
    renderCalendar();
    toast("All events cleared", "ok");
  });

  // ---------- voice: Web Speech API (STT + TTS) ----------
  // Single-message dictation + full call-mode loop (listen → respond → speak → repeat).
  const SR_CLASS = window.SpeechRecognition || window.webkitSpeechRecognition;
  const TTS = window.speechSynthesis;
  const voice = {
    supported: !!SR_CLASS && !!TTS,
    rec: null,             // active SpeechRecognition instance
    isListening: false,
    isSpeaking: false,
    inCall: false,
    muted: false,
    finalChunks: [],       // accumulated finalized transcripts during one listen
    interimChunk: "",
    silenceTimer: null,    // detects "you stopped talking, time to send"
    target: "input",       // "input" (write to textarea) | "call" (handle inline)
    preferredVoice: null,
  };

  // Pick a pleasant voice if available
  function pickVoice() {
    if (!TTS) return null;
    const voices = TTS.getVoices() || [];
    if (!voices.length) return null;
    const lang = (navigator.language || "en-US").toLowerCase();
    const score = (v) => {
      let s = 0;
      const name = (v.name || "").toLowerCase();
      const vlang = (v.lang || "").toLowerCase();
      if (vlang.startsWith(lang.slice(0,2))) s += 10;
      if (vlang === lang) s += 5;
      // macOS Siri-style voices are higher quality
      if (/samantha|alex|karen|moira|tessa|daniel|google.*female/.test(name)) s += 8;
      if (/google/.test(name)) s += 4;
      if (v.localService) s += 2;
      return s;
    };
    return voices.slice().sort((a,b) => score(b) - score(a))[0] || voices[0];
  }
  // Voices load asynchronously in Chrome
  if (TTS) {
    voice.preferredVoice = pickVoice();
    TTS.addEventListener("voiceschanged", () => { voice.preferredVoice = pickVoice(); });
  }

  function buildRecognition(opts = {}) {
    if (!SR_CLASS) return null;
    const r = new SR_CLASS();
    r.lang = navigator.language || "en-US";
    r.interimResults = true;
    r.continuous = !!opts.continuous;   // call mode: true; single dictation: false
    r.maxAlternatives = 1;
    return r;
  }

  function startListening(target) {
    if (!voice.supported) {
      toast("Voice input isn't supported in this browser. Try Chrome, Edge, or Safari.", "err");
      return false;
    }
    if (voice.isListening) return true;
    // Don't listen while we're speaking — would just re-hear the bot's voice
    if (voice.isSpeaking) return false;

    voice.target = target;
    voice.finalChunks = [];
    voice.interimChunk = "";
    voice.rec = buildRecognition({ continuous: target === "call" });
    if (!voice.rec) return false;

    voice.rec.onstart = () => {
      voice.isListening = true;
      if (target === "input") {
        $("mic-btn").classList.add("icon-btn--listening");
        $("mic-btn").title = "Listening… click to stop";
      } else {
        setCallUI("listening", "Listening…");
      }
    };
    voice.rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) voice.finalChunks.push(r[0].transcript.trim());
        else interim += r[0].transcript;
      }
      voice.interimChunk = interim;

      const live = (voice.finalChunks.join(" ") + " " + interim).trim();
      if (target === "input") {
        chatInput.value = live;
      } else {
        $("call-transcript").textContent = live ? `"${live}"` : "";
        // In call mode, debounce on silence to send.
        // 2.5s gives breathing room mid-story without feeling laggy.
        if (voice.silenceTimer) clearTimeout(voice.silenceTimer);
        if (live) {
          voice.silenceTimer = setTimeout(() => commitCallUtterance(), 2500);
        }
      }
    };
    voice.rec.onerror = (e) => {
      console.warn("speech error", e.error);
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        toast("Microphone permission denied.", "err");
        if (voice.inCall) endCall();
      } else if (e.error === "no-speech") {
        // Common in call mode; ignored, onend will restart.
      } else if (e.error === "audio-capture") {
        toast("No microphone found.", "err");
        if (voice.inCall) endCall();
      }
    };
    voice.rec.onend = () => {
      voice.isListening = false;
      $("mic-btn").classList.remove("icon-btn--listening");
      $("mic-btn").title = "Dictate a message (click and speak)";

      if (target === "input") {
        // Single dictation: just leave the text in the input. User clicks Send.
        return;
      }

      // Call mode: if we still have an unsent utterance, commit it
      if (voice.inCall) {
        const live = (voice.finalChunks.join(" ") + " " + voice.interimChunk).trim();
        if (live && !voice.isSpeaking) {
          commitCallUtterance();
        } else if (!voice.isSpeaking && !voice.muted) {
          // restart listening
          setTimeout(() => { if (voice.inCall && !voice.muted) startListening("call"); }, 250);
        }
      }
    };

    try {
      voice.rec.start();
      return true;
    } catch (err) {
      console.warn("rec start failed", err);
      return false;
    }
  }

  function stopListening() {
    if (voice.rec && voice.isListening) {
      try { voice.rec.stop(); } catch {}
    }
  }

  function ensureVoicesLoaded() {
    return new Promise((resolve) => {
      if (!TTS) return resolve([]);
      let voices = TTS.getVoices();
      if (voices.length) return resolve(voices);
      let settled = false;
      const onChange = () => {
        if (settled) return;
        settled = true;
        TTS.removeEventListener("voiceschanged", onChange);
        resolve(TTS.getVoices());
      };
      TTS.addEventListener("voiceschanged", onChange);
      // Fallback: some browsers never fire voiceschanged; resolve after timeout
      setTimeout(() => {
        if (settled) return;
        settled = true;
        TTS.removeEventListener("voiceschanged", onChange);
        resolve(TTS.getVoices());
      }, 800);
    });
  }

  function speak(text, onDone) {
    if (!TTS || !text) { onDone && onDone(); return; }

    ensureVoicesLoaded().then(() => {
      if (!voice.preferredVoice) voice.preferredVoice = pickVoice();
      // Only cancel if something's actively speaking — calling cancel() and
      // then speak() back-to-back in Chrome can silently drop the new utterance.
      if (TTS.speaking || TTS.pending) {
        try { TTS.cancel(); } catch {}
      }

      const utt = new SpeechSynthesisUtterance(text);
      if (voice.preferredVoice) utt.voice = voice.preferredVoice;
      utt.rate = 1.05;
      utt.pitch = 1.0;
      utt.volume = 1.0;

      let started = false;
      let finished = false;
      let keepAlive = null;

      const finish = (reason) => {
        if (finished) return;
        finished = true;
        voice.isSpeaking = false;
        if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
        if (!started && reason === "watchdog") {
          console.warn("[SAGE] TTS never started — check tab audio / system volume / available voices", {
            voices: TTS.getVoices().length,
            picked: voice.preferredVoice && voice.preferredVoice.name,
          });
          toast("Couldn't play voice. Check tab isn't muted and system volume is up.", "err");
        }
        onDone && onDone();
      };

      utt.onstart = () => {
        started = true;
        voice.isSpeaking = true;
        if (voice.inCall) setCallUI("speaking", "SAGE is speaking…");
      };
      utt.onend = () => finish("end");
      utt.onerror = (e) => {
        console.warn("[SAGE] TTS error:", e.error || e);
        finish("error");
      };

      // Chrome bug: long utterances pause after ~15s. Periodic pause+resume keeps audio flowing.
      keepAlive = setInterval(() => {
        if (finished) { clearInterval(keepAlive); keepAlive = null; return; }
        if (TTS.speaking) {
          try { TTS.pause(); TTS.resume(); } catch {}
        }
      }, 10000);

      // Watchdog: if speech never actually starts, don't hang the call loop forever
      setTimeout(() => { if (!started) finish("watchdog"); }, 4000);

      try {
        // Microscopic delay: in some Chrome builds, speak() immediately after a
        // cancel() in the same tick is dropped. A 0ms setTimeout schedules it
        // on the next event loop tick which avoids the race.
        setTimeout(() => {
          if (!finished) TTS.speak(utt);
        }, 30);
      } catch (err) {
        console.error("[SAGE] TTS.speak threw:", err);
        finish("throw");
      }
    });
  }

  // ---------- single-message dictation ----------
  $("mic-btn").addEventListener("click", () => {
    if (!voice.supported) {
      toast("Voice input isn't supported in this browser. Try Chrome, Edge, or Safari.", "err");
      return;
    }
    if (voice.isListening && voice.target === "input") {
      stopListening();
    } else {
      startListening("input");
    }
  });

  // ---------- call mode ----------
  function setCallUI(stateName, statusText) {
    const orb = $("call-orb");
    orb.classList.remove("call-orb--listening","call-orb--thinking","call-orb--speaking");
    if (stateName) orb.classList.add(`call-orb--${stateName}`);
    const st = $("call-status");
    st.className = "call-status" + (stateName ? ` call-status--${stateName}` : "");
    st.textContent = statusText;
  }

  function startCall() {
    if (!voice.supported) {
      toast("Voice calls need Chrome, Edge, or Safari (and a microphone).", "err");
      return;
    }
    voice.inCall = true;
    voice.muted = false;
    $("call-mute").classList.remove("muted");
    $("call-overlay").classList.add("call-overlay--show");
    $("call-overlay").setAttribute("aria-hidden", "false");
    $("call-transcript").textContent = "";
    setCallUI("speaking", "SAGE is connecting…");
    // Greet then start listening
    speak("Hi! I'm SAGE. Tell me what you need to schedule.", () => {
      if (voice.inCall && !voice.muted) startListening("call");
    });
  }

  function endCall() {
    voice.inCall = false;
    if (voice.silenceTimer) { clearTimeout(voice.silenceTimer); voice.silenceTimer = null; }
    stopListening();
    if (TTS) TTS.cancel();
    voice.isSpeaking = false;
    $("call-overlay").classList.remove("call-overlay--show");
    $("call-overlay").setAttribute("aria-hidden", "true");
    $("call-transcript").textContent = "";
  }

  async function commitCallUtterance() {
    if (!voice.inCall) return;
    if (voice.silenceTimer) { clearTimeout(voice.silenceTimer); voice.silenceTimer = null; }
    const text = (voice.finalChunks.join(" ") + " " + voice.interimChunk).trim();
    if (!text) {
      if (!voice.muted) startListening("call");
      return;
    }
    voice.finalChunks = [];
    voice.interimChunk = "";
    stopListening();

    // Log into the chat transcript too
    addMessage("user", escapeHtml(text));
    setCallUI("thinking", "Thinking…");

    let result;
    try {
      result = await handleMessage(text);
    } catch (e) {
      result = { reply: "Sorry, something went wrong.", created: [], updated: [], deleted: [], conflicts: [] };
    }
    addMessage("bot", escapeHtml(result.reply || "Done."));
    if (result.conflicts?.length) {
      result.conflicts.forEach(c => toast(c, "warn"));
    }
    // Flash each captured event in the call overlay so the user sees it
    // get added in real-time while they're still on the call.
    (result.created || []).forEach(e => {
      const when = new Date(e.start).toLocaleString([], { weekday:"short", month:"short", day:"numeric", hour:"numeric", minute:"2-digit" });
      flashCapture(`${e.title} — ${when}`);
    });

    if (!voice.inCall) return;  // user may have hung up
    speak(result.reply || "Done.", () => {
      if (voice.inCall && !voice.muted) startListening("call");
    });
  }

  function flashCapture(text) {
    const box = $("call-captures");
    if (!box) return;
    const chip = document.createElement("div");
    chip.className = "capture-chip";
    chip.textContent = "✓ " + text;
    box.appendChild(chip);
    // Auto-clean after the CSS exit animation finishes (chip-out delays 5s)
    setTimeout(() => chip.remove(), 5800);
  }

  // Test voice button — verifies TTS in isolation
  const testVoiceBtn = $("test-voice-btn");
  if (testVoiceBtn) {
    testVoiceBtn.addEventListener("click", () => {
      if (!TTS) {
        toast("Your browser doesn't support speech output.", "err");
        return;
      }
      testVoiceBtn.disabled = true;
      const orig = testVoiceBtn.textContent;
      testVoiceBtn.textContent = "🔊 Testing…";
      speak("Hi, I'm SAGE. If you can hear me, voice output is working.", () => {
        testVoiceBtn.disabled = false;
        testVoiceBtn.textContent = orig;
      });
    });
  }

  $("call-btn").addEventListener("click", startCall);
  $("call-end").addEventListener("click", endCall);
  $("call-mute").addEventListener("click", () => {
    voice.muted = !voice.muted;
    const btn = $("call-mute");
    btn.classList.toggle("muted", voice.muted);
    if (voice.muted) {
      if (voice.silenceTimer) { clearTimeout(voice.silenceTimer); voice.silenceTimer = null; }
      stopListening();
      setCallUI(null, "Muted — tap mic to resume");
    } else if (voice.inCall && !voice.isSpeaking) {
      startListening("call");
    }
  });

  // Disable voice UI if unsupported
  if (!voice.supported) {
    const mb = $("mic-btn"); if (mb) { mb.disabled = true; mb.title = "Voice not supported in this browser"; }
    const cb = $("call-btn"); if (cb) { cb.disabled = true; cb.title = "Voice calls need Chrome, Edge, or Safari"; }
  }

  // ---------- startup: ping cloud to set initial mode ----------
  (async function probeCloud() {
    setMode("loading");
    try {
      const res = await fetch("https://text.pollinations.ai/ping?model=openai-fast", {
        signal: AbortSignal.timeout(8000)
      });
      const txt = await res.text();
      if (res.ok && !txt.includes('"error"')) setMode("ai");
      else setMode("basic");
    } catch {
      setMode("basic");
    }
  })();

  renderCalendar();
})();
