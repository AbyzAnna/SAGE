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

    // Parse dates with chrono
    const results = window.chrono ? window.chrono.parse(message, now, { forwardDate: true }) : [];
    if (results.length === 0) {
      return {
        reply: "I couldn't pick out a time from that. Try something like 'study math tomorrow 2-4pm' or 'dentist Thursday at 3pm'.",
        created: [], updated: [], deleted: [], conflicts: []
      };
    }

    const created = [];
    const allConflicts = [];

    for (const r of results) {
      const start = r.start ? r.start.date() : null;
      let end = r.end ? r.end.date() : null;
      if (!start) continue;
      if (!end) {
        end = new Date(start);
        end.setHours(end.getHours() + 1);
      }
      if (end <= start) end = new Date(start.getTime() + 3600_000);

      // Build title by stripping the matched date phrase
      let title = (message.slice(0, r.index) + " " + message.slice(r.index + r.text.length)).trim();
      title = title.replace(/^(add|schedule|book|create|put in|block out|set up|plan)\s+/i, "")
                   .replace(/^(an?|the|my)\s+/i, "")
                   .replace(/^for\s+/i, "")
                   .replace(/\s+(for|on|at|to|from)$/i, "")
                   .replace(/\s+/g, " ")
                   .trim();
      if (!title) title = "Event";
      title = title[0].toUpperCase() + title.slice(1);

      const category = classifyCategory(title);
      const priority = classifyPriority(message);

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

    const reply = created.length === 1
      ? `Added "${created[0].title}" — ${new Date(created[0].start).toLocaleString([], { dateStyle:"medium", timeStyle:"short" })}.`
      : `Added ${created.length} events to your schedule.`;

    return { reply, created, updated: [], deleted: [], conflicts: allConflicts };
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
Default duration is 1 hour. Local times only, no timezone suffix. If user just chats or asks a question, return actions=[].`;

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
