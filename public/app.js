(() => {
  const $ = (s) => document.querySelector(s);
  const els = {
    list: $("#conversation-list"),
    messages: $("#messages"),
    composer: $("#composer"),
    prompt: $("#prompt"),
    send: $("#send"),
    model: $("#model"),
    effort: $("#effort"),
    greeting: $("#greeting"),
  };

  const STORE_KEY = "clod.conversations.v1";
  const PREFS_KEY = "clod.prefs.v1";
  let conversations = JSON.parse(localStorage.getItem(STORE_KEY) || "[]");
  let prefs = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
  if (!prefs.sonet55) { delete prefs.model; prefs.sonet55 = true; localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); }
  let models = [];
  let current = null;
  let inflight = null;

  const save = () => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(conversations));
    } catch {
      // Storage full (probably pics): drop old thumbnails and try again. The server still has them.
      conversations.forEach((c) => c !== current && c.messages.forEach((m) => delete m.images));
      try { localStorage.setItem(STORE_KEY, JSON.stringify(conversations)); } catch {}
    }
    scheduleSync();
  };

  // ---------- Server sync (so chats show up in every browser) ----------
  conversations.forEach((c) => (c.id = String(c.id).replace(/[^\w-]/g, "-")));
  const synced = new Map(); // id -> JSON last stored on the server
  let syncTimer = null;
  let syncReady = false;
  function scheduleSync() {
    if (!syncReady) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(pushChats, 400);
  }
  async function pushChats() {
    for (const c of conversations) {
      if (!c.messages?.length) continue;
      const json = JSON.stringify(c);
      if (synced.get(c.id) === json) continue;
      try {
        const r = await fetch(`/api/chats/${c.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: json,
        });
        if (r.ok) synced.set(c.id, json);
      } catch {}
    }
  }
  async function pullChats() {
    try {
      const r = await fetch("/api/chats");
      if (!r.ok) throw new Error();
      const { chats, deleted } = await r.json();
      const gone = new Set(deleted);
      let currentChanged = !!current && gone.has(current.id);
      conversations = conversations.filter((c) => !gone.has(c.id));
      for (const s of chats) {
        const local = conversations.find((c) => c.id === s.id);
        if (!local) conversations.push(s);
        else if (
          !(local === current && inflight) &&
          ((s.updatedAt || 0) > (local.updatedAt || 0) ||
            (s.updatedAt === local.updatedAt && s.dumbTitle === 2 && local.dumbTitle !== 2))
        ) {
          Object.assign(local, s);
          if (local === current) currentChanged = true;
        }
        synced.set(s.id, JSON.stringify(conversations.find((c) => c.id === s.id)));
      }
      syncReady = true;
      save();
      if (currentChanged) openConversation(current.id);
      else renderList();
    } catch {
      setTimeout(pullChats, 5000);
    }
  }
  addEventListener("focus", () => syncReady && !inflight && pullChats());
  const savePrefs = () => localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  const uid = () =>
    crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
  const modelName = (id) => models.find((m) => m.id === id)?.name || id;
  const effortName = (e) => ({ medium: "mid", xhigh: "highest", max: "maxxed" })[e] || e;

  function setGreeting() {
    const h = new Date().getHours();
    const part = h < 5 ? "Burnin the midnite oil" : h < 12 ? "Goood mornin" : h < 18 ? "Good afternon" : "Good evenin";
    els.greeting.textContent = `${part}, humman`;
  }

  // ---------- Models ----------
  async function loadModels() {
    els.model.innerHTML = "<option>Loadin modles…</option>";
    try {
      const res = await fetch("/api/models");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      models = data.models;
    } catch (e) {
      els.model.innerHTML = "<option>Coudlnt load modles</option>";
      console.error(e);
      return;
    }
    if (!models.length) {
      els.model.innerHTML = "<option>No Clod modles availble</option>";
      return;
    }
    els.model.innerHTML = models.map((m) => `<option value="${m.id}">${m.name}</option>`).join("");
    const preferred = current?.model || prefs.model;
    const fallback = (models.find((m) => m.id === "claude-sonnet-5.5") || models.find((m) => /sonnet/i.test(m.id)) || models[0]).id;
    els.model.value = models.some((m) => m.id === preferred) ? preferred : fallback;
    renderEffort();
  }

  function renderEffort() {
    const m = models.find((x) => x.id === els.model.value);
    const efforts = m?.reasoningEfforts || [];
    els.effort.style.display = efforts.length ? "" : "none";
    els.effort.innerHTML = efforts.map((e) => `<option value="${e}">Thinkin: ${effortName(e)}</option>`).join("");
    const preferred = current?.effort || prefs.effort || "high";
    els.effort.value = efforts.includes(preferred) ? preferred : efforts.includes("high") ? "high" : efforts[0] || "";
    updateAttachState();
  }

  els.model.addEventListener("change", () => {
    prefs.model = els.model.value;
    savePrefs();
    renderEffort();
  });
  els.effort.addEventListener("change", () => {
    prefs.effort = els.effort.value;
    savePrefs();
  });

  // ---------- Sidebar ----------
  function renderList() {
    els.list.innerHTML = "";
    [...conversations]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .forEach((c) => {
        const row = document.createElement("div");
        row.className = "conv" + (current?.id === c.id ? " active" : "");
        const title = document.createElement("span");
        title.className = "title";
        title.textContent = c.title || "New chatt";
        const del = document.createElement("button");
        del.className = "del";
        del.title = "Delet";
        del.textContent = "✕";
        del.addEventListener("click", (e) => {
          e.stopPropagation();
          deleteConversation(c.id);
        });
        row.append(title, del);
        row.addEventListener("click", () => openConversation(c.id));
        els.list.append(row);
      });
  }

  function deleteConversation(id) {
    const c = conversations.find((x) => x.id === id);
    if (!c || !confirm(`Delet "${c.title || "New chatt"}"?`)) return;
    if (c.serverId) fetch(`/api/conversations/${c.serverId}`, { method: "DELETE" }).catch(() => {});
    fetch(`/api/chats/${c.id}`, { method: "DELETE" }).catch(() => {});
    synced.delete(c.id);
    conversations = conversations.filter((x) => x.id !== id);
    save();
    if (current?.id === id) newChat();
    else renderList();
  }

  function newChat() {
    if (inflight) inflight.abort();
    current = null;
    els.messages.innerHTML = "";
    document.body.classList.remove("has-messages");
    setGreeting();
    renderList();
    if (models.length) {
      els.model.value = models.some((m) => m.id === prefs.model) ? prefs.model : els.model.value;
      renderEffort();
    }
    els.prompt.focus();
  }

  function openConversation(id) {
    if (inflight) inflight.abort();
    current = conversations.find((c) => c.id === id) || null;
    els.messages.innerHTML = "";
    if (!current) return newChat();
    document.body.classList.toggle("has-messages", current.messages.length > 0);
    current.messages.forEach((m) => appendMessage(m));
    if (models.some((m) => m.id === current.model)) {
      els.model.value = current.model;
      renderEffort();
    }
    renderList();
    scrollToBottom(true);
  }

  // ---------- Messages ----------
  function appendMessage(msg) {
    const wrap = document.createElement("div");
    if (msg.role === "user") {
      wrap.className = "msg user";
      const stack = document.createElement("div");
      stack.className = "stack";
      if (msg.images?.length) {
        const pics = document.createElement("div");
        pics.className = "pics";
        msg.images.forEach((src) => {
          const img = document.createElement("img");
          img.src = src;
          img.alt = "atached pic";
          img.addEventListener("click", () => window.open().document.write(`<img src="${src}" style="max-width:100%">`));
          pics.append(img);
        });
        stack.append(pics);
      }
      if (msg.text) {
        const bubble = document.createElement("div");
        bubble.className = "bubble";
        bubble.textContent = msg.text;
        stack.append(bubble);
      }
      wrap.append(stack);
    } else {
      wrap.className = "msg assistant" + (msg.error ? " error" : "");
      wrap.innerHTML = `<img class="avatar" src="/logo.svg" alt=""><div class="body-col" style="flex:1;min-width:0">
        <details class="thinking" hidden><summary>Thinkign…</summary><div class="body"></div></details>
        <div class="status" hidden></div>
        <div class="content"></div><div class="meta"></div></div>`;
      updateAssistant(wrap, msg, false);
    }
    els.messages.append(wrap);
    return wrap;
  }

  // Clod's version of the whimsical "Pondering…" status words, only dumber.
  const FILLER_WORDS = [
    "Brainin", "Noodlin", "Pondorin", "Smooshin thoughts",
    "Wigglin neurons", "Concoctin", "Percolatering", "Doin a big think", "Schemin", "Bamboozlin",
    "Clodulating", "Head scratchin", "Thunkin",
    "Puzzlin", "Wranglin wurds", "Yeehawin",
    "Doodlin", "Jigglin the wires", "Hmmmin", "Askin my mom",
    "Blowin on the cartridge", "Stirrin the soup", "Countin on fingers",
    "Loadin smartnes", "Turnin it of and on agen",
  ];
  const randomFiller = () => FILLER_WORDS[Math.floor(Math.random() * FILLER_WORDS.length)] + "…";
  setInterval(() => {
    document.querySelectorAll(".msg.assistant.streaming .status:not([hidden])").forEach((s) => {
      s.textContent = randomFiller();
    });
    document.querySelectorAll(".msg.assistant.streaming .thinking.live summary").forEach((s) => {
      s.textContent = randomFiller();
    });
  }, 1800);

  // "Serched the webs" list, like Claude's search chips.
  function renderTools(wrap, content, msg, streaming) {
    let box = wrap.querySelector(".tools");
    if (!msg.tools?.length) return box?.remove();
    if (!box) {
      box = document.createElement("div");
      box.className = "tools";
      content.before(box);
    }
    box.innerHTML = "";
    msg.tools.forEach((t, i) => {
      const live = streaming && i === msg.tools.length - 1 && (msg.text || "").length === t.at;
      const row = document.createElement("div");
      row.className = "tool" + (live ? " live" : "");
      if (t.kind === "search") {
        row.textContent = `🔎 ${live ? "Serchin" : "Serched"} the webs for “${t.label}”${live ? "…" : ""}`;
      } else {
        let host = t.label;
        try { host = new URL(t.label).hostname; } catch {}
        row.append(`🌐 ${live ? "Readin" : "Red"} `);
        const a = document.createElement("a");
        a.textContent = host;
        if (/^https?:\/\//i.test(t.label)) Object.assign(a, { href: t.label, target: "_blank", rel: "noopener noreferrer" });
        row.append(a, live ? "…" : "");
      }
      box.append(row);
    });
  }

  function updateAssistant(wrap, msg, streaming) {
    wrap.classList.toggle("streaming", streaming);
    const status = wrap.querySelector(".status");
    const waiting = streaming && !msg.text && !msg.thinking && !msg.tools?.length;
    if (waiting && status.hidden) status.textContent = randomFiller();
    status.hidden = !waiting;
    const thinking = wrap.querySelector(".thinking");
    if (msg.thinking) {
      thinking.hidden = false;
      const live = streaming && !msg.text;
      const summary = thinking.querySelector("summary");
      if (live && !thinking.classList.contains("live")) summary.textContent = randomFiller();
      if (!live) summary.textContent = "Thot proccess";
      thinking.classList.toggle("live", live);
      thinking.querySelector(".body").textContent = msg.thinking;
    }
    const content = wrap.querySelector(".content");
    renderTools(wrap, content, msg, streaming);
    if (msg.error) {
      content.textContent = `⚠ ${msg.error}`;
    } else {
      content.innerHTML = window.renderMarkdown(msg.text || "");
      if (streaming) {
        const target = content.lastElementChild && !/^(PRE|TABLE|UL|OL)$/.test(content.lastElementChild.tagName)
          ? content.lastElementChild
          : content;
        const cursor = document.createElement("span");
        cursor.className = "cursor";
        target.append(cursor);
      }
    }
    const meta = wrap.querySelector(".meta");
    meta.innerHTML = "";
    if (!streaming && msg.model) {
      const label = document.createElement("span");
      label.textContent = modelName(msg.model) + (msg.effort ? ` · ${effortName(msg.effort)}` : "") + (msg.stopped ? " · stoped" : "");
      meta.append(label);
      if (msg.text) {
        const copy = document.createElement("button");
        copy.textContent = "Coppy";
        copy.addEventListener("click", () => {
          navigator.clipboard.writeText(msg.text);
          copy.textContent = "Copyed!";
          setTimeout(() => (copy.textContent = "Coppy"), 1200);
        });
        meta.append(copy);
      }
    }
  }

  els.messages.addEventListener("click", (e) => {
    const btn = e.target.closest("pre .copy");
    if (!btn) return;
    navigator.clipboard.writeText(btn.parentElement.querySelector("code").textContent);
    btn.textContent = "Copyed!";
    setTimeout(() => (btn.textContent = "Coppy"), 1200);
  });

  // Follow new text only while the user hasn't scrolled away from the bottom.
  let stickToBottom = true;
  let lastScrollTop = 0;
  const atBottom = () => {
    const m = els.messages;
    return m.scrollHeight - m.scrollTop - m.clientHeight < 8;
  };
  els.messages.addEventListener("wheel", (e) => { if (e.deltaY < 0) stickToBottom = false; }, { passive: true });
  els.messages.addEventListener("touchmove", () => { stickToBottom = atBottom(); }, { passive: true });
  els.messages.addEventListener("scroll", () => {
    const top = els.messages.scrollTop;
    if (top < lastScrollTop - 2) stickToBottom = false;
    if (atBottom()) stickToBottom = true;
    lastScrollTop = top;
  }, { passive: true });

  function scrollToBottom(force) {
    const m = els.messages;
    if (force) stickToBottom = true;
    if (stickToBottom) {
      m.scrollTop = m.scrollHeight;
      lastScrollTop = m.scrollTop;
    }
  }

  // ---------- Dumb titles ----------
  const titling = new Set();
  async function retitle(convo) {
    const firstMsg = convo.messages.find((m) => m.role === "user");
    const first = firstMsg && (firstMsg.text || (firstMsg.images?.length ? "(user sent a screenshot/foto with no text)" : ""));
    if (!first || convo.dumbTitle === 2 || titling.has(convo.id)) return;
    titling.add(convo.id);
    try {
      const res = await fetch("/api/title", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: first }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      convo.title = data.title;
      convo.dumbTitle = 2;
      save();
      renderList();
    } catch (e) {
      console.warn("Title failed", e);
      if (convo.title === "thinkin of a naem…") {
        convo.title = first.slice(0, 60);
        save();
        renderList();
      }
    } finally {
      titling.delete(convo.id);
    }
  }

  async function retitleOldChats() {
    for (const c of conversations.filter((c) => c.dumbTitle !== 2)) await retitle(c);
  }

  // ---------- Photos ----------
  const MAX_SIDE = 1568;
  const MAX_BYTES = 3 * 1024 * 1024;
  let pending = []; // { name, mimeType, data (base64), preview (dataURL) }
  const attachEls = { strip: $("#attachments"), btn: $("#attach"), input: $("#file-input") };

  function toast(text) {
    const t = document.createElement("div");
    t.className = "toast";
    t.textContent = text;
    document.body.append(t);
    setTimeout(() => t.remove(), 2600);
  }

  const currentModel = () => models.find((m) => m.id === els.model.value);
  const maxImages = () => (currentModel()?.vision ? currentModel().maxImages : 0);

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Coudnt read that pic"));
      img.src = url;
    });
  }

  function canvasFor(img, maxSide) {
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(img.naturalWidth * scale));
    c.height = Math.max(1, Math.round(img.naturalHeight * scale));
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return c;
  }

  async function prepareImage(file) {
    const img = await loadImage(file);
    const c = canvasFor(img, MAX_SIDE);
    // Screenshots stay crisp as PNG; fall back to JPEG if too big.
    let dataUrl = c.toDataURL("image/png");
    let mimeType = "image/png";
    for (const q of [0.9, 0.8, 0.65, 0.5]) {
      if (dataUrl.length * 0.75 <= MAX_BYTES) break;
      dataUrl = c.toDataURL("image/jpeg", q);
      mimeType = "image/jpeg";
    }
    const preview = canvasFor(img, 440).toDataURL("image/jpeg", 0.8);
    URL.revokeObjectURL(img.src);
    return { name: file.name || "screenshot.png", mimeType, data: dataUrl.split(",")[1], preview };
  }

  async function addFiles(files) {
    const imgs = [...files].filter((f) => f.type.startsWith("image/"));
    if (!imgs.length) return;
    const limit = maxImages();
    if (!limit) return toast(`${currentModel()?.name || "This modle"} cant see pics`);
    for (const f of imgs) {
      if (pending.length >= limit) {
        toast(`${currentModel().name} only takes ${limit} pic${limit > 1 ? "s" : ""} at a tiem`);
        break;
      }
      try {
        pending.push(await prepareImage(f));
      } catch (e) {
        toast(e.message);
      }
    }
    renderPending();
  }

  function renderPending() {
    attachEls.strip.hidden = !pending.length;
    attachEls.strip.innerHTML = "";
    pending.forEach((p, i) => {
      const t = document.createElement("div");
      t.className = "thumb";
      t.innerHTML = `<img src="${p.preview}" alt=""><button type="button" class="rm" title="Remuve">✕</button>`;
      t.querySelector(".rm").addEventListener("click", () => {
        pending.splice(i, 1);
        renderPending();
      });
      attachEls.strip.append(t);
    });
    updateAttachState();
    autosize();
  }

  function updateAttachState() {
    const limit = maxImages();
    attachEls.btn.disabled = !limit;
    attachEls.btn.title = limit ? `Atach a pic (or just pasete it) · max ${limit}` : "This modle cant see pics";
  }

  attachEls.btn.addEventListener("click", () => attachEls.input.click());
  attachEls.input.addEventListener("change", () => {
    addFiles(attachEls.input.files);
    attachEls.input.value = "";
  });
  // Paste screenshots from anywhere on the page.
  document.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.items || [])]
      .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
      .map((it) => it.getAsFile())
      .filter(Boolean);
    if (!files.length) return;
    e.preventDefault();
    addFiles(files);
    els.prompt.focus();
  });
  let dragDepth = 0;
  document.addEventListener("dragenter", (e) => {
    if (![...e.dataTransfer.types].includes("Files")) return;
    dragDepth++;
    document.body.classList.add("dragging");
  });
  document.addEventListener("dragleave", () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      document.body.classList.remove("dragging");
    }
  });
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove("dragging");
    addFiles(e.dataTransfer.files);
  });
  els.model.addEventListener("change", () => {
    const limit = maxImages();
    if (pending.length > limit) {
      pending = pending.slice(0, limit);
      toast(limit ? `This modle only takes ${limit} pic${limit > 1 ? "s" : ""}, removd the rest` : "This modle cant see pics, removd them");
    }
    renderPending();
  });

  // ---------- Sending ----------
  async function send(text, images = [], opts = {}) {
    const model = els.model.value;
    if (!models.some((m) => m.id === model)) return;
    const effort = els.effort.value;

    if (!current) {
      current = { id: uid(), serverId: null, title: "thinkin of a naem…", messages: [], updatedAt: Date.now() };
      conversations.push(current);
    }
    const convo = current;
    convo.model = model;
    convo.effort = effort;
    convo.updatedAt = Date.now();

    const userMsg = { role: "user", text, images: images.map((i) => i.preview) };
    convo.messages.push(userMsg);
    document.body.classList.add("has-messages");
    appendMessage(userMsg);

    const reply = { role: "assistant", text: "", thinking: "", model, effort };
    convo.messages.push(reply);
    const wrap = appendMessage(reply);
    updateAssistant(wrap, reply, true);
    scrollToBottom(true);
    save();
    renderList();

    const controller = new AbortController();
    inflight = controller;
    setBusy(true);

    let renderQueued = false;
    let finished = false;
    const rerender = () => {
      if (renderQueued) return;
      renderQueued = true;
      requestAnimationFrame(() => {
        renderQueued = false;
        if (convo === current && !finished) {
          updateAssistant(wrap, reply, true);
          scrollToBottom();
        }
      });
    };

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: convo.serverId,
          model,
          effort,
          prompt: text,
          voice: Boolean(opts.voice),
          images: images.map(({ name, mimeType, data }) => ({ name, mimeType, data })),
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || res.statusText);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let done = false;
      while (!done) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const event = raw.match(/^event: (.*)$/m)?.[1];
          const data = JSON.parse(raw.match(/^data: (.*)$/m)?.[1] || "{}");
          if (event === "session") convo.serverId = data.conversationId;
          else if (event === "delta") reply.text += data.text;
          else if (event === "thinking") reply.thinking += data.text;
          else if (event === "tool") {
            if (reply.text && !reply.text.endsWith("\n\n")) reply.text += "\n\n";
            (reply.tools ??= []).push({ kind: data.kind, label: data.label, at: reply.text.length });
          }
          else if (event === "message") {
            // Final full message; only needed if no deltas arrived.
            if (!reply.text && data.text) reply.text = data.text;
          } else if (event === "error") throw new Error(data.error);
          else if (event === "done") done = true;
          opts.onUpdate?.(reply);
          rerender();
        }
      }
    } catch (e) {
      if (e.name === "AbortError") reply.stopped = true;
      else if (!reply.text) reply.error = e.message || "Somthing went wrong";
      else reply.text += `\n\n*⚠ ${e.message}*`;
    } finally {
      finished = true;
      inflight = null;
      setBusy(false);
      convo.updatedAt = Date.now();
      save();
      if (convo === current) {
        updateAssistant(wrap, reply, false);
        scrollToBottom();
      }
      renderList();
      retitle(convo);
      opts.onDone?.(reply);
    }
  }

  function setBusy(busy) {
    els.send.classList.toggle("stop", busy);
    els.send.textContent = busy ? "■" : "↑";
    els.send.title = busy ? "Stahp" : "Sned";
    els.send.disabled = !busy && !els.prompt.value.trim() && !pending.length;
  }

  els.composer.addEventListener("submit", (e) => {
    e.preventDefault();
    if (inflight) return inflight.abort();
    const text = els.prompt.value.trim();
    if (!text && !pending.length) return;
    const images = pending;
    pending = [];
    renderPending();
    els.prompt.value = "";
    autosize();
    send(text, images);
  });

  els.prompt.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!inflight) els.composer.requestSubmit();
    }
  });

  function autosize() {
    els.prompt.style.height = "auto";
    els.prompt.style.height = Math.min(els.prompt.scrollHeight, 260) + "px";
    if (!inflight) els.send.disabled = !els.prompt.value.trim() && !pending.length;
  }
  els.prompt.addEventListener("input", autosize);

  // ---------- Voice mode ----------
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  const voiceEls = {
    btn: $("#voice"), overlay: $("#voice-mode"), orb: $("#voice-orb"), status: $("#voice-status"),
    caption: $("#voice-caption"), mute: $("#voice-mute"), end: $("#voice-end"),
  };
  const voice = { on: false, muted: false, rec: null, gen: 0, queue: 0, spokenUpTo: 0, replyDone: false, ttsVoice: null };

  if (!SpeechRec || !window.speechSynthesis) {
    voiceEls.btn.title = "Ur browzer cant do voice. try Edge or Chrome";
    voiceEls.btn.disabled = true;
    voiceEls.btn.style.opacity = ".35";
  }

  const VOICE_KEY = "clod.voice";
  function pickTtsVoice() {
    const all = speechSynthesis.getVoices();
    const lang = (navigator.language || "en-US").slice(0, 2);
    const mine = all.filter((v) => v.lang.startsWith(lang));
    voice.ttsVoice =
      all.find((v) => v.voiceURI === localStorage.getItem(VOICE_KEY)) ||
      mine.find((v) => /natural/i.test(v.name) && /aria|jenny|ava|emma|sonia/i.test(v.name)) ||
      mine.find((v) => /natural|online|google/i.test(v.name)) ||
      mine.find((v) => v.default) || mine[0] || all[0] || null;
    renderVoiceSelect(all, lang);
  }

  // Voices in your language first, then the rest.
  function renderVoiceSelect(all, lang) {
    const sel = $("#voice-select");
    sel.innerHTML = "";
    const groups = [
      ["Ur langwage", all.filter((v) => v.lang.startsWith(lang))],
      ["Forin", all.filter((v) => !v.lang.startsWith(lang))],
    ];
    for (const [label, list] of groups) {
      if (!list.length) continue;
      const g = document.createElement("optgroup");
      g.label = label;
      for (const v of [...list].sort((a, b) => a.name.localeCompare(b.name))) {
        const name = v.name.replace(/^(Microsoft|Google)\s+/, "");
        const o = new Option(/\(.+\)/.test(name) ? name : `${name} (${v.lang})`, v.voiceURI);
        o.selected = v === voice.ttsVoice;
        g.append(o);
      }
      sel.append(g);
    }
    sel.disabled = !all.length;
  }

  $("#voice-select").addEventListener("change", (e) => {
    const v = speechSynthesis.getVoices().find((x) => x.voiceURI === e.target.value);
    if (!v) return;
    voice.ttsVoice = v;
    localStorage.setItem(VOICE_KEY, v.voiceURI);
    // Preview it while Clod is just listening; pause the mic so it doesn't hear itself.
    if (voice.on && voice.replyDone && !voice.queue) {
      stopRec();
      speechSynthesis.cancel();
      const gen = voice.gen;
      const u = new SpeechSynthesisUtterance("Hi, I'm Clod. This is what I sound like now.");
      u.voice = v;
      u.rate = 1.05;
      setVoiceState("speaking", "Tlaking…");
      u.onend = u.onerror = () => {
        if (voice.on && voice.gen === gen && voice.replyDone && !voice.queue) listen();
      };
      speechSynthesis.speak(u);
    }
  });
  if (window.speechSynthesis) {
    pickTtsVoice();
    speechSynthesis.addEventListener?.("voiceschanged", pickTtsVoice);
  }

  function setVoiceState(state, text) {
    voiceEls.overlay.className = state + (voice.muted ? " muted" : "");
    voiceEls.status.textContent = voice.muted && state === "listening" ? "Mic is muted" : text;
  }

  // Turn markdown into something that sounds OK when read aloud.
  function speakable(md) {
    return md
      .replace(/```[\s\S]*?(```|$)/g, " (theres some code on the screen) ")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/https?:\/\/\S+/g, "a link")
      .replace(/^\s*[-*+]\s+/gm, "")
      .replace(/^\s*#+\s*/gm, "")
      .replace(/[*_~#>|]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function speak(text) {
    const clean = speakable(text);
    if (!clean) return;
    const u = new SpeechSynthesisUtterance(clean);
    if (voice.ttsVoice) u.voice = voice.ttsVoice;
    u.rate = 1.05;
    const gen = voice.gen;
    voice.queue++;
    u.onend = u.onerror = () => {
      if (gen !== voice.gen) return;
      voice.queue--;
      afterSpeech();
    };
    speechSynthesis.speak(u);
  }

  // Speak complete sentences as they stream in, so it starts talking early.
  function speakNewSentences(reply, final) {
    if (!voice.on) return;
    const text = reply.text;
    const rest = text.slice(voice.spokenUpTo);
    let cut = -1;
    if (final) cut = rest.length;
    else {
      // Don't cut inside an open code block.
      if ((text.slice(0, voice.spokenUpTo).match(/```/g) || []).length % 2) return;
      const re = /[.!?](?=\s)|\n\n/g;
      let m;
      while ((m = re.exec(rest))) cut = m.index + m[0].length;
      if ((rest.slice(0, cut).match(/```/g) || []).length % 2) cut = rest.slice(0, cut).lastIndexOf("```");
    }
    if (cut <= 0) return;
    const chunk = rest.slice(0, cut);
    voice.spokenUpTo += cut;
    if (chunk.trim()) {
      setVoiceState("speaking", "Tlaking…");
      speak(chunk);
    }
  }

  function afterSpeech() {
    if (!voice.on || voice.queue > 0 || !voice.replyDone) return;
    listen();
  }

  function listen() {
    if (!voice.on) return;
    if (voice.muted) return setVoiceState("listening", "Mic is muted");
    stopRec();
    const rec = new SpeechRec();
    voice.rec = rec;
    rec.lang = navigator.language || "en-US";
    rec.interimResults = true;
    rec.continuous = false;
    let finalText = "";
    let failed = false;
    rec.onresult = (e) => {
      let interim = "";
      finalText = "";
      for (const r of e.results) (r.isFinal ? (finalText += r[0].transcript) : (interim += r[0].transcript));
      voiceEls.caption.textContent = (finalText + interim).trim();
    };
    rec.onerror = (e) => {
      failed = true;
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        toast("Clod cant hear u. alow the microfone pls");
        stopVoice();
      } else if (e.error === "network") {
        toast("speach thing needs internet");
        stopVoice();
      }
    };
    rec.onend = () => {
      if (voice.rec !== rec || !voice.on) return;
      voice.rec = null;
      const said = finalText.trim();
      if (said) voiceTurn(said);
      else if (!failed || !voice.on) setTimeout(listen, 150); // silence: keep listening
      else setTimeout(listen, 600);
    };
    setVoiceState("listening", "Lisening…");
    voiceEls.caption.textContent = "";
    try {
      rec.start();
    } catch {
      setTimeout(listen, 400);
    }
  }

  function stopRec() {
    const rec = voice.rec;
    voice.rec = null;
    try { rec?.abort(); } catch {}
  }

  function voiceTurn(text) {
    if (!els.model.value) return;
    voice.spokenUpTo = 0;
    voice.replyDone = false;
    setVoiceState("thinking", "Thinkin…");
    voiceEls.caption.textContent = text;
    send(text, [], {
      voice: true,
      onUpdate: (reply) => speakNewSentences(reply, false),
      onDone: (reply) => {
        if (!voice.on) return;
        voice.replyDone = true;
        if (reply.error) speak(`uh oh. ${reply.error}`);
        else if (!reply.stopped) speakNewSentences(reply, true);
        afterSpeech();
      },
    });
  }

  function interrupt() {
    if (!voice.on) return;
    voice.gen++;
    speechSynthesis.cancel();
    voice.queue = 0;
    if (inflight) inflight.abort(); // onDone will kick off listening
    else {
      voice.replyDone = true;
      listen();
    }
  }

  function startVoice() {
    if (voiceEls.btn.disabled) return;
    if (!models.some((m) => m.id === els.model.value)) return toast("no modle yet, hold on");
    if (inflight) inflight.abort();
    voice.on = true;
    voice.gen++;
    voice.queue = 0;
    voice.replyDone = true;
    voiceEls.overlay.hidden = false;
    speechSynthesis.cancel();
    // A tiny silent utterance unlocks speech synthesis from this click.
    speechSynthesis.speak(Object.assign(new SpeechSynthesisUtterance(" "), { volume: 0 }));
    listen();
  }

  function stopVoice() {
    voice.on = false;
    stopRec();
    voice.gen++;
    speechSynthesis.cancel();
    voice.queue = 0;
    if (inflight) inflight.abort();
    voiceEls.overlay.hidden = true;
    els.prompt.focus();
  }

  voiceEls.btn.addEventListener("click", startVoice);
  voiceEls.end.addEventListener("click", stopVoice);
  voiceEls.orb.addEventListener("click", interrupt);
  voiceEls.mute.addEventListener("click", () => {
    voice.muted = !voice.muted;
    voiceEls.mute.textContent = voice.muted ? "🔇" : "🎙";
    if (voice.muted) {
      stopRec();
      if (voiceEls.overlay.classList.contains("listening")) setVoiceState("listening", "Mic is muted");
    } else if (voice.replyDone && voice.queue === 0) listen();
  });
  document.addEventListener("keydown", (e) => {
    if (voice.on && e.key === "Escape") stopVoice();
  });

  // ---------- Chrome ----------
  $("#new-chat").addEventListener("click", newChat);
  $("#toggle-sidebar").addEventListener("click", () => document.body.classList.add("sidebar-hidden"));
  $("#open-sidebar").addEventListener("click", () => document.body.classList.remove("sidebar-hidden"));
  // On phones the sidebar sits on top of the chat, so keep it closed unless asked for.
  const isNarrow = () => matchMedia("(max-width: 720px)").matches;
  if (isNarrow()) document.body.classList.add("sidebar-hidden");
  $("#sidebar").addEventListener("click", (e) => {
    if (isNarrow() && !e.target.closest(".del") && e.target.closest(".conv, #new-chat")) {
      document.body.classList.add("sidebar-hidden");
    }
  });

  setGreeting();
  renderList();
  setBusy(false);
  pullChats();
  loadModels().then(retitleOldChats);
})();
