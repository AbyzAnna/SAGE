/* SAGE — AI scheduling assistant
 * Fully client-side; persists in localStorage. Two engines:
 *   1) Pollinations.ai cloud LLM (free, keyless) — full conversational AI
 *   2) chrono-node + keyword classifier — deterministic fallback (always available)
 * Use ?engine=basic to force the deterministic engine (used by E2E tests).
 */
(() => {
  // ---------- state ----------
  const LS_EVENTS = "sage.events.v1";
  const LS_NOTIFY = "sage.notify.v1";

  const state = {
    events: loadEvents(),
    weekStart: startOfWeek(new Date()),
    viewMode: "week",          // "week" | "day"
    selectedDay: startOfDay(new Date()),
    searchQuery: "",
    mode: "loading",
    nextId: nextIdFrom(loadEvents()),
    notifyEnabled: localStorage.getItem(LS_NOTIFY) === "1",
    _lastAddedIds: null,
    _undoStack: [],            // each entry: { label, restore: fn }
    _scheduledNotifs: new Map(),// id → timeoutId
  };

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const messagesEl = $("messages");
  const chatForm = $("chat-form");
  const chatInput = $("chat-input");
  const sendBtn = $("send-btn");
  const calendarEl = $("calendar");
  const weekTitle = $("week-title");
  const todayPanel = $("today-panel");
  const modeDot = $("mode-dot");
  const modeText = $("mode-text");
  const toastEl = $("toast");
  const searchInput = $("search-input");
  const notifyBtn = $("notify-btn");

  // ---------- date helpers ----------
  function startOfDay(d) {
    const x = new Date(d); x.setHours(0,0,0,0); return x;
  }
  function startOfWeek(d) {
    const x = startOfDay(d);
    x.setDate(x.getDate() - x.getDay());
    return x;
  }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() &&
           a.getMonth()    === b.getMonth() &&
           a.getDate()     === b.getDate();
  }
  function fmtTime(d) { return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }
  function fmtDateRange(start, end) {
    const opts = { month: "short", day: "numeric" };
    return `${start.toLocaleDateString([], opts)} – ${end.toLocaleDateString([], opts)}`;
  }
  function toIsoLocal(d) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
  }
  function fromIsoLocal(s) {
    // Treat as local time; new Date(string) handles "YYYY-MM-DDTHH:MM:SS" as local.
    return new Date(s);
  }
  function humanDuration(ms) {
    if (ms < 0) return "now";
    const m = Math.round(ms / 60000);
    if (m < 1) return "now";
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60); const rm = m % 60;
    return rm ? `${h}h ${rm}m` : `${h}h`;
  }

  // ---------- storage ----------
  function loadEvents() {
    try { const raw = localStorage.getItem(LS_EVENTS); return raw ? JSON.parse(raw) : []; }
    catch { return []; }
  }
  function saveEvents() { localStorage.setItem(LS_EVENTS, JSON.stringify(state.events)); }
  function nextIdFrom(events) { return (events.reduce((m, e) => Math.max(m, e.id || 0), 0)) + 1; }

  // ---------- toast (supports an action button for Undo) ----------
  let toastTimer;
  function toast(msg, kind = "ok", action = null) {
    clearTimeout(toastTimer);
    toastEl.innerHTML = "";
    const span = document.createElement("span");
    span.textContent = msg;
    toastEl.appendChild(span);
    if (action) {
      const btn = document.createElement("button");
      btn.className = "toast-action";
      btn.textContent = action.label;
      btn.addEventListener("click", () => { action.onClick(); toastEl.className = "toast"; });
      toastEl.appendChild(btn);
    }
    toastEl.classList.remove("toast--ok","toast--warn","toast--err");
    toastEl.className = `toast toast--show toast--${kind}`;
    const dur = action ? 6000 : 3200;
    toastTimer = setTimeout(() => { toastEl.className = "toast"; }, dur);
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

  // ---------- categorization ----------
  const CATEGORY_KEYWORDS = {
    study:    ["study","homework","exam","essay","read","chapter","review","quiz","calc","calculus","math","chem","bio","history","english","lecture","class","assignment","paper","project"],
    work:     ["meeting","work","standup","sync","1:1","email","call","client","deadline","report","ship","deploy","interview","presentation","conference"],
    health:   ["doctor","dentist","gym","workout","run","jog","yoga","therapy","appointment","hospital","clinic","walk","yoga","pilates","stretch"],
    social:   ["party","dinner","lunch","brunch","drink","drinks","date","mom","dad","family","friends","birthday","wedding","movie","concert","show","game"],
    personal: ["chore","laundry","grocery","groceries","clean","shopping","cook","errand","haircut","break","rest","sleep","nap"],
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
      return fromIsoLocal(candidate.start) < fromIsoLocal(e.end) &&
             fromIsoLocal(e.start) < fromIsoLocal(candidate.end);
    });
  }

  // ---------- CRUD + undo ----------
  function pushUndo(label, restore) {
    state._undoStack.push({ label, restore });
    if (state._undoStack.length > 20) state._undoStack.shift();
  }
  function consumeUndo() {
    const u = state._undoStack.pop();
    if (!u) return false;
    u.restore();
    saveEvents();
    rescheduleAllNotifications();
    renderAll();
    toast(`Restored: ${u.label}`, "ok");
    return true;
  }

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
    if (!state._lastAddedIds) state._lastAddedIds = new Set();
    state._lastAddedIds.add(ev.id);
    saveEvents();
    scheduleNotification(ev);
    // Auto-navigate so the user sees what just got added
    const eventWeek = startOfWeek(fromIsoLocal(ev.start));
    if (state.viewMode === "week" && eventWeek.getTime() !== state.weekStart.getTime()) {
      state.weekStart = eventWeek;
    }
    if (state.viewMode === "day") state.selectedDay = startOfDay(fromIsoLocal(ev.start));
    renderAll();
    return { event: ev, conflicts };
  }

  function deleteEvent(id, opts = {}) {
    const i = state.events.findIndex(e => e.id === id);
    if (i === -1) return false;
    const removed = state.events.splice(i, 1)[0];
    cancelNotification(removed.id);
    saveEvents();
    renderAll();
    if (!opts.silent) {
      pushUndo(removed.title, () => { state.events.push(removed); });
      toast(`Removed "${removed.title}"`, "ok", {
        label: "Undo",
        onClick: () => consumeUndo(),
      });
    }
    return true;
  }

  function updateEvent(id, patch) {
    const ev = state.events.find(e => e.id === id);
    if (!ev) return null;
    const previous = { ...ev };
    Object.assign(ev, patch);
    saveEvents();
    cancelNotification(ev.id);
    scheduleNotification(ev);
    pushUndo(`Edit "${ev.title}"`, () => {
      const current = state.events.find(e => e.id === id);
      if (current) Object.assign(current, previous);
    });
    renderAll();
    return ev;
  }

  // ---------- deterministic fallback engine ----------
  function basicEngine(message, now) {
    const lc = message.toLowerCase().trim();

    if (/^(what(?:'s| is)|show|list|tell me about)\s/.test(lc)) return queryReply(lc, now);

    // Find-free-time intent
    if (/(find|when|got|have).*(free|open|gap)/i.test(lc) || /^free time/i.test(lc)) {
      return findFreeTimeReply(message, now);
    }

    const delMatch = lc.match(/^(delete|cancel|remove|drop)\s+(.+)/);
    if (delMatch) {
      const term = delMatch[2].replace(/^my\s+/, "").trim();
      const found = state.events.find(e => e.title.toLowerCase().includes(term.split(" ")[0]));
      if (found) {
        const t = found.title;
        deleteEvent(found.id, { silent: true });
        return { reply: `Removed "${t}".`, created: [], updated: [], deleted: [found.id], conflicts: [] };
      }
      return { reply: `I couldn't find an event matching "${term}".`, created: [], updated: [], deleted: [], conflicts: [] };
    }

    const results = window.chrono ? window.chrono.parse(message, now, { forwardDate: true }) : [];
    if (results.length === 0) {
      return { reply: "Got it. Tell me an event with a time and I'll add it.", created: [], updated: [], deleted: [], conflicts: [] };
    }

    const created = [];
    const allConflicts = [];
    for (const r of results) {
      const start = r.start ? r.start.date() : null;
      let end = r.end ? r.end.date() : null;
      if (!start) continue;
      if (start.getTime() < now.getTime() - 60_000) continue;

      const before = message.slice(Math.max(0, r.index - 40), r.index).toLowerCase();
      const isDeadline = /(\b(is\s+)?due\s*$|\bby\s*$|\bdeadline\s*$|\bturn\s+in.*$|\bsubmit.*$)/.test(before);
      if (isDeadline && (!r.start.isCertain || !r.start.isCertain("hour"))) start.setHours(23, 0, 0, 0);
      if (!end) { end = new Date(start); end.setHours(end.getHours() + 1); }
      if (end <= start) end = new Date(start.getTime() + 3600_000);

      let title = extractTitleAround(message, r.index, r.text.length, isDeadline) || "Event";
      const category = classifyCategory(title + " " + message);
      const priority = isDeadline ? "high" : classifyPriority(message);

      const result = addEvent({
        title,
        start: toIsoLocal(start),
        end: toIsoLocal(end),
        category, priority,
      });
      created.push(result.event);
      result.conflicts.forEach(c => allConflicts.push(`"${title}" overlaps with "${c.title}"`));
    }

    const reply = created.length === 1
      ? `Got it — added "${created[0].title}" for ${fromIsoLocal(created[0].start).toLocaleString([], { dateStyle:"medium", timeStyle:"short" })}.`
      : created.length > 1
        ? `Added ${created.length} things: ${created.map(e => `"${e.title}"`).join(", ")}.`
        : "Got it.";
    return { reply, created, updated: [], deleted: [], conflicts: allConflicts };
  }

  function extractTitleAround(message, dateIndex, dateLen, isDeadline) {
    const before = message.slice(0, dateIndex);
    const after  = message.slice(dateIndex + dateLen);
    let beforeTrimmed = before.replace(/\s+(is|are|will\s+be|gets?|happens?)\s+(due|by|on|at|in)?\s*$/i, "")
                              .replace(/\s+(on|at|for|in)\s*$/i, "").trim();
    beforeTrimmed = beforeTrimmed
      .replace(/(?:^|\s)(?:oh\s+)?by\s+the\s+way\b/gi, "")
      .replace(/(?:^|\s)(?:and\s+)?anyway\b/gi, "")
      .replace(/(?:^|\s)you\s+know\b/gi, "")
      .replace(/(?:^|\s)i\s+mean\b/gi, "")
      .replace(/(?:^|\s)well\b/gi, "").trim();
    const beforeWords = beforeTrimmed.split(/[,.;!?]/).pop().trim().split(/\s+/);
    let candidate = beforeWords.slice(-5).join(" ");
    for (let i = 0; i < 4; i++) {
      const next = candidate.replace(/^(and|but|so|then|because|since|also|oh|hey|like|um|uh|well|actually|i|me|my|the|a|an|some|that|this|those|these|have\s+(a|an|to|the)?|got\s+(a|an|the)?|need\s+to|got\s+to|gotta|wanna)\s+/i, "");
      if (next === candidate) break;
      candidate = next;
    }
    candidate = candidate.replace(/\s+(is|are|was|were|will\s+be|gets?|happens?)\s*$/i, "").trim();
    if (!candidate || candidate.length < 3) {
      const aw = after.replace(/^[,.;!?\s]+/, "").split(/[,.;!?]/)[0].trim().split(/\s+/);
      candidate = aw.slice(0, 5).join(" ").replace(/^(for|with|about|to)\s+/i, "").trim();
    }
    candidate = candidate.replace(/^(add|schedule|book|create|put|block|set|plan)\s+(it|that|in|out|up)?\s*/i, "").trim();
    if (!candidate) return "";
    if (isDeadline && !/deadline|due/i.test(candidate)) candidate += " (deadline)";
    return candidate[0].toUpperCase() + candidate.slice(1);
  }

  function queryReply(lc, now) {
    let windowStart, windowEnd, label;
    if (/today/.test(lc))            { windowStart = startOfDay(now); windowEnd = addDays(windowStart, 1); label = "today"; }
    else if (/tomorrow/.test(lc))    { windowStart = addDays(startOfDay(now), 1); windowEnd = addDays(windowStart, 1); label = "tomorrow"; }
    else if (/(this week|week)/.test(lc)) { windowStart = startOfWeek(now); windowEnd = addDays(windowStart, 7); label = "this week"; }
    else                             { windowStart = startOfDay(now); windowEnd = addDays(windowStart, 7); label = "the next 7 days"; }
    const slice = state.events
      .filter(e => fromIsoLocal(e.end) > windowStart && fromIsoLocal(e.start) < windowEnd)
      .sort((a,b) => fromIsoLocal(a.start) - fromIsoLocal(b.start));
    if (slice.length === 0) return { reply: `Nothing scheduled for ${label}.`, created: [], updated: [], deleted: [], conflicts: [] };
    const lines = slice.map(e => {
      const s = fromIsoLocal(e.start), x = fromIsoLocal(e.end);
      return `· ${s.toLocaleDateString([], { weekday:"short", month:"short", day:"numeric" })} ${fmtTime(s)}–${fmtTime(x)} — ${e.title}`;
    });
    return { reply: `Here's ${label}:\n${lines.join("\n")}`, created: [], updated: [], deleted: [], conflicts: [] };
  }

  // ---------- free-time finder ----------
  function findFreeTimeReply(message, now) {
    // Parse duration ("2 hours", "30 minutes", default 1h)
    const dm = message.match(/(\d+(?:\.\d+)?)\s*(h|hr|hour|hours)\b/i);
    const dmMin = message.match(/(\d+)\s*(min|minute|minutes)\b/i);
    let durMin = 60;
    if (dm) durMin = Math.round(parseFloat(dm[1]) * 60);
    else if (dmMin) durMin = parseInt(dmMin[1]);

    // Window: next 7 days by default, or "tomorrow" / "today" etc.
    let windowStart = new Date(now), windowEnd = addDays(now, 7), label = "this week";
    if (/today/i.test(message))     { windowStart = new Date(now); windowEnd = addDays(startOfDay(now), 1); label = "today"; }
    else if (/tomorrow/i.test(message)) { windowStart = addDays(startOfDay(now), 1); windowEnd = addDays(windowStart, 1); label = "tomorrow"; }
    else if (/(next week)/i.test(message)) { windowStart = addDays(startOfWeek(now), 7); windowEnd = addDays(windowStart, 7); label = "next week"; }

    // Working hours: 8am to 10pm
    const slots = findFreeSlots(windowStart, windowEnd, durMin, 8, 22);
    if (!slots.length) {
      return {
        reply: `I couldn't find ${durMin}m of free time ${label} between 8am and 10pm. Your calendar is packed.`,
        created: [], updated: [], deleted: [], conflicts: [],
      };
    }
    const top = slots.slice(0, 5);
    const lines = top.map(s => {
      const day = s.start.toLocaleDateString([], { weekday:"short", month:"short", day:"numeric" });
      return `· ${day}, ${fmtTime(s.start)} – ${fmtTime(s.end)}`;
    });
    return {
      reply: `Found ${slots.length} free slot${slots.length > 1 ? "s" : ""} of ${durMin}m+ ${label}:\n${lines.join("\n")}`,
      created: [], updated: [], deleted: [], conflicts: [],
    };
  }

  function findFreeSlots(windowStart, windowEnd, minMinutes, dayStartHour, dayEndHour) {
    const slots = [];
    const ws = +windowStart, we = +windowEnd;
    // Walk day by day
    let cursor = startOfDay(windowStart);
    while (+cursor < we) {
      const dayStart = new Date(cursor); dayStart.setHours(dayStartHour, 0, 0, 0);
      const dayEnd   = new Date(cursor); dayEnd.setHours(dayEndHour,   0, 0, 0);
      const eff = new Date(Math.max(+dayStart, ws));
      const cap = new Date(Math.min(+dayEnd,   we));
      if (+eff >= +cap) { cursor = addDays(cursor, 1); continue; }

      const dayEvents = state.events
        .map(e => ({ s: fromIsoLocal(e.start), e: fromIsoLocal(e.end), title: e.title }))
        .filter(e => e.e > eff && e.s < cap)
        .sort((a,b) => a.s - b.s);

      let pointer = eff;
      for (const ev of dayEvents) {
        if (ev.s > pointer) {
          const gap = (ev.s - pointer) / 60000;
          if (gap >= minMinutes) {
            slots.push({ start: new Date(pointer), end: new Date(ev.s) });
          }
        }
        if (ev.e > pointer) pointer = ev.e;
      }
      if (cap > pointer) {
        const gap = (cap - pointer) / 60000;
        if (gap >= minMinutes) slots.push({ start: new Date(pointer), end: new Date(cap) });
      }
      cursor = addDays(cursor, 1);
    }
    return slots;
  }

  // ---------- cloud LLM engine ----------
  async function tryCloudEngine(message, now) {
    const upcoming = state.events
      .filter(e => fromIsoLocal(e.end) > addDays(now, -1) && fromIsoLocal(e.start) < addDays(now, 14))
      .sort((a,b) => fromIsoLocal(a.start) - fromIsoLocal(b.start));
    const eventsContext = upcoming.length
      ? upcoming.map(e => `id=${e.id} | ${e.start} → ${e.end} | ${e.title} [${e.category}]`).join("\n")
      : "(no upcoming events)";

    const system = `You are SAGE, an AI scheduling assistant. Reply with a SINGLE JSON object. No prose, no markdown fences. Schema:
{"reply":"<1-2 sentence friendly reply>","actions":[
  {"op":"create","title":"...","start":"YYYY-MM-DDTHH:MM:SS","end":"YYYY-MM-DDTHH:MM:SS","category":"study|work|personal|health|social|other","priority":"low|medium|high"},
  {"op":"update","id":42,"title":"...","start":"...","end":"..."},
  {"op":"delete","id":42}
]}
CRITICAL: Scan the user's entire message — including casual storytelling and chat — for ANY mention of deadlines, appointments, tasks, or events. Extract EVERY such mention as a create action, even if the user didn't explicitly ask. For deadlines without a clear time, default to 23:00 end-of-day with a 1-hour block. Default duration otherwise: 1 hour. Local times only.
If the user asks for free time, do NOT create events — just reply with what you'd suggest.
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
    if (raw.includes('"error"') && raw.includes('"status"')) {
      try { const e = JSON.parse(raw); if (e.error) return { ok: false, error: e.error }; }
      catch { /* fall through */ }
    }
    const parsed = extractJson(raw);
    if (!parsed) return { ok: false, error: "could not parse AI response" };
    return { ok: true, parsed };
  }

  function extractJson(text) {
    if (!text) return null;
    text = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
    try { return JSON.parse(text); } catch {}
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
            const s = fromIsoLocal(a.start);
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
          ["title","description","start","end","category","priority"].forEach(k => { if (a[k] != null) patch[k] = a[k]; });
          const updEv = updateEvent(Number(a.id), patch);
          if (updEv) updated.push(updEv);
        } else if (op === "delete" && a.id != null) {
          if (deleteEvent(Number(a.id), { silent: true })) deleted.push(Number(a.id));
        }
      } catch (e) { console.warn("[SAGE] action failed", a, e); }
    }
    return { reply: parsed.reply || "Done.", created, updated, deleted, conflicts };
  }

  // ---------- chat orchestration ----------
  const FORCE_BASIC = new URLSearchParams(location.search).get("engine") === "basic";

  async function handleMessage(text) {
    const now = new Date();
    if (FORCE_BASIC) { setMode("basic"); return basicEngine(text, now); }
    if (state.mode !== "error") {
      const cloud = await tryCloudEngine(text, now);
      if (cloud.ok) { setMode("ai"); return applyCloudActions(cloud.parsed); }
      setMode("basic");
      const result = basicEngine(text, now);
      result._fallbackNote = "(AI service unavailable — using basic parser)";
      return result;
    }
    return basicEngine(text, now);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
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
      if (result.conflicts?.length) result.conflicts.forEach(c => toast(c, "warn"));
    } catch (err) {
      typingEl.querySelector(".bubble").innerHTML = `<span style="color:var(--danger)">Error: ${escapeHtml(err.message || String(err))}</span>`;
    } finally {
      sendBtn.disabled = false;
      chatInput.focus();
    }
  });
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); chatForm.requestSubmit(); }
  });

  // Starter chip clicks: prefill chat input
  document.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip[data-prompt]");
    if (!chip) return;
    chatInput.value = chip.dataset.prompt;
    chatInput.focus();
  });

  // ---------- voice (Web Speech API) ----------
  const SR_CLASS = window.SpeechRecognition || window.webkitSpeechRecognition;
  const TTS = window.speechSynthesis;
  const voice = {
    supported: !!SR_CLASS && !!TTS,
    rec: null, isListening: false, isSpeaking: false, inCall: false, muted: false,
    finalChunks: [], interimChunk: "",
    silenceTimer: null, target: "input", preferredVoice: null,
  };

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
      if (/samantha|alex|karen|moira|tessa|daniel|google.*female/.test(name)) s += 8;
      if (/google/.test(name)) s += 4;
      if (v.localService) s += 2;
      return s;
    };
    return voices.slice().sort((a,b) => score(b) - score(a))[0] || voices[0];
  }
  if (TTS) {
    voice.preferredVoice = pickVoice();
    TTS.addEventListener("voiceschanged", () => { voice.preferredVoice = pickVoice(); });
  }
  function ensureVoicesLoaded() {
    return new Promise((resolve) => {
      if (!TTS) return resolve([]);
      let voices = TTS.getVoices();
      if (voices.length) return resolve(voices);
      let settled = false;
      const onChange = () => { if (!settled) { settled = true; TTS.removeEventListener("voiceschanged", onChange); resolve(TTS.getVoices()); } };
      TTS.addEventListener("voiceschanged", onChange);
      setTimeout(() => { if (!settled) { settled = true; TTS.removeEventListener("voiceschanged", onChange); resolve(TTS.getVoices()); } }, 800);
    });
  }
  function speak(text, onDone) {
    if (!TTS || !text) { onDone && onDone(); return; }
    ensureVoicesLoaded().then(() => {
      if (!voice.preferredVoice) voice.preferredVoice = pickVoice();
      if (TTS.speaking || TTS.pending) { try { TTS.cancel(); } catch {} }
      const utt = new SpeechSynthesisUtterance(text);
      if (voice.preferredVoice) utt.voice = voice.preferredVoice;
      utt.rate = 1.05; utt.pitch = 1.0; utt.volume = 1.0;
      let started = false, finished = false, keepAlive = null;
      const finish = (reason) => {
        if (finished) return;
        finished = true; voice.isSpeaking = false;
        if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
        if (!started && reason === "watchdog") {
          console.warn("[SAGE] TTS never started — check tab audio / system volume");
          toast("Couldn't play voice. Check tab isn't muted and system volume is up.", "err");
        }
        onDone && onDone();
      };
      utt.onstart = () => { started = true; voice.isSpeaking = true; if (voice.inCall) setCallUI("speaking", "SAGE is speaking…"); };
      utt.onend = () => finish("end");
      utt.onerror = (e) => { console.warn("[SAGE] TTS error:", e.error || e); finish("error"); };
      keepAlive = setInterval(() => {
        if (finished) { clearInterval(keepAlive); keepAlive = null; return; }
        if (TTS.speaking) { try { TTS.pause(); TTS.resume(); } catch {} }
      }, 10000);
      setTimeout(() => { if (!started) finish("watchdog"); }, 4000);
      try { setTimeout(() => { if (!finished) TTS.speak(utt); }, 30); }
      catch (err) { console.error("[SAGE] TTS.speak threw:", err); finish("throw"); }
    });
  }
  function buildRecognition(opts = {}) {
    if (!SR_CLASS) return null;
    const r = new SR_CLASS();
    r.lang = navigator.language || "en-US";
    r.interimResults = true;
    r.continuous = !!opts.continuous;
    r.maxAlternatives = 1;
    return r;
  }
  function startListening(target) {
    if (!voice.supported) { toast("Voice input isn't supported in this browser.", "err"); return false; }
    if (voice.isListening) return true;
    if (voice.isSpeaking) return false;
    voice.target = target;
    voice.finalChunks = []; voice.interimChunk = "";
    voice.rec = buildRecognition({ continuous: target === "call" });
    if (!voice.rec) return false;
    voice.rec.onstart = () => {
      voice.isListening = true;
      if (target === "input") { $("mic-btn").classList.add("icon-btn--listening"); $("mic-btn").title = "Listening… click to stop"; }
      else setCallUI("listening", "Listening…");
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
      if (target === "input") chatInput.value = live;
      else {
        $("call-transcript").textContent = live ? `"${live}"` : "";
        if (voice.silenceTimer) clearTimeout(voice.silenceTimer);
        if (live) voice.silenceTimer = setTimeout(() => commitCallUtterance(), 2500);
      }
    };
    voice.rec.onerror = (e) => {
      console.warn("speech error", e.error);
      if (e.error === "not-allowed" || e.error === "service-not-allowed") { toast("Microphone permission denied.", "err"); if (voice.inCall) endCall(); }
      else if (e.error === "audio-capture") { toast("No microphone found.", "err"); if (voice.inCall) endCall(); }
    };
    voice.rec.onend = () => {
      voice.isListening = false;
      $("mic-btn").classList.remove("icon-btn--listening");
      $("mic-btn").title = "Dictate a message (click and speak)";
      if (target === "input") return;
      if (voice.inCall) {
        const live = (voice.finalChunks.join(" ") + " " + voice.interimChunk).trim();
        if (live && !voice.isSpeaking) commitCallUtterance();
        else if (!voice.isSpeaking && !voice.muted) setTimeout(() => { if (voice.inCall && !voice.muted) startListening("call"); }, 250);
      }
    };
    try { voice.rec.start(); return true; }
    catch (err) { console.warn("rec start failed", err); return false; }
  }
  function stopListening() { if (voice.rec && voice.isListening) { try { voice.rec.stop(); } catch {} } }
  function setCallUI(stateName, statusText) {
    const orb = $("call-orb");
    orb.classList.remove("call-orb--listening","call-orb--thinking","call-orb--speaking");
    if (stateName) orb.classList.add(`call-orb--${stateName}`);
    const st = $("call-status");
    st.className = "call-status" + (stateName ? ` call-status--${stateName}` : "");
    st.textContent = statusText;
  }
  function startCall() {
    if (!voice.supported) { toast("Voice calls need Chrome, Edge, or Safari.", "err"); return; }
    voice.inCall = true; voice.muted = false;
    $("call-mute").classList.remove("muted");
    $("call-overlay").classList.add("call-overlay--show");
    $("call-overlay").setAttribute("aria-hidden", "false");
    $("call-transcript").textContent = "";
    setCallUI("speaking", "SAGE is connecting…");
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
  function flashCapture(text) {
    const box = $("call-captures");
    if (!box) return;
    const chip = document.createElement("div");
    chip.className = "capture-chip";
    chip.textContent = "✓ " + text;
    box.appendChild(chip);
    setTimeout(() => chip.remove(), 5800);
  }
  async function commitCallUtterance() {
    if (!voice.inCall) return;
    if (voice.silenceTimer) { clearTimeout(voice.silenceTimer); voice.silenceTimer = null; }
    const text = (voice.finalChunks.join(" ") + " " + voice.interimChunk).trim();
    if (!text) { if (!voice.muted) startListening("call"); return; }
    voice.finalChunks = []; voice.interimChunk = "";
    stopListening();
    addMessage("user", escapeHtml(text));
    setCallUI("thinking", "Thinking…");
    let result;
    try { result = await handleMessage(text); }
    catch { result = { reply: "Sorry, something went wrong.", created: [], updated: [], deleted: [], conflicts: [] }; }
    addMessage("bot", escapeHtml(result.reply || "Done."));
    if (result.conflicts?.length) result.conflicts.forEach(c => toast(c, "warn"));
    (result.created || []).forEach(e => {
      const when = fromIsoLocal(e.start).toLocaleString([], { weekday:"short", month:"short", day:"numeric", hour:"numeric", minute:"2-digit" });
      flashCapture(`${e.title} — ${when}`);
    });
    if (!voice.inCall) return;
    speak(result.reply || "Done.", () => { if (voice.inCall && !voice.muted) startListening("call"); });
  }
  $("mic-btn").addEventListener("click", () => {
    if (!voice.supported) { toast("Voice input isn't supported in this browser.", "err"); return; }
    if (voice.isListening && voice.target === "input") stopListening();
    else startListening("input");
  });
  const testVoiceBtn = $("test-voice-btn");
  testVoiceBtn?.addEventListener("click", () => {
    if (!TTS) { toast("Your browser doesn't support speech output.", "err"); return; }
    testVoiceBtn.disabled = true;
    const orig = testVoiceBtn.textContent;
    testVoiceBtn.textContent = "🔊 Testing…";
    speak("Hi, I'm SAGE. If you can hear me, voice output is working.", () => {
      testVoiceBtn.disabled = false; testVoiceBtn.textContent = orig;
    });
  });
  $("call-btn").addEventListener("click", startCall);
  $("call-end").addEventListener("click", endCall);
  $("call-mute").addEventListener("click", () => {
    voice.muted = !voice.muted;
    $("call-mute").classList.toggle("muted", voice.muted);
    if (voice.muted) {
      if (voice.silenceTimer) { clearTimeout(voice.silenceTimer); voice.silenceTimer = null; }
      stopListening();
      setCallUI(null, "Muted — tap mic to resume");
    } else if (voice.inCall && !voice.isSpeaking) startListening("call");
  });
  if (!voice.supported) {
    $("mic-btn") && ($("mic-btn").disabled = true, $("mic-btn").title = "Voice not supported in this browser");
    $("call-btn") && ($("call-btn").disabled = true, $("call-btn").title = "Voice calls need Chrome, Edge, or Safari");
  }

  // ---------- search filter ----------
  searchInput.addEventListener("input", () => {
    state.searchQuery = searchInput.value.trim().toLowerCase();
    renderCalendar();
  });

  // ---------- rendering ----------
  function renderAll() {
    renderTodayPanel();
    renderWeekStats();
    renderCalendar();
  }

  function renderTodayPanel() {
    const now = new Date();
    const dayStart = startOfDay(now);
    const dayEnd = addDays(dayStart, 1);
    const todayEvents = state.events
      .filter(e => fromIsoLocal(e.end) > dayStart && fromIsoLocal(e.start) < dayEnd)
      .sort((a,b) => fromIsoLocal(a.start) - fromIsoLocal(b.start));

    if (!todayEvents.length) {
      todayPanel.classList.add("is-empty");
      todayPanel.innerHTML = "";
      return;
    }
    todayPanel.classList.remove("is-empty");

    const next = todayEvents.find(e => fromIsoLocal(e.end) > now) || todayEvents[todayEvents.length - 1];
    const nextStart = fromIsoLocal(next.start);
    const nextEnd = fromIsoLocal(next.end);
    const isNow = nextStart <= now && now < nextEnd;
    const countdown = isNow
      ? `now — ends ${fmtTime(nextEnd)}`
      : nextStart > now
        ? `in ${humanDuration(nextStart - now)}`
        : `ended ${humanDuration(now - nextEnd)} ago`;

    const after = todayEvents.filter(e => e.id !== next.id && fromIsoLocal(e.start) > now).slice(0, 3);

    todayPanel.innerHTML = `
      <div class="today-header">
        <span class="today-title">📅 Today</span>
        <span class="today-date">${now.toLocaleDateString([], { weekday:"long", month:"long", day:"numeric" })}</span>
      </div>
      <div class="today-next">
        <span class="dot-cat" style="background:var(--cat-${next.category})"></span>
        <strong>${isNow ? "Now:" : "Next:"}</strong>
        <span data-testid="today-next">${escapeHtml(next.title)}</span>
        <span class="countdown" data-testid="today-countdown">${countdown}</span>
      </div>
      ${after.length ? `<div class="today-row">${after.map(e => `<span><span class="dot-cat" style="background:var(--cat-${e.category})"></span>${fmtTime(fromIsoLocal(e.start))} ${escapeHtml(e.title)}</span>`).join("")}</div>` : ""}
    `;
  }

  function renderWeekStats() {
    let weekHours = 0, weekCount = 0, deadlineCount = 0;
    const weekEnd = addDays(state.weekStart, 7);
    const overloaded = computeOverloadedDays();
    for (const ev of state.events) {
      const s = fromIsoLocal(ev.start);
      if (s < state.weekStart || s >= weekEnd) continue;
      weekCount += 1;
      weekHours += (fromIsoLocal(ev.end) - s) / 3600_000;
      if (ev.priority === "high") deadlineCount += 1;
    }
    const stats = $("week-stats");
    const overloadCount = overloaded.size;
    const overloadStat = overloadCount
      ? `<span class="stat stat--warn">⚠ <strong>${overloadCount}</strong> overloaded day${overloadCount > 1 ? "s" : ""}</span>`
      : "";
    stats.innerHTML = `
      <span class="stat" data-testid="stat-count">📅 <strong>${weekCount}</strong> event${weekCount === 1 ? "" : "s"}</span>
      <span class="stat" data-testid="stat-hours">⏱ <strong>${weekHours.toFixed(1)}</strong> h scheduled</span>
      <span class="stat" data-testid="stat-deadlines">🔥 <strong>${deadlineCount}</strong> high-priority</span>
      ${overloadStat}
    `;
  }

  function computeOverloadedDays() {
    const byDay = {};
    state.events.forEach(ev => {
      const key = startOfDay(fromIsoLocal(ev.start)).toISOString().slice(0,10);
      const hrs = (fromIsoLocal(ev.end) - fromIsoLocal(ev.start)) / 3600_000;
      byDay[key] = (byDay[key] || 0) + hrs;
    });
    return new Set(Object.entries(byDay).filter(([,h]) => h >= 10).map(([k]) => k));
  }

  function eventMatchesSearch(ev) {
    if (!state.searchQuery) return null;
    const q = state.searchQuery;
    const hay = `${ev.title} ${ev.description} ${ev.category}`.toLowerCase();
    return hay.includes(q);
  }

  function renderCalendar() {
    if (state.viewMode === "week") {
      renderWeekView();
    } else {
      renderDayView();
    }
  }

  function renderWeekView() {
    calendarEl.dataset.viewMode = "week";
    calendarEl.innerHTML = "";
    const weekEnd = addDays(state.weekStart, 6);
    weekTitle.textContent = fmtDateRange(state.weekStart, weekEnd);
    const today = new Date();
    const overloaded = computeOverloadedDays();

    for (let i = 0; i < 7; i++) {
      const date = addDays(state.weekStart, i);
      const dayKey = startOfDay(date).toISOString().slice(0,10);
      const dayEvents = state.events
        .filter(ev => sameDay(fromIsoLocal(ev.start), date))
        .sort((a,b) => fromIsoLocal(a.start) - fromIsoLocal(b.start));

      const dayEl = document.createElement("div");
      dayEl.className = "day";
      dayEl.dataset.testid = `day-${dayKey}`;
      if (sameDay(date, today)) dayEl.classList.add("day--today");
      if (overloaded.has(dayKey)) dayEl.classList.add("day--overloaded");

      const header = document.createElement("div");
      header.className = "day-header";
      header.innerHTML = `
        <div>
          <div class="day-name">${date.toLocaleDateString([], { weekday:"short" })}</div>
          <div class="day-num">${date.getDate()}</div>
        </div>
        <button class="day-add" data-testid="add-${dayKey}" title="Add event to ${date.toLocaleDateString([], { weekday:"long" })}">+</button>
      `;
      header.querySelector(".day-add").addEventListener("click", (e) => {
        e.stopPropagation();
        openAddModal(date);
      });
      dayEl.appendChild(header);

      dayEvents.forEach(ev => {
        const evEl = document.createElement("div");
        const isNew = state._lastAddedIds && state._lastAddedIds.has(ev.id);
        const match = eventMatchesSearch(ev);
        let extraClass = "";
        if (isNew) extraClass += " event--new";
        if (match === true) extraClass += " event--matched";
        if (match === false) extraClass += " event--dimmed";
        evEl.className = `event event--${ev.category} event--${ev.priority}${extraClass}`;
        evEl.dataset.testid = `event-${ev.id}`;
        const s = fromIsoLocal(ev.start), x = fromIsoLocal(ev.end);
        evEl.innerHTML = `
          <div class="event-title">${escapeHtml(ev.title)}</div>
          <div class="event-time">${fmtTime(s)} – ${fmtTime(x)}</div>
        `;
        evEl.addEventListener("click", () => openModal(ev));
        dayEl.appendChild(evEl);
      });
      if (dayEvents.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty-day";
        empty.textContent = "—";
        dayEl.appendChild(empty);
      }
      calendarEl.appendChild(dayEl);
    }
    state._lastAddedIds = null;
  }

  function renderDayView() {
    calendarEl.dataset.viewMode = "day";
    calendarEl.innerHTML = "";
    const date = state.selectedDay;
    const dayKey = startOfDay(date).toISOString().slice(0,10);
    weekTitle.textContent = date.toLocaleDateString([], { weekday:"long", month:"long", day:"numeric" });
    const events = state.events
      .filter(ev => sameDay(fromIsoLocal(ev.start), date))
      .sort((a,b) => fromIsoLocal(a.start) - fromIsoLocal(b.start));

    const wrap = document.createElement("div");
    wrap.className = "day-view";
    wrap.dataset.testid = `day-view-${dayKey}`;

    const header = document.createElement("div");
    header.className = "day-view-header";
    header.innerHTML = `
      <h3 class="day-view-title">${date.toLocaleDateString([], { weekday:"long" })}, ${date.toLocaleDateString([], { month:"short", day:"numeric" })}</h3>
      <span class="day-view-sub">${events.length} event${events.length === 1 ? "" : "s"}</span>
      <button class="ghost-btn" id="day-view-add" style="margin-left:auto">+ Add event</button>
    `;
    wrap.appendChild(header);

    if (!events.length) {
      const empty = document.createElement("div");
      empty.className = "day-view-empty";
      empty.textContent = "No events on this day. Use the chat or “+ Add event” above.";
      wrap.appendChild(empty);
    } else {
      const startHour = 6, endHour = 23;
      const grid = document.createElement("div");
      grid.className = "hour-grid";
      grid.style.gridTemplateRows = `repeat(${endHour - startHour + 1}, 36px)`;
      for (let h = startHour; h <= endHour; h++) {
        const labelEl = document.createElement("div");
        labelEl.className = "hour-label";
        labelEl.textContent = h === 0 ? "12am" : h < 12 ? `${h}am` : h === 12 ? "12pm" : `${h-12}pm`;
        grid.appendChild(labelEl);

        const cellEl = document.createElement("div");
        cellEl.className = "hour-cell";
        cellEl.dataset.hour = String(h);
        const now = new Date();
        if (sameDay(date, now) && now.getHours() === h) cellEl.classList.add("now-marker");
        cellEl.addEventListener("click", () => {
          const seed = new Date(date); seed.setHours(h, 0, 0, 0);
          openAddModal(date, seed);
        });
        grid.appendChild(cellEl);
      }
      // Position events absolutely over the grid
      events.forEach(ev => {
        const s = fromIsoLocal(ev.start), x = fromIsoLocal(ev.end);
        const startMin = (s.getHours() - startHour) * 60 + s.getMinutes();
        const durMin   = Math.max(20, (x - s) / 60_000);
        if (startMin < 0 || startMin > (endHour - startHour + 1) * 60) return;
        const evEl = document.createElement("div");
        evEl.className = `day-view-event event--${ev.category} event--${ev.priority}`;
        evEl.dataset.testid = `event-${ev.id}`;
        evEl.style.top    = `${startMin * (36/60)}px`;
        evEl.style.height = `${durMin * (36/60) - 4}px`;
        evEl.innerHTML = `
          <div class="event-title">${escapeHtml(ev.title)}</div>
          <div class="event-time">${fmtTime(s)} – ${fmtTime(x)}</div>
        `;
        evEl.addEventListener("click", (e) => { e.stopPropagation(); openModal(ev); });
        grid.appendChild(evEl);
      });
      wrap.appendChild(grid);
    }
    calendarEl.appendChild(wrap);
    document.getElementById("day-view-add")?.addEventListener("click", () => openAddModal(date));
    state._lastAddedIds = null;
  }

  // ---------- view toggle ----------
  function setView(view) {
    state.viewMode = view;
    document.querySelectorAll(".seg-btn").forEach(b => {
      const active = b.dataset.view === view;
      b.classList.toggle("seg-btn--active", active);
      b.setAttribute("aria-selected", active ? "true" : "false");
    });
    if (view === "day" && !state.selectedDay) state.selectedDay = startOfDay(new Date());
    renderCalendar();
  }
  $("view-week").addEventListener("click", () => setView("week"));
  $("view-day").addEventListener("click", () => setView("day"));

  // ---------- nav ----------
  function navByPeriod(delta) {
    if (state.viewMode === "week") state.weekStart = addDays(state.weekStart, 7 * delta);
    else state.selectedDay = addDays(state.selectedDay, delta);
    renderCalendar();
  }
  $("prev-week").addEventListener("click", () => navByPeriod(-1));
  $("next-week").addEventListener("click", () => navByPeriod(+1));
  $("today-btn").addEventListener("click", () => {
    state.weekStart = startOfWeek(new Date());
    state.selectedDay = startOfDay(new Date());
    renderCalendar();
  });

  // ---------- modal (view / edit) ----------
  function openModal(ev) {
    closeModals();
    const s = fromIsoLocal(ev.start), x = fromIsoLocal(ev.end);
    const gcalUrl = buildGoogleCalendarUrl(ev);
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop modal-backdrop--show";
    backdrop.dataset.testid = "event-modal";
    backdrop.innerHTML = `
      <div class="modal">
        <div class="view-mode">
          <h3 data-testid="modal-title">${escapeHtml(ev.title)}</h3>
          <div class="meta">${s.toLocaleString()} → ${x.toLocaleString()}<br>${ev.category} · ${ev.priority} priority</div>
          <div class="modal-quick">
            <a href="${gcalUrl}" target="_blank" rel="noopener" title="Opens Google Calendar pre-filled in a new tab">➕ Google Calendar</a>
            <button data-act="download-ics" title="Downloads a .ics for Apple Calendar / Outlook">⬇️ .ics</button>
          </div>
          <div class="desc">${escapeHtml(ev.description || "(no description)")}</div>
          <div class="modal-actions">
            <button class="btn" data-act="close">Close</button>
            <button class="btn btn--danger" data-act="delete" data-testid="delete-btn">Delete</button>
            <button class="btn btn--primary" data-act="edit" data-testid="edit-btn">Edit</button>
          </div>
        </div>
        <div class="edit-mode" hidden>
          <h3>Edit event</h3>
          <div class="edit-form">
            <div class="full"><label>Title</label><input type="text" id="ef-title" data-testid="ef-title" value="${escapeHtml(ev.title)}" /></div>
            <div><label>Start</label><input type="datetime-local" id="ef-start" data-testid="ef-start" value="${ev.start.slice(0,16)}" /></div>
            <div><label>End</label><input type="datetime-local" id="ef-end" data-testid="ef-end" value="${ev.end.slice(0,16)}" /></div>
            <div>
              <label>Category</label>
              <select id="ef-category" data-testid="ef-category">
                ${["study","work","personal","health","social","other"].map(c =>
                  `<option value="${c}"${ev.category === c ? " selected" : ""}>${c}</option>`
                ).join("")}
              </select>
            </div>
            <div>
              <label>Priority</label>
              <select id="ef-priority" data-testid="ef-priority">
                ${["low","medium","high"].map(p =>
                  `<option value="${p}"${ev.priority === p ? " selected" : ""}>${p}</option>`
                ).join("")}
              </select>
            </div>
            <div class="full"><label>Description</label><input type="text" id="ef-desc" value="${escapeHtml(ev.description || "")}" /></div>
          </div>
          <div class="modal-actions">
            <button class="btn" data-act="cancel-edit">Cancel</button>
            <button class="btn btn--primary" data-act="save-edit" data-testid="save-edit-btn">Save</button>
          </div>
        </div>
      </div>
    `;
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.remove(); });

    const viewMode = backdrop.querySelector(".view-mode");
    const editMode = backdrop.querySelector(".edit-mode");

    backdrop.querySelector('[data-act="close"]').addEventListener("click", () => backdrop.remove());
    backdrop.querySelector('[data-act="delete"]').addEventListener("click", () => {
      deleteEvent(ev.id);
      backdrop.remove();
    });
    backdrop.querySelector('[data-act="download-ics"]').addEventListener("click", () => {
      downloadIcs([ev], `sage-${slugify(ev.title)}.ics`);
      toast("Downloaded — double-click to add to Apple Calendar", "ok");
    });
    backdrop.querySelector('[data-act="edit"]').addEventListener("click", () => {
      viewMode.hidden = true; editMode.hidden = false;
    });
    backdrop.querySelector('[data-act="cancel-edit"]').addEventListener("click", () => {
      viewMode.hidden = false; editMode.hidden = true;
    });
    backdrop.querySelector('[data-act="save-edit"]').addEventListener("click", () => {
      const title    = backdrop.querySelector("#ef-title").value.trim() || ev.title;
      const startVal = backdrop.querySelector("#ef-start").value;
      const endVal   = backdrop.querySelector("#ef-end").value;
      const category = backdrop.querySelector("#ef-category").value;
      const priority = backdrop.querySelector("#ef-priority").value;
      const desc     = backdrop.querySelector("#ef-desc").value;
      if (!startVal || !endVal) { toast("Start and end are required.", "warn"); return; }
      const start = `${startVal}:00`;
      const end   = `${endVal}:00`;
      if (new Date(end) <= new Date(start)) { toast("End must be after start.", "warn"); return; }
      updateEvent(ev.id, { title, start, end, category, priority, description: desc });
      toast(`Updated "${title}"`, "ok");
      backdrop.remove();
    });
    document.body.appendChild(backdrop);
  }

  // ---------- quick-add modal ----------
  function openAddModal(date, seed) {
    closeModals();
    const start = seed ? new Date(seed) : (() => {
      const d = new Date(date);
      d.setHours(new Date().getHours() + 1, 0, 0, 0);
      return d;
    })();
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    const fmtLocal = (d) => {
      const pad = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop modal-backdrop--show";
    backdrop.dataset.testid = "add-modal";
    backdrop.innerHTML = `
      <div class="modal">
        <h3>Add event</h3>
        <div class="edit-form">
          <div class="full"><label>Title</label><input type="text" id="qa-title" data-testid="qa-title" autofocus /></div>
          <div><label>Start</label><input type="datetime-local" id="qa-start" data-testid="qa-start" value="${fmtLocal(start)}" /></div>
          <div><label>End</label><input type="datetime-local" id="qa-end" data-testid="qa-end" value="${fmtLocal(end)}" /></div>
          <div><label>Category</label><select id="qa-category" data-testid="qa-category">
            ${["study","work","personal","health","social","other"].map(c => `<option value="${c}">${c}</option>`).join("")}
          </select></div>
          <div><label>Priority</label><select id="qa-priority" data-testid="qa-priority">
            ${["low","medium","high"].map(p => `<option value="${p}"${p === "medium" ? " selected" : ""}>${p}</option>`).join("")}
          </select></div>
        </div>
        <div class="modal-actions">
          <button class="btn" data-act="cancel">Cancel</button>
          <button class="btn btn--primary" data-act="add" data-testid="add-confirm">Add</button>
        </div>
      </div>
    `;
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.remove(); });
    backdrop.querySelector('[data-act="cancel"]').addEventListener("click", () => backdrop.remove());
    backdrop.querySelector('[data-act="add"]').addEventListener("click", () => {
      const title = backdrop.querySelector("#qa-title").value.trim();
      if (!title) { toast("Add a title first.", "warn"); return; }
      const startVal = backdrop.querySelector("#qa-start").value;
      const endVal   = backdrop.querySelector("#qa-end").value;
      if (!startVal || !endVal) { toast("Pick a start and end time.", "warn"); return; }
      if (new Date(endVal) <= new Date(startVal)) { toast("End must be after start.", "warn"); return; }
      const result = addEvent({
        title,
        start: `${startVal}:00`,
        end: `${endVal}:00`,
        category: backdrop.querySelector("#qa-category").value,
        priority: backdrop.querySelector("#qa-priority").value,
      });
      result.conflicts.forEach(c => toast(`"${result.event.title}" overlaps with "${c.title}"`, "warn"));
      toast(`Added "${title}"`, "ok");
      backdrop.remove();
    });
    document.body.appendChild(backdrop);
    setTimeout(() => backdrop.querySelector("#qa-title").focus(), 30);
  }

  function closeModals() {
    document.querySelectorAll(".modal-backdrop--show").forEach(m => {
      if (m.id === "help-modal") {
        m.classList.remove("modal-backdrop--show");
        m.setAttribute("aria-hidden", "true");
      } else {
        m.remove();
      }
    });
  }

  // ---------- help modal ----------
  $("help-btn").addEventListener("click", () => {
    const m = $("help-modal");
    m.classList.add("modal-backdrop--show");
    m.setAttribute("aria-hidden", "false");
  });
  $("help-modal").addEventListener("click", (e) => {
    if (e.target.id === "help-modal" || e.target.dataset.act === "close") {
      $("help-modal").classList.remove("modal-backdrop--show");
      $("help-modal").setAttribute("aria-hidden", "true");
    }
  });

  // ---------- keyboard shortcuts ----------
  document.addEventListener("keydown", (e) => {
    const active = document.activeElement;
    const inField = active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT");
    if (e.key === "Escape") { closeModals(); return; }
    if (inField) return;
    if (e.key === "?")             { e.preventDefault(); $("help-btn").click(); }
    else if (e.key === "/")        { e.preventDefault(); chatInput.focus(); }
    else if (e.key === "k" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); searchInput.focus(); }
    else if (e.key === "ArrowLeft")  { navByPeriod(-1); }
    else if (e.key === "ArrowRight") { navByPeriod(+1); }
    else if (e.key.toLowerCase() === "t") { $("today-btn").click(); }
    else if (e.key.toLowerCase() === "w") { setView("week"); }
    else if (e.key.toLowerCase() === "d") { setView("day"); }
  });

  // ---------- calendar export ----------
  function icsDateTime(d) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }
  function icsEscape(s) {
    return String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  }
  function buildIcs(events) {
    const dtstamp = icsDateTime(new Date());
    const lines = [
      "BEGIN:VCALENDAR", "VERSION:2.0",
      "PRODID:-//SAGE//sage-scheduler//EN",
      "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:SAGE Schedule",
    ];
    for (const ev of events) {
      const s = fromIsoLocal(ev.start);
      const x = fromIsoLocal(ev.end);
      lines.push("BEGIN:VEVENT");
      lines.push(`UID:sage-${ev.id}-${dtstamp}@sage.local`);
      lines.push(`DTSTAMP:${dtstamp}`);
      lines.push(`DTSTART:${icsDateTime(s)}`);
      lines.push(`DTEND:${icsDateTime(x)}`);
      lines.push(`SUMMARY:${icsEscape(ev.title)}`);
      if (ev.description) lines.push(`DESCRIPTION:${icsEscape(ev.description)}`);
      lines.push(`CATEGORIES:${icsEscape(ev.category)}`);
      lines.push(`PRIORITY:${ev.priority === "high" ? 1 : ev.priority === "low" ? 9 : 5}`);
      lines.push("END:VEVENT");
    }
    lines.push("END:VCALENDAR");
    return lines.join("\r\n");
  }
  function downloadIcs(events, filename) {
    const ics = buildIcs(events);
    const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename || "sage-schedule.ics";
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
  }
  function buildGoogleCalendarUrl(ev) {
    const s = fromIsoLocal(ev.start), x = fromIsoLocal(ev.end);
    const params = new URLSearchParams({
      action: "TEMPLATE",
      text: ev.title,
      dates: `${icsDateTime(s)}/${icsDateTime(x)}`,
      details: ev.description || `Added by SAGE — category: ${ev.category}, priority: ${ev.priority}`,
    });
    return `https://calendar.google.com/calendar/render?${params.toString()}`;
  }
  function slugify(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "event";
  }

  // ---------- sync dropdown ----------
  const syncBtn = $("sync-btn");
  const syncDropdown = syncBtn.parentElement;
  syncBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    syncDropdown.classList.toggle("dropdown--open");
  });
  document.addEventListener("click", () => syncDropdown.classList.remove("dropdown--open"));
  $("sync-menu").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    e.stopPropagation();
    const act = btn.dataset.act;
    if (act === "export-ics") {
      if (!state.events.length) { toast("No events yet — add some first.", "warn"); return; }
      downloadIcs(state.events, "sage-schedule.ics");
      toast(`Downloaded sage-schedule.ics (${state.events.length} events)`, "ok");
    } else if (act === "open-google") {
      window.open("https://calendar.google.com/", "_blank", "noopener");
    } else if (act === "open-apple") {
      window.open("webcal://", "_self");
      toast("If nothing happened, Apple Calendar may not be installed.", "warn");
    }
    syncDropdown.classList.remove("dropdown--open");
  });

  // ---------- notifications ----------
  function setNotifyUI() {
    if (state.notifyEnabled) {
      notifyBtn.classList.add("ghost-btn--on");
      notifyBtn.textContent = "🔔 Reminders on";
    } else {
      notifyBtn.classList.remove("ghost-btn--on");
      notifyBtn.textContent = "🔔 Reminders";
    }
  }
  setNotifyUI();
  notifyBtn.addEventListener("click", async () => {
    if (!("Notification" in window)) {
      toast("Your browser doesn't support notifications.", "err");
      return;
    }
    if (state.notifyEnabled) {
      state.notifyEnabled = false;
      localStorage.setItem(LS_NOTIFY, "0");
      cancelAllNotifications();
      setNotifyUI();
      toast("Reminders turned off", "ok");
      return;
    }
    const result = await Notification.requestPermission();
    if (result !== "granted") {
      toast("Notification permission denied.", "err");
      return;
    }
    state.notifyEnabled = true;
    localStorage.setItem(LS_NOTIFY, "1");
    rescheduleAllNotifications();
    setNotifyUI();
    toast("Reminders on — you'll be pinged 5 min before each event", "ok");
  });
  function scheduleNotification(ev) {
    if (!state.notifyEnabled || !("Notification" in window) || Notification.permission !== "granted") return;
    cancelNotification(ev.id);
    const fireAt = fromIsoLocal(ev.start).getTime() - 5 * 60_000;
    const delay = fireAt - Date.now();
    if (delay < 0 || delay > 24 * 60 * 60_000) return; // only schedule next 24h
    const tid = setTimeout(() => {
      try {
        new Notification(`SAGE — ${ev.title}`, {
          body: `Starts at ${fmtTime(fromIsoLocal(ev.start))}`,
          icon: "../assets/favicon.svg",
          tag: `sage-${ev.id}`,
        });
      } catch (err) { console.warn("notif failed", err); }
      state._scheduledNotifs.delete(ev.id);
    }, delay);
    state._scheduledNotifs.set(ev.id, tid);
  }
  function cancelNotification(id) {
    const tid = state._scheduledNotifs.get(id);
    if (tid) { clearTimeout(tid); state._scheduledNotifs.delete(id); }
  }
  function cancelAllNotifications() {
    state._scheduledNotifs.forEach(tid => clearTimeout(tid));
    state._scheduledNotifs.clear();
  }
  function rescheduleAllNotifications() {
    cancelAllNotifications();
    if (!state.notifyEnabled) return;
    state.events.forEach(ev => scheduleNotification(ev));
  }

  // ---------- clear / reset ----------
  $("reset-btn").addEventListener("click", () => {
    if (state.events.length === 0) { toast("Already empty", "ok"); return; }
    if (!confirm(`Clear all ${state.events.length} events from this browser?`)) return;
    const snapshot = state.events.slice();
    state.events = [];
    state.nextId = 1;
    cancelAllNotifications();
    saveEvents();
    renderAll();
    pushUndo(`${snapshot.length} events`, () => {
      state.events = snapshot;
      state.nextId = nextIdFrom(snapshot);
      rescheduleAllNotifications();
    });
    toast("All events cleared", "ok", { label: "Undo", onClick: () => consumeUndo() });
  });

  // ---------- live countdown tick ----------
  setInterval(() => { renderTodayPanel(); }, 30000);

  // ---------- startup: pick initial week / day ----------
  (function pickInitialWeek() {
    if (!state.events.length) return;
    const nowMs = Date.now();
    const inCurrentWeek = state.events.some(e => {
      const ws = state.weekStart.getTime();
      const we = ws + 7 * 86400_000;
      const s = fromIsoLocal(e.start).getTime();
      return s >= ws && s < we;
    });
    if (inCurrentWeek) return;
    const upcoming = state.events
      .filter(e => fromIsoLocal(e.start).getTime() >= nowMs)
      .sort((a, b) => fromIsoLocal(a.start) - fromIsoLocal(b.start));
    const pick = upcoming[0] || state.events.slice().sort((a, b) => fromIsoLocal(b.start) - fromIsoLocal(a.start))[0];
    state.weekStart = startOfWeek(fromIsoLocal(pick.start));
    state.selectedDay = startOfDay(fromIsoLocal(pick.start));
  })();

  // ---------- startup: ping cloud + schedule notifs ----------
  (async function probeCloud() {
    if (FORCE_BASIC) { setMode("basic"); return; }
    setMode("loading");
    try {
      const res = await fetch("https://text.pollinations.ai/ping?model=openai-fast", { signal: AbortSignal.timeout(8000) });
      const txt = await res.text();
      if (res.ok && !txt.includes('"error"')) setMode("ai");
      else setMode("basic");
    } catch { setMode("basic"); }
  })();

  rescheduleAllNotifications();
  renderAll();
})();
