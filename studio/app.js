// Aegis Studio page. Talks only to the local server that served it; the token comes from the URL's #fragment.
(() => {
  "use strict";
  const token = location.hash.slice(1);
  const $ = (id) => document.getElementById(id);
  const chat = $("chat");
  const input = $("input");
  const state = { busy: false, model: "auto", thinking: { level: "low", display: "fold" }, models: [], turnFiles: new Set(), images: [], docs: [] };
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
      if (data.kind === "approval" && document.hidden) flagTitle("● Waiting for you");
      if (data.kind === "done" && document.hidden) flagTitle("✓ Done");
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
    if (data.chat === "reload" || data.chat === "reset") {
      // /fork, /rewind chat, /resume, /new: show the conversation as it now is.
      refresh()
        .then((s) => loadChat(s.welcome))
        .then(() => {
          if (data.output) addNote(data.output);
        })
        .catch(showError);
      return;
    }
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
    const images = text === undefined ? state.images.filter((image) => image.data) : [];
    const docs = text === undefined ? state.docs.filter((doc) => doc.text !== undefined) : [];
    const attached = [...images, ...docs];
    const value = String(text ?? input.value).trim() || (attached.length ? "Look at the attached file(s)." : "");
    if (!value || state.busy) return;
    if (attached.length && (value.startsWith("/") || value.startsWith("!"))) {
      addNote("⚠ Files go with a message, not a command.");
      return;
    }
    input.value = "";
    autosize();
    if (!value.startsWith("/") && !value.startsWith("!")) {
      addUser(attached.length ? `${value}\n📎 ${attached.map((file) => file.name).join(", ")}` : value);
      $("steps").textContent = "";
      state.turnFiles.clear();
      renderFiles();
    } else addNote(`› ${value.replace(/^(\/login\s+\S+\s+)\S+/i, "$1••••")}`);
    setBusy(true);
    setWorking("Starting");
    const body = { text: value };
    if (images.length) body.images = images.map(({ name, data }) => ({ name, data }));
    if (docs.length) body.documents = docs.map(({ name, text: content }) => ({ name, text: content }));
    try {
      await api("/api/prompt", body);
      // Only once the server took them: a refused send keeps the chips for another try.
      if (attached.length) {
        state.images = state.images.filter((image) => !images.includes(image));
        state.docs = state.docs.filter((doc) => !docs.includes(doc));
        renderImages();
      }
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
    $("folder").textContent = s.branch ? `${s.welcome.cwd} (${s.branch})` : s.welcome.cwd;
    $("modelName").textContent = s.model;

    $("topMeta").textContent = `${s.plan ? "PLAN MODE · " : ""}${s.model === "auto" ? s.welcome.model : s.model} · ${s.welcome.provider} · runs on this PC`;
    state.plan = Boolean(s.plan);
    renderTodos(s.todos);
    renderMenuState();
    const total = s.tokens.input + s.tokens.output;
    $("tokenTotal").textContent = fmt(total);
    $("tokenSplit").textContent = `↑ ${fmt(s.tokens.input)} in · ↓ ${fmt(s.tokens.output)} out`;
    const setup = $("setup");
    setup.textContent = "";
    const rows = [
      ["rules", `${s.welcome.rules.deny} deny · ${s.welcome.rules.ask} ask · ${s.welcome.rules.allow} allow`],
      ["jev", `${s.welcome.jevMode} · ${s.jev}`],
      ["plugins", s.plugins.join(", ") || "none"],
      ["context", `${s.context ?? 0}% of the auto-compact size`],
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

  // ---------- the + menu: attach, thinking, reasoning, plan mode ----------
  const plusBtn = $("plusBtn");
  const plusMenu = $("plusMenu");
  function openMenu(open) {
    plusMenu.hidden = !open;
    plusBtn.setAttribute("aria-expanded", String(open));
    if (open) picker.hidden = true;
  }
  function renderMenuState() {
    for (const button of $("thinkSeg").querySelectorAll("button")) button.setAttribute("aria-pressed", String(button.dataset.value === state.thinking.level));
    for (const button of $("showSeg").querySelectorAll("button")) button.setAttribute("aria-pressed", String(button.dataset.value === state.thinking.display));
    $("planSwitch").setAttribute("aria-checked", String(Boolean(state.plan)));
    // Only what differs from the defaults shows next to the model, so the bar stays quiet.
    $("planBadge").hidden = !state.plan;
    const think = $("thinkBadge");
    think.hidden = state.thinking.level === "low";
    think.textContent = `Thinking ${state.thinking.level}`;
  }
  plusBtn.addEventListener("click", () => openMenu(plusMenu.hidden));
  document.addEventListener("mousedown", (e) => {
    if (!plusMenu.hidden && !plusMenu.contains(e.target) && !plusBtn.contains(e.target)) openMenu(false);
  });
  plusMenu.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      openMenu(false);
      plusBtn.focus();
    }
  });
  $("attachBtn").addEventListener("click", () => {
    openMenu(false);
    $("fileInput").click();
  });
  $("fileInput").addEventListener("change", (e) => {
    addFiles([...(e.target.files ?? [])]);
    e.target.value = "";
  });
  $("thinkSeg").addEventListener("click", async (e) => {
    const value = e.target.closest("button")?.dataset.value;
    if (!value || value === state.thinking.level) return;
    await api("/api/think", { value }).catch(showError);
    await refresh();
  });
  // Plan mode: on = read-only planning; turning it off while a plan is open asks whether to carry it out.
  $("planSwitch").addEventListener("click", () => {
    if (state.busy) return;
    openMenu(false);
    if (!state.plan) return submit("/plan");
    const go = window.confirm("Carry out the plan now?\nOK = go (the agent may change files, your rules still decide)\nCancel = leave plan mode without running it");
    submit(go ? "/plan go" : "/plan off");
  });

  $("showSeg").addEventListener("click", async (e) => {
    const next = e.target.closest("button")?.dataset.value;
    if (!next || next === state.thinking.display) return;
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

  // ---------- the tab title says when Aegis needs you (the terminal rings its bell instead) ----------
  const baseTitle = document.title;
  function flagTitle(text) {
    document.title = `${text} · ${baseTitle}`;
  }
  const clearTitle = () => {
    if (!document.hidden) document.title = baseTitle;
  };
  document.addEventListener("visibilitychange", clearTitle);
  window.addEventListener("focus", clearTitle);

  // ---------- pasted or dropped images: sent with the next message, checked again by the server ----------
  const MAX_IMAGES = 4;
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
  const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
  function renderImages() {
    const box = $("attachments");
    box.textContent = "";
    box.hidden = !state.images.length && !state.docs.length;
    const chip = (name, preview, onRemove) => {
      const node = el("span", "attach");
      const remove = el("button", "linkbtn", "×");
      remove.type = "button";
      remove.setAttribute("aria-label", `Remove ${name}`);
      remove.addEventListener("click", onRemove);
      node.append(preview, el("span", "", name), remove);
      box.append(node);
    };
    state.images.forEach((image, index) => {
      const img = el("img");
      img.src = `data:${image.type};base64,${image.data}`;
      img.alt = image.name;
      chip(image.name, img, () => {
        state.images.splice(index, 1);
        renderImages();
      });
    });
    state.docs.forEach((doc, index) => {
      const icon = el("span", "doc", (doc.name.split(".").pop() || "txt").slice(0, 4));
      icon.setAttribute("aria-hidden", "true");
      chip(doc.name, icon, () => {
        state.docs.splice(index, 1);
        renderImages();
      });
    });
  }
  // Text documents (logs, configs, scripts, notes): sent as text with the message, checked again on the server.
  const MAX_DOCS = 5;
  const MAX_DOC_BYTES = 200 * 1024;
  function addDocs(files) {
    for (const file of files) {
      if (state.docs.length >= MAX_DOCS) {
        addNote(`⚠ At most ${MAX_DOCS} files per message.`);
        break;
      }
      if (file.size > MAX_DOC_BYTES) {
        addNote(`⚠ ${file.name} is over 200 KB. Put it in the folder and mention it with @${file.name} instead.`);
        continue;
      }
      const entry = { name: file.name || "file.txt", text: undefined };
      state.docs.push(entry);
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result);
        // A NUL byte means binary (a PDF, a Word file, an exe): not sent.
        if (text.includes("\u0000")) {
          state.docs.splice(state.docs.indexOf(entry), 1);
          addNote(`⚠ ${entry.name} is not a text file. Images and text files (logs, configs, scripts, notes) can be attached.`);
        } else entry.text = text;
        renderImages();
      };
      reader.onerror = () => {
        state.docs.splice(state.docs.indexOf(entry), 1);
        renderImages();
      };
      reader.readAsText(file);
    }
    renderImages();
  }
  /** Images go as images, anything else is tried as a text document. */
  function addFiles(files) {
    addImages(files.filter((file) => IMAGE_TYPES.includes(file.type)));
    addDocs(files.filter((file) => !IMAGE_TYPES.includes(file.type)));
  }
  function addImages(files) {
    for (const file of files) {
      if (!IMAGE_TYPES.includes(file.type)) continue;
      if (state.images.length >= MAX_IMAGES) {
        addNote(`⚠ At most ${MAX_IMAGES} images per message.`);
        break;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        addNote(`⚠ ${file.name || "The image"} is over 5 MB.`);
        continue;
      }
      const entry = { name: file.name || `pasted-${state.images.length + 1}.${file.type.split("/")[1]}`, type: file.type, data: "" };
      state.images.push(entry);
      const reader = new FileReader();
      reader.onload = () => {
        entry.data = String(reader.result).replace(/^data:[^,]*,/, "");
        renderImages();
      };
      reader.onerror = () => {
        state.images.splice(state.images.indexOf(entry), 1);
        renderImages();
      };
      reader.readAsDataURL(file);
    }
  }
  input.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files ?? [])].filter((file) => IMAGE_TYPES.includes(file.type));
    if (!files.length) return;
    e.preventDefault();
    addImages(files);
  });
  $("composer").addEventListener("dragover", (e) => e.preventDefault());
  $("composer").addEventListener("drop", (e) => {
    e.preventDefault();
    addFiles([...(e.dataTransfer?.files ?? [])]);
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
