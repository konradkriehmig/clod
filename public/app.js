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
  let models = [];
  let current = null;
  let inflight = null;

  const save = () => localStorage.setItem(STORE_KEY, JSON.stringify(conversations));
  const savePrefs = () => localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));
  const modelName = (id) => models.find((m) => m.id === id)?.name || id;

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
    const fallback = models.find((m) => /sonnet/i.test(m.id))?.id || models[0].id;
    els.model.value = models.some((m) => m.id === preferred) ? preferred : fallback;
    renderEffort();
  }

  function renderEffort() {
    const m = models.find((x) => x.id === els.model.value);
    const efforts = m?.reasoningEfforts || [];
    els.effort.style.display = efforts.length ? "" : "none";
    els.effort.innerHTML =
      `<option value="">Defualt thinkin</option>` +
      efforts.map((e) => `<option value="${e}">Thinkin: ${e}</option>`).join("");
    const preferred = current?.effort ?? prefs.effort ?? "";
    els.effort.value = efforts.includes(preferred) ? preferred : "";
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
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      bubble.textContent = msg.text;
      wrap.append(bubble);
    } else {
      wrap.className = "msg assistant" + (msg.error ? " error" : "");
      wrap.innerHTML = `<img class="avatar" src="/logo.svg" alt=""><div class="body-col" style="flex:1;min-width:0">
        <details class="thinking" hidden><summary>Thinkign…</summary><div class="body"></div></details>
        <div class="content"></div><div class="meta"></div></div>`;
      updateAssistant(wrap, msg, false);
    }
    els.messages.append(wrap);
    return wrap;
  }

  function updateAssistant(wrap, msg, streaming) {
    wrap.classList.toggle("streaming", streaming);
    const thinking = wrap.querySelector(".thinking");
    if (msg.thinking) {
      thinking.hidden = false;
      thinking.querySelector("summary").textContent = streaming && !msg.text ? "Thinkign…" : "Thot proccess";
      thinking.querySelector(".body").textContent = msg.thinking;
    }
    const content = wrap.querySelector(".content");
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
      label.textContent = modelName(msg.model) + (msg.effort ? ` · ${msg.effort}` : "") + (msg.stopped ? " · stoped" : "");
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

  function scrollToBottom(force) {
    const m = els.messages;
    const nearBottom = m.scrollHeight - m.scrollTop - m.clientHeight < 140;
    if (force || nearBottom) m.scrollTop = m.scrollHeight;
  }

  // ---------- Sending ----------
  async function send(text) {
    const model = els.model.value;
    if (!models.some((m) => m.id === model)) return;
    const effort = els.effort.value;

    if (!current) {
      current = { id: uid(), serverId: null, title: text.slice(0, 60), messages: [], updatedAt: Date.now() };
      conversations.push(current);
    }
    const convo = current;
    convo.model = model;
    convo.effort = effort;
    convo.updatedAt = Date.now();

    const userMsg = { role: "user", text };
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
        body: JSON.stringify({ conversationId: convo.serverId, model, effort, prompt: text }),
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
          else if (event === "message") {
            // Final full message; only needed if no deltas arrived.
            if (!reply.text && data.text) reply.text = data.text;
          } else if (event === "error") throw new Error(data.error);
          else if (event === "done") done = true;
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
    }
  }

  function setBusy(busy) {
    els.send.classList.toggle("stop", busy);
    els.send.textContent = busy ? "■" : "↑";
    els.send.title = busy ? "Stahp" : "Sned";
    els.send.disabled = !busy && !els.prompt.value.trim();
  }

  els.composer.addEventListener("submit", (e) => {
    e.preventDefault();
    if (inflight) return inflight.abort();
    const text = els.prompt.value.trim();
    if (!text) return;
    els.prompt.value = "";
    autosize();
    send(text);
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
    if (!inflight) els.send.disabled = !els.prompt.value.trim();
  }
  els.prompt.addEventListener("input", autosize);

  // ---------- Chrome ----------
  $("#new-chat").addEventListener("click", newChat);
  $("#toggle-sidebar").addEventListener("click", () => document.body.classList.add("sidebar-hidden"));
  $("#open-sidebar").addEventListener("click", () => document.body.classList.remove("sidebar-hidden"));

  setGreeting();
  renderList();
  setBusy(false);
  loadModels();
})();
