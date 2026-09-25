// Aegis Studio page. Talks only to the local server that served it; the token comes from the URL's #fragment.
(() => {
  "use strict";
  const token = location.hash.slice(1);
  const $ = (id) => document.getElementById(id);
  const chat = $("chat");
  const input = $("input");
  const state = { busy: false, model: "auto", thinking: { level: "low", display: "fold" }, models: [], turnFiles: new Set() };
  let current = { ai: null, think: null, thinkStart: 0, tools: [] };

  if (!token) {
    chat.textContent = "Open the link that `aegis ui` printed in the terminal. It carries the key this page needs.";
    return;
  }

  async function api(path, body) {
    const res = await fetch(path, {
      method: body ? "POST" : "GET",
      headers: { "x-aegis-token": token, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // ---------- safe Markdown: escape first, then add a small set of formatting ----------
  const esc = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  function inline(text) {
    return esc(text)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  }
  function markdown(src) {
    const out = [];
    const lines = String(src).replace(/\r\n/g, "\n").split("\n");
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const fence = /^```(\S*)/.exec(line);
      if (fence) {
        const code = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
        i++;
        out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
        continue;
      }
      const head = /^(#{1,6})\s+(.*)$/.exec(line);
      if (head) {
        const level = Math.min(3, head[1].length);
        out.push(`<h${level}>${inline(head[2])}</h${level}>`);
        i++;
        continue;
      }
      if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
        const ordered = /^\s*\d+\./.test(line);
        const items = [];
        while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ""));
        out.push(`<${ordered ? "ol" : "ul"}>${items.map((item) => `<li>${inline(item)}</li>`).join("")}</${ordered ? "ol" : "ul"}>`);
        continue;
      }
      if (!line.trim()) {
        i++;
        continue;
      }
      const para = [];
      while (i < lines.length && lines[i].trim() && !/^(```|#{1,6}\s|\s*([-*]|\d+\.)\s+)/.test(lines[i])) para.push(lines[i++]);
      out.push(`<p>${inline(para.join("\n")).replace(/\n/g, "<br>")}</p>`);
    }
    return out.join("");
  }

  // ---------- building blocks ----------
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const scroll = () => chat.scrollTo({ top: chat.scrollHeight });
  function clearHero() {
    const hero = chat.querySelector(".hero");
    if (hero) hero.remove();
  }
  function addUser(text) {
    clearHero();
    chat.append(el("div", "msg-user", text));
    scroll();
  }
  function addAi(text) {
    clearHero();
    const node = el("div", "msg-ai");
    node.innerHTML = markdown(text);
    chat.append(node);
    scroll();
    return node;
  }
  function addNote(text, cls = "note") {
    clearHero();
    chat.append(el("div", cls, text));
    scroll();
  }
  function hero(info) {
    chat.textContent = "";
    const box = el("div", "hero");
    box.innerHTML = '<svg viewBox="0 0 20 22" aria-hidden="true"><path d="M10 1 18 4v7c0 5-3.4 8.6-8 10C5.4 19.6 2 16 2 11V4z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 6v10M6.5 9.5h7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
    box.append(el("h1", "", `Welcome back, ${info.user}`));
    box.append(
      el(
        "p",
        "",
        info.hasChatKey
          ? "Ask for a change in this folder. Every read, edit and command passes your rules first, and you see what allowed it."
          : "Connect a model first: type /login opencode <key> below. Until then Aegis can list, read and search.",
      ),
    );
    const tries = el("div", "tries");
    for (const text of ["What is in this folder?", "Read README.md and summarise it", "/status"]) {
      const b = el("button", "", text);
      b.type = "button";
      b.addEventListener("click", () => submit(text));
      tries.append(b);
    }
    box.append(tries);
    chat.append(box);
  }

  function thinkingBlock() {
    const b = el("button", "think");
    b.type = "button";
    b.setAttribute("aria-expanded", String(state.thinking.display === "show"));
    b.hidden = state.thinking.display === "hide";
    const head = el("span", "head", "▸ Thinking…");
    const body = el("span", "body", "");
    b.append(head, body);
    b.addEventListener("click", () => {
      const open = b.getAttribute("aria-expanded") !== "true";
      b.setAttribute("aria-expanded", String(open));
      updateThinkHead(b);
    });
    return b;
  }
  function updateThinkHead(block, done) {
    const open = block.getAttribute("aria-expanded") === "true";
    const seconds = Math.max(1, Math.round((Date.now() - current.thinkStart) / 1000));
    const head = block.querySelector(".head");
    if (done || block.dataset.done) {
      block.dataset.done = block.dataset.done || String(seconds);
      head.textContent = `${open ? "▾" : "▸"} Thought for ${block.dataset.done}s`;
    } else head.textContent = `${open ? "▾" : "▸"} Thinking… ${seconds}s`;
  }
  function endThinking() {
    if (current.think && !current.think.dataset.done) updateThinkHead(current.think, true);
  }

  function toolRow(name, target) {
    const row = el("div", "tool");
    row.append(el("span", "dot"), el("span", "what", `${name} ${target || ""}`.trim()), el("span", "why", ""));
    chat.append(row);
    const step = el("li");
    step.append(el("i"), el("span", "", `${name} ${target || ""}`.trim()));
    const steps = $("steps");
    steps.querySelector(".empty")?.remove();
    steps.append(step);
    current.tools.push({ name, target, row, step });
    scroll();
  }
  function toolDone(record) {
    const match = [...current.tools].reverse().find((t) => t.name === record.name && (t.target || "") === (record.target || "") && !t.done);
    if (!match) {
      toolRow(record.name, record.target);
      return toolDone(record);
    }
    match.done = true;
    const status = record.approved ? "ran" : "denied";
    const why = record.approved
      ? record.savedRule
        ? `you: always allow · saved "${record.savedRule}"`
        : record.saveFailed
          ? `you allowed · rule not saved (${record.saveFailed})`
          : `${record.action === "confirm" ? "you allowed" : "auto"} · ${record.rule ? `rule "${record.rule}"` : record.source === "default" ? "no rule" : record.source}`
      : `denied · ${record.deniedReason || ""}`;
    match.row.classList.add(status);
    match.row.querySelector(".why").textContent = `· ${why}`;
    match.step.className = status;
    const small = el("small", "", why);
    match.step.querySelector("span").append(small);
    if (record.approved && (record.name === "write" || record.name === "edit") && record.target) {
      state.turnFiles.add(record.target);
      renderFiles();
    }
  }
  function renderFiles() {
    const list = $("files");
    list.textContent = "";
    if (!state.turnFiles.size) list.append(el("li", "empty", "None yet"));
    for (const file of state.turnFiles) list.append(el("li", "", file));
  }

  function approvalCard(id, question, options) {
    clearHero();
    const card = el("div", "approve");
    card.dataset.id = String(id);
    card.append(el("h3", "", `Allow ${options?.tool || "this"}${options?.target ? ` ${options.target}` : ""}?`));
    if (options?.why) card.append(el("div", "note", options.why));
    card.append(el("pre", "", question.replace(/\n?\[y\/N\]\s*$/, "")));
    const row = el("div", "row");
    const add = (label, answer, cls) => {
      const b = el("button", cls || "", label);
      b.type = "button";
      b.addEventListener("click", () => answer === null || api("/api/approve", { id, answer }).catch(showError));
      row.append(b);
      return b;
    };
    const yes = add("Allow once  (y)", "yes", "yes");
    if (options?.always) add(`Always allow “${options.always}”  (a)`, "always");
    add("Deny  (n)", "no");
    card.append(row);
    card.tabIndex = -1;
    card.addEventListener("keydown", (e) => {
      if (e.key === "y") api("/api/approve", { id, answer: "yes" }).catch(showError);
      if (e.key === "a" && options?.always) api("/api/approve", { id, answer: "always" }).catch(showError);
      if (e.key === "n" || e.key === "Escape") api("/api/approve", { id, answer: "no" }).catch(showError);
    });
    chat.append(card);
    scroll();
    yes.focus();
  }
  function approvalDone(id, answer) {
    const card = chat.querySelector(`.approve[data-id="${id}"]`);
    if (!card) return;
    card.querySelector(".row")?.remove();
    card.append(el("div", "done", answer === "always" ? "Allowed, and saved as a rule." : answer ? "Allowed once." : "Denied."));
  }

  // ---------- live events ----------
  const phases = {
    accepted: "Starting",
    evaluating: "Jev is scoring the turn",
    waiting_model: "Waiting for the model",
    awaiting_approval: "Waiting for you",
  };
  function setWorking(text) {
    $("working").hidden = !text;
    $("workingText").textContent = text || "";
  }
  // The model's todo list: text only (textContent), never markup.
  function renderTodos(todos) {
    const list = $("todos");
    list.textContent = "";
    const open = (todos || []).some((todo) => todo.status === "pending" || todo.status === "in_progress");
    $("todoCard").hidden = !open;
    const mark = { pending: "○", in_progress: "▸", completed: "✓", cancelled: "–" };
    for (const todo of todos || []) {
      const li = el("li", todo.status);
      li.append(el("span", "", mark[todo.status] || "○"), el("span", "", todo.content));
      list.append(li);
    }
  }

  function onEvent(event) {
    if (event.type === "todos") renderTodos(event.todos);
    if (event.type === "notice") addNote(event.text);
    if (phases[event.type]) setWorking(phases[event.type]);
    if (event.type === "route" && event.reason !== "selected") addNote(`model ${event.model} · ${event.reason}`, "route");
    if (event.type === "reasoning_delta") {
      setWorking("Thinking");
      if (!current.think || current.think.dataset.done) {
        current.think = thinkingBlock();
        current.thinkStart = Date.now();
        current.ai = null;
        clearHero();
        chat.append(current.think);
      }
      current.think.querySelector(".body").textContent += event.text;
      updateThinkHead(current.think);
      scroll();
    }
    if (event.type === "text_delta") {
      endThinking();
      setWorking("Writing");
      if (!current.ai) {
        current.ai = addAi("");
        current.ai.dataset.raw = "";
      }
      current.ai.dataset.raw += event.text;
      current.ai.innerHTML = markdown(current.ai.dataset.raw);
      scroll();
    }
    if (event.type === "tool_start") {
      endThinking();
      current.ai = null;
      setWorking(`${event.name} ${event.target || ""}`);
      toolRow(event.name, event.target);
    }
    if (event.type === "tool") toolDone(event.record);
  }

  function connect() {
    const source = new EventSource(`/api/events?t=${encodeURIComponent(token)}`);
    source.onmessage = (message) => {
      const data = JSON.parse(message.data);
      if (data.kind === "started" && !state.busy) {
        // Another tab (or window) started this turn: follow it here too.
        if (!data.text.startsWith("/") && !data.text.startsWith("!")) addUser(data.text);
        setBusy(true);
        setWorking("Starting");
      }
      if (data.kind === "event") onEvent(data.event);
      if (data.kind === "approval") {
        setWorking("Waiting for you");
        approvalCard(data.id, data.question, data.options);
      }
      if (data.kind === "approval_done") approvalDone(data.id, data.answer);
      if (data.kind === "done") finishTurn(data);
      if (data.kind === "error") {
        finishTurn({});
        addNote(data.message);
      }
    };
    source.onerror = () => setWorking(state.busy ? "Reconnecting…" : "");
  }

  let lastNotice = "";
  function finishTurn(data) {
    endThinking();
    setBusy(false);
    if (data.notice && data.notice !== lastNotice) addNote(data.notice);
    if (data.notice) lastNotice = data.notice;
    if (data.isTurn) {
      if (!current.ai && data.answer) addAi(data.answer);
      if (data.status?.length) {
        const line = el("div", "status ok", data.status[0].replace(/^✓\s*/, ""));
        chat.append(line);
        for (const extra of data.status.slice(1)) addNote(extra);
      }
    } else if (data.output) addNote(data.output);
    current = { ai: null, think: null, thinkStart: 0, tools: [] };
    scroll();
    refresh().catch(showError);
  }

  function setBusy(busy) {
    state.busy = busy;
    $("send").disabled = busy;
    if (!busy) setWorking("");
  }
  function showError(error) {
    setBusy(false);
    addNote(`⚠ ${error.message || error}`);
  }

  async function submit(text) {
    const value = String(text ?? input.value).trim();
    if (!value || state.busy) return;
    input.value = "";
    autosize();
    if (!value.startsWith("/") && !value.startsWith("!")) {
      addUser(value);
      $("steps").textContent = "";
      state.turnFiles.clear();
      renderFiles();
    } else addNote(`› ${value.replace(/^(\/login\s+\S+\s+)\S+/i, "$1••••")}`);
    setBusy(true);
    setWorking("Starting");
    try {
      await api("/api/prompt", { text: value });
    } catch (error) {
      showError(error);
    }
  }

  // ---------- chrome: sessions, chips, picker, setup ----------
  const fmt = (n) => (n < 1000 ? String(n) : n < 10000 ? `${(n / 1000).toFixed(1)}k` : n < 1e6 ? `${Math.round(n / 1000)}k` : `${(n / 1e6).toFixed(1)}M`);
  async function refresh() {
    const [s, sessions] = await Promise.all([api("/api/state"), api("/api/sessions")]);
    state.model = s.model;
    state.thinking = s.thinking;
    $("version").textContent = `v${s.welcome.version}`;
    $("folder").textContent = s.welcome.cwd;
    $("modelName").textContent = s.model;
    $("thinkLevel").textContent = s.thinking.level;
    $("showMode").textContent = { fold: "folded", show: "shown", hide: "hidden" }[s.thinking.display];
    $("topMeta").textContent = `${s.plan ? "PLAN MODE · " : ""}${s.model === "auto" ? s.welcome.model : s.model} · ${s.welcome.provider} · runs on this PC`;
    state.plan = Boolean(s.plan);
    renderTodos(s.todos);
    $("planState").textContent = s.plan ? "on" : "off";
    $("planChip").setAttribute("aria-pressed", String(s.plan));
    const total = s.tokens.input + s.tokens.output;
    $("tokenTotal").textContent = fmt(total);
    $("tokenSplit").textContent = `↑ ${fmt(s.tokens.input)} in · ↓ ${fmt(s.tokens.output)} out`;
    const setup = $("setup");
    setup.textContent = "";
    const rows = [
      ["rules", `${s.welcome.rules.deny} deny · ${s.welcome.rules.ask} ask · ${s.welcome.rules.allow} allow`],
      ["jev", `${s.welcome.jevMode} · ${s.jev}`],
      ["plugins", s.plugins.join(", ") || "none"],
    ];
    for (const [k, v] of rows) setup.append(el("dt", "", k), el("dd", "", v));
    const nav = $("sessions");
    nav.textContent = "";
    const known = sessions.sessions.some((row) => row.id === sessions.current);
    if (!known) {
      const b = el("button", "", "This chat");
      b.setAttribute("aria-current", "true");
      nav.append(b);
    }
    for (const row of sessions.sessions) {
      const b = el("button", "", row.text);
      b.type = "button";
      b.append(el("small", "", row.when));
      b.setAttribute("aria-current", String(row.id === sessions.current));
      b.title = row.text;
      b.addEventListener("click", () => openSession(row.id));
      nav.append(b);
      if (row.id === sessions.current) $("title").textContent = row.text;
    }
    if (!known) $("title").textContent = "New chat";
    return s;
  }

  async function loadChat(info) {
    const rows = await api("/api/messages");
    chat.textContent = "";
    if (!rows.length) return hero(info);
    for (const row of rows) {
      if (row.role === "user") addUser(row.text);
      else if (row.role === "tool") {
        const r = el("div", "tool ran");
        r.append(el("span", "dot"), el("span", "what", row.text));
        chat.append(r);
      } else addAi(row.text);
    }
    scroll();
  }

  async function openSession(id) {
    if (state.busy) return;
    await api("/api/resume", { id });
    const s = await refresh();
    await loadChat(s.welcome);
  }

  $("newChat").addEventListener("click", async () => {
    if (state.busy) return;
    await api("/api/new", {});
    const s = await refresh();
    hero(s.welcome);
  });

  const levels = ["off", "low", "medium", "high"];
  $("thinkChip").addEventListener("click", async () => {
    const next = levels[(levels.indexOf(state.thinking.level) + 1) % levels.length];
    await api("/api/think", { value: next }).catch(showError);
    await refresh();
  });
  // Plan chip: on = read-only planning; when a plan is shown, "go" carries it out.
  $("planChip").addEventListener("click", () => {
    if (state.busy) return;
    if (!state.plan) return submit("/plan");
    const go = window.confirm("Carry out the plan now?\nOK = go (the agent may change files, your rules still decide)\nCancel = leave plan mode without running it");
    submit(go ? "/plan go" : "/plan off");
  });

  const displays = ["fold", "show", "hide"];
  $("showChip").addEventListener("click", async () => {
    const next = displays[(displays.indexOf(state.thinking.display) + 1) % displays.length];
    await api("/api/think", { value: next }).catch(showError);
    await refresh();
    for (const block of chat.querySelectorAll(".think")) {
      block.hidden = next === "hide";
      block.setAttribute("aria-expanded", String(next === "show"));
      updateThinkHead(block, true);
    }
  });

  // Model picker: live list from the server, grouped, type to filter, arrows + Enter, Esc closes.
  const picker = $("picker");
  const plist = $("plist");
  const search = $("pickerSearch");
  let pickIndex = 0;
  function rank(item, q) {
    const id = item.id.toLowerCase();
    return id === q ? 0 : id.startsWith(q) ? 1 : id.includes(q) ? 2 : 3;
  }
  function visibleModels() {
    const q = search.value.trim().toLowerCase();
    if (!q) return state.models;
    return state.models
      .filter((m) => `${m.id} ${m.group} ${m.note}`.toLowerCase().includes(q))
      .map((m, i) => ({ m, i, r: rank(m, q) }))
      .sort((a, b) => a.r - b.r || a.i - b.i)
      .map((x) => x.m);
  }
  function renderPicker() {
    const list = visibleModels();
    pickIndex = Math.min(pickIndex, Math.max(0, list.length - 1));
    plist.textContent = "";
    let group = "";
    list.forEach((m, i) => {
      if (m.group !== group) {
        group = m.group;
        plist.append(el("div", "grp", group));
      }
      const b = el("button");
      b.type = "button";
      b.setAttribute("role", "option");
      b.setAttribute("aria-selected", String(i === pickIndex));
      b.append(el("span", "", m.id), el("small", "", m.note));
      b.addEventListener("click", () => pickModel(m.id));
      plist.append(b);
    });
    if (!list.length) plist.append(el("div", "grp", "No model matches"));
    plist.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }
  async function pickModel(id) {
    picker.hidden = true;
    // The server's "done" event shows the result line in the chat.
    await api("/api/model", { id }).catch(showError);
    await refresh();
    input.focus();
  }
  // Open at once (the list fills in when it arrives), so a quick Esc or outside click always closes it.
  $("modelChip").addEventListener("click", async () => {
    if (!picker.hidden) {
      picker.hidden = true;
      return;
    }
    search.value = "";
    picker.hidden = false;
    renderPicker();
    search.focus();
    try {
      state.models = await api("/api/models");
    } catch (error) {
      picker.hidden = true;
      return showError(error);
    }
    pickIndex = Math.max(0, state.models.findIndex((m) => m.id === state.model));
    if (!picker.hidden) renderPicker();
  });
  document.addEventListener("mousedown", (e) => {
    if (!picker.hidden && !picker.contains(e.target) && !$("modelChip").contains(e.target)) picker.hidden = true;
  });
  search.addEventListener("input", () => {
    pickIndex = 0;
    renderPicker();
  });
  search.addEventListener("keydown", (e) => {
    const list = visibleModels();
    if (e.key === "ArrowDown") pickIndex = Math.min(list.length - 1, pickIndex + 1);
    else if (e.key === "ArrowUp") pickIndex = Math.max(0, pickIndex - 1);
    else if (e.key === "Enter") {
      e.preventDefault();
      if (list[pickIndex]) pickModel(list[pickIndex].id);
      return;
    } else if (e.key === "Escape") {
      picker.hidden = true;
      input.focus();
      return;
    } else return;
    e.preventDefault();
    renderPicker();
  });

  function autosize() {
    input.style.height = "auto";
    input.style.height = `${Math.min(200, input.scrollHeight)}px`;
  }
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });
  $("composer").addEventListener("submit", (e) => {
    e.preventDefault();
    submit();
  });
  $("stop").addEventListener("click", () => api("/api/stop", {}).catch(showError));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.busy && picker.hidden) api("/api/stop", {}).catch(showError);
  });

  // ---------- start ----------
  connect();
  refresh()
    .then(async (s) => {
      await loadChat(s.welcome);
      for (const pending of s.approvals || []) approvalCard(pending.id, pending.question, pending.options);
      if (s.busy) setBusy(true);
      input.focus();
    })
    .catch(showError);
})();
