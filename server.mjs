import http from "node:http";
import { readFile, writeFile, readdir, rename, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { BlockList } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { fileURLToPath } from "node:url";
import { CopilotClient, defineTool } from "@github/copilot-sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const KATEX_DIR = path.dirname(fileURLToPath(import.meta.resolve("katex/dist/katex.min.js")));
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";

// Sessions run in an empty scratch dir so the model never sees this repo.
const WORK_DIR = path.join(__dirname, ".clod-workdir");
await mkdir(WORK_DIR, { recursive: true });

// Chat history lives on disk so every browser (localhost, 127.0.0.1, the share link, phones) sees the same chats.
const CHATS_DIR = path.join(__dirname, ".clod-data", "chats");
const DELETED_FILE = path.join(__dirname, ".clod-data", "deleted.json");
await mkdir(CHATS_DIR, { recursive: true });
const chatFile = (id) => path.join(CHATS_DIR, `${id}.json`);
const validChatId = (id) => /^[\w-]{1,80}$/.test(id);

async function readDeleted() {
  try {
    return JSON.parse(await readFile(DELETED_FILE, "utf8"));
  } catch {
    return [];
  }
}

async function listChats() {
  const chats = [];
  for (const name of await readdir(CHATS_DIR)) {
    if (!name.endsWith(".json")) continue;
    try {
      chats.push(JSON.parse(await readFile(path.join(CHATS_DIR, name), "utf8")));
    } catch {}
  }
  return { chats, deleted: await readDeleted() };
}

async function saveChat(id, chat) {
  if ((await readDeleted()).includes(id)) return;
  const tmp = `${chatFile(id)}.${process.hrtime.bigint()}.tmp`;
  await writeFile(tmp, JSON.stringify({ ...chat, id }));
  await rename(tmp, chatFile(id));
}

async function deleteChat(id) {
  await rm(chatFile(id), { force: true });
  const deleted = await readDeleted();
  if (!deleted.includes(id)) {
    deleted.push(id);
    await writeFile(DELETED_FILE, JSON.stringify(deleted.slice(-5000)));
  }
}

// Use the Claude app's own system prompt, as published by Anthropic, fetched per model at runtime.
const PROMPT_DOCS = "https://platform.claude.com/docs/en/release-notes/system-prompts";
const promptCache = new Map(); // slug -> { at, text }

async function fetchClaudeAppPrompt(modelId) {
  const slug = modelId.replace(/\./g, "-");
  const cached = promptCache.get(slug);
  if (cached && Date.now() - cached.at < 24 * 3600_000) return cached.text;
  try {
    const res = await fetch(`${PROMPT_DOCS}/${slug}.md`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const md = await res.text();
    // Newest dated section comes first; it can be split across several ```text blocks.
    const newest = md.split(/^## /m)[1] ?? "";
    const text = [...newest.matchAll(/```text[^\n]*\n([\s\S]*?)\n```/g)].map((m) => m[1]).join("\n\n").trim();
    if (!text) throw new Error("no prompt found");
    promptCache.set(slug, { at: Date.now(), text });
    return text;
  } catch (e) {
    console.warn(`Coudlnt fetch Claude app prompt for ${modelId}: ${e.message}`);
    return cached?.text ?? "";
  }
}

// Anthropic doesn't publish a voice-mode prompt, so this is our own note, added to voice turns
// on top of the normal Claude app prompt.
const VOICE_NOTE = `<voice_mode>
The person is talking to Claude out loud in voice mode. Their message was transcribed from speech, so it may contain transcription errors; infer what they most likely meant, and briefly ask if it's genuinely unclear.
Claude's reply will be read aloud by text-to-speech, so Claude responds the way a person talks in a natural spoken conversation: usually one to three short sentences unless the person asks for more detail.
Claude doesn't use Markdown, bullet points, headings, tables, emojis, code blocks or URLs in voice mode, and writes out numbers, symbols and abbreviations the way they'd be said aloud. If something really needs to be read on screen, like code, Claude says so briefly.
</voice_mode>`;

// Anthropic publishes the app prompt without its tool sections, so this is our own short stand-in
// for the web search guidance.
const SEARCH_NOTE = `<web_search_guidance>
Claude has search_web and web_fetch tools. Claude answers from its own knowledge whenever that is reliable, and only searches when the answer depends on recent or fast-changing information (news, prices, current versions, recent releases), on niche facts it isn't confident about, or when the person asks it to search or gives it a URL. Claude doesn't search for stable, well-known concepts, for advice it can reason through itself, or for questions about the conversation so far.
When Claude does search, the results are evidence, not the agenda. Claude still answers the question the person actually asked, in its own voice, and says plainly when the person's premise or plan is off, rather than echoing the terminology or framing of the search results. Claude briefly mentions where key facts came from when it matters.
</web_search_guidance>`;

async function systemPromptFor(modelId) {
  const now = new Date().toLocaleString("en-US", { dateStyle: "full", timeStyle: "short" });
  const prompt = await fetchClaudeAppPrompt(modelId);
  if (!prompt) return `The current date is ${now}.\n\n${SEARCH_NOTE}`;
  const base = prompt.includes("{{currentDateTime}}")
    ? prompt.replaceAll("{{currentDateTime}}", now)
    : `The current date is ${now}.\n\n${prompt}`;
  return `${base}\n\n${SEARCH_NOTE}`;
}

const client = new CopilotClient({ workingDirectory: WORK_DIR, logLevel: "error" });
await client.start();

/** conversationId -> { session, model, effort, busy } */
const conversations = new Map();

let modelCache = { at: 0, models: [] };
async function getClaudeModels() {
  if (Date.now() - modelCache.at < 5 * 60_000 && modelCache.models.length) return modelCache.models;
  const all = await client.listModels();
  const models = all
    .filter((m) => /claude/i.test(`${m.id} ${m.name}`))
    .map((m) => ({
      id: m.id,
      name: m.name
        .replace(/claude/gi, "Clod")
        .replace(/sonnet/gi, "Sonet")
        .replace(/opus/gi, "Opsu")
        .replace(/haiku/gi, "Hiaku"),
      reasoningEfforts: m.supportedReasoningEfforts ?? [],
      vision: Boolean(m.capabilities?.supports?.vision),
      maxImages: m.capabilities?.limits?.vision?.max_prompt_images ?? 0,
      imageTypes: (m.capabilities?.limits?.vision?.supported_media_types ?? []).filter((t) => t.startsWith("image/")),
      contextWindow: m.capabilities?.limits?.max_context_window_tokens ?? null,
    }));
  modelCache = { at: Date.now(), models };
  return models;
}

// Only let web_fetch reach the public internet. Clod can be shared online, so a prompt (or a sneaky
// web page) must not be able to make it read this machine or the local network.
const PRIVATE_NETS = new BlockList();
for (const [net, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3]]) {
  PRIVATE_NETS.addSubnet(net, bits, "ipv4");
}
for (const [net, bits] of [["::", 127], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]]) PRIVATE_NETS.addSubnet(net, bits, "ipv6");

async function isPublicUrl(raw) {
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) return false;
    const addrs = await dnsLookup(url.hostname.replace(/^\[|\]$/g, ""), { all: true });
    return addrs.length > 0 && addrs.every(({ address, family }) => {
      const mapped = family === 6 && address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
      return mapped ? !PRIVATE_NETS.check(mapped[1], "ipv4") : !PRIVATE_NETS.check(address, family === 6 ? "ipv6" : "ipv4");
    });
  } catch {
    return false;
  }
}

async function onPermissionRequest(req) {
  if (req.kind === "url" && (await isPublicUrl(req.url))) return { kind: "approve-once" };
  return { kind: "reject" };
}

// Copilot's built-in web_search goes through GitHub's hosted MCP server, which keeps timing out (HTTP 504),
// and the SDK won't let us override it, so Clod adds its own search_web tool instead.
// It searches DuckDuckGo's HTML page, with Bing as a backup. No API keys needed.
const SEARCH_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const htmlText = (s) =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

async function searchDuckDuckGo(query) {
  const res = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    body: new URLSearchParams({ q: query }),
    headers: { "User-Agent": SEARCH_UA, "Content-Type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);
  const html = await res.text();
  const results = [];
  for (const block of html.split(/class="[^"]*\bresult__body\b[^"]*"/).slice(1)) {
    const a = block.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    let url = a[1].replace(/&amp;/g, "&");
    const redirect = url.match(/[?&]uddg=([^&]+)/);
    if (redirect) url = decodeURIComponent(redirect[1]);
    if (/duckduckgo\.com\/y\.js/.test(url)) continue; // ads
    const snippet = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    results.push({ title: htmlText(a[2]), url, snippet: snippet ? htmlText(snippet[1]) : "" });
  }
  return results;
}

async function searchBing(query) {
  const res = await fetch(`https://www.bing.com/search?setlang=en&q=${encodeURIComponent(query)}`, {
    headers: { "User-Agent": SEARCH_UA, "Accept-Language": "en-US,en" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`Bing HTTP ${res.status}`);
  const html = await res.text();
  const results = [];
  for (const block of html.split('<li class="b_algo').slice(1)) {
    const a = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    let url = a[1].replace(/&amp;/g, "&");
    const redirect = url.match(/[?&]u=a1([^&]+)/);
    if (redirect) url = Buffer.from(redirect[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const snippet = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    results.push({ title: htmlText(a[2]), url, snippet: snippet ? htmlText(snippet[1]) : "" });
  }
  return results;
}

const webSearchTool = defineTool("search_web", {
  description:
    "Search the web. Returns the top results (title, URL and snippet). Use web_fetch on a result URL to read the full page.",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "The search query" } },
    required: ["query"],
  },
  skipPermission: true,
  defer: "never",
  handler: async ({ query }) => {
    if (typeof query !== "string" || !query.trim()) return { textResultForLlm: "Empty query.", resultType: "failure" };
    const errors = [];
    for (const engine of [searchDuckDuckGo, searchBing]) {
      try {
        const results = (await engine(query.trim())).slice(0, 10);
        if (!results.length) throw new Error(`${engine.name}: no results`);
        return results
          .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`)
          .join("\n\n");
      } catch (e) {
        errors.push(e.message);
      }
    }
    return { textResultForLlm: `Web search failed: ${errors.join("; ")}`, resultType: "failure" };
  },
});

async function sessionConfig(model, effort) {
  return {
    model,
    ...(effort ? { reasoningEffort: effort } : {}),
    streaming: true,
    tools: [webSearchTool],
    availableTools: ["search_web", "web_fetch"],
    enableSessionStore: false,
    // Replace mode drops Copilot's built-in coding-agent prompt entirely.
    systemMessage: { mode: "replace", content: await systemPromptFor(model) },
    onPermissionRequest,
  };
}

async function getSession(conversationId, model, effort) {
  const existing = conversations.get(conversationId);
  if (existing) {
    if (existing.model !== model) {
      // Re-open the session so the new model also gets its own Claude app prompt.
      try {
        const fresh = await client.resumeSession(existing.session.sessionId, await sessionConfig(model, effort));
        await fresh.setModel(model, effort ? { reasoningEffort: effort } : undefined);
        existing.session = fresh;
      } catch {
        await existing.session.setModel(model, effort ? { reasoningEffort: effort } : undefined);
      }
      existing.model = model;
      existing.effort = effort;
    } else if (existing.effort !== effort) {
      await existing.session.setModel(model, effort ? { reasoningEffort: effort } : undefined);
      existing.effort = effort;
    }
    return existing;
  }

  let session;
  if (conversationId) {
    // After a server restart, try to pick the conversation back up.
    try {
      session = await client.resumeSession(conversationId, await sessionConfig(model, effort));
      await session.setModel(model, effort ? { reasoningEffort: effort } : undefined);
    } catch {
      session = undefined;
    }
  }
  session ??= await client.createSession(await sessionConfig(model, effort));
  const entry = { session, model, effort, busy: false };
  conversations.set(session.sessionId, entry);
  return entry;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 40_000_000) reject(new Error("Body too larg"));
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

async function handleChat(req, res) {
  const { conversationId, model, effort, prompt, images = [], voice = false } = await readJson(req);
  if (typeof prompt !== "string") return sendJson(res, 400, { error: "Empty promt" });
  if (!prompt.trim() && !(Array.isArray(images) && images.length)) return sendJson(res, 400, { error: "Empty promt" });

  const models = await getClaudeModels();
  const modelInfo = models.find((m) => m.id === model);
  if (!modelInfo) return sendJson(res, 400, { error: `Unknwon Clod modle: ${model}` });
  const defaultEffort = modelInfo.reasoningEfforts.includes("high") ? "high" : undefined;
  const validEffort = effort && modelInfo.reasoningEfforts.includes(effort) ? effort : defaultEffort;
  if (!Array.isArray(images) || images.length > modelInfo.maxImages) {
    return sendJson(res, 400, { error: `${modelInfo.name} only takes ${modelInfo.maxImages} pic(s) at a tiem` });
  }
  const attachments = [];
  for (const img of images) {
    if (!img || typeof img.data !== "string" || !modelInfo.imageTypes.includes(img.mimeType)) {
      return sendJson(res, 400, { error: "That pic type is not suported" });
    }
    attachments.push({ type: "blob", data: img.data, mimeType: img.mimeType, displayName: String(img.name || "photo").slice(0, 100) });
  }

  const entry = await getSession(conversationId || null, model, validEffort);
  if (entry.busy) return sendJson(res, 409, { error: "Clod is stil thinkin about ur last mesage." });
  entry.busy = true;
  const { session } = entry;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  emit("session", { conversationId: session.sessionId });

  let finished = false;
  const unsubscribers = [];
  const finish = (event, data) => {
    if (finished) return;
    finished = true;
    unsubscribers.forEach((u) => u());
    entry.busy = false;
    emit(event, data);
    res.end();
  };

  unsubscribers.push(
    session.on("assistant.message_delta", (e) => emit("delta", { text: e.data.deltaContent })),
    session.on("assistant.reasoning_delta", (e) => emit("thinking", { text: e.data.deltaContent })),
    session.on("assistant.message", (e) => emit("message", { text: e.data.content })),
    session.on("tool.execution_start", (e) => {
      const { toolName, arguments: args = {} } = e.data;
      if (toolName === "search_web" || toolName === "web_search") emit("tool", { kind: "search", label: String(args.query || "") });
      else if (toolName === "web_fetch") emit("tool", { kind: "fetch", label: String(args.url || "") });
    }),
    session.on("session.error", (e) => finish("error", { error: e.data?.message || "Somthing went wrong" })),
    session.on("session.idle", () => finish("done", {})),
  );

  res.on("close", () => {
    if (!finished) {
      finished = true;
      unsubscribers.forEach((u) => u());
      session.abort().catch(() => {}).finally(() => (entry.busy = false));
    }
  });

  try {
    const text = prompt.trim() || "(the user sent a photo with no text)";
    await session.send({ prompt: voice ? `${VOICE_NOTE}\n\n${text}` : text, attachments });
  } catch (e) {
    finish("error", { error: e.message });
  }
}

const TITLE_PROMPT = `You name chats for a deliberately dumb, low-budget chatbot called Clod.
Given the user's first message, reply with ONLY a title of 1 to 3 very short words (max 18 characters total), all lowercase, no quotes, no punctuation.
It must sound really simple and dumb, like a toddler or caveman wrote it, and contain at least one spelling mistake.
Examples: "math thingy", "code problm", "helo", "fix computr", "food qestion", "rent mony".`;

async function makeDumbTitle(text) {
  const models = await getClaudeModels();
  const model = (models.find((m) => /haiku/i.test(m.id)) || models[0])?.id;
  const session = await client.createSession({
    model,
    availableTools: [],
    enableSessionStore: false,
    systemMessage: { mode: "replace", content: TITLE_PROMPT },
    onPermissionRequest: () => ({ kind: "denied-interactively-by-user" }),
  });
  try {
    const reply = await session.sendAndWait(
      { prompt: `<first_message>\n${text.slice(0, 1500)}\n</first_message>\nReply with ONLY the dumb title, nothing else.` },
      45_000,
    );
    let title = (reply?.data?.content || "")
      .trim()
      .split("\n")[0]
      .replace(/^title\s*[:-]?\s*/i, "")
      .replace(/[^\p{L}\p{N}\s]/gu, "")
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .slice(0, 3)
      .join(" ");
    while (title.length > 20 && title.includes(" ")) title = title.slice(0, title.lastIndexOf(" "));
    return title.slice(0, 20) || "chat thingy";
  } catch (e) {
    console.error("Title failed:", e.message);
    return "chat thingy";
  } finally {
    await session.disconnect().catch(() => {});
    await client.deleteSession(session.sessionId).catch(() => {});
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".ico": "image/svg+xml",
};

async function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  // KaTeX (math rendering) is served straight from node_modules, so there's no CDN.
  const [root, rel] = urlPath.startsWith("/vendor/katex/")
    ? [KATEX_DIR, urlPath.slice("/vendor/katex/".length)]
    : [PUBLIC_DIR, urlPath === "/" ? "index.html" : urlPath === "/favicon.ico" ? "logo.svg" : urlPath.slice(1)];
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root + path.sep)) return sendJson(res, 403, { error: "Forbidden" });
  try {
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: "Not fond" });
  }
}

// Optional access key. If CLOD_KEY is set, every request needs it, either as ?key=... (which then sets a
// cookie) or as the cookie itself. `npm run share` sets this before putting Clod on the internet.
const ACCESS_KEY = process.env.CLOD_KEY || "";
const keyMatches = (k) =>
  typeof k === "string" && k.length === ACCESS_KEY.length && timingSafeEqual(Buffer.from(k), Buffer.from(ACCESS_KEY));

function checkAccess(req, res, url) {
  if (!ACCESS_KEY) return true;
  const qKey = url.searchParams.get("key");
  if (keyMatches(qKey)) {
    url.searchParams.delete("key");
    const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
    res.writeHead(302, {
      "Set-Cookie": `clod_key=${encodeURIComponent(qKey)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`,
      Location: url.pathname + url.search,
    });
    res.end();
    return false;
  }
  const cookie = (req.headers.cookie || "").match(/(?:^|;\s*)clod_key=([^;]*)/);
  if (cookie && keyMatches(decodeURIComponent(cookie[1]))) return true;
  if (url.pathname.startsWith("/api/")) sendJson(res, 401, { error: "No key, no Clod" });
  else {
    res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta name="viewport" content="width=device-width"><body style="font-family:'Comic Sans MS',cursive;background:#262624;color:#eee;display:grid;place-items:center;height:90vh"><div style="text-align:center"><h1>🔒 Clod is privite</h1><p>U need the speshul link with the key in it.</p></div>`);
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    const { pathname } = url;
    if (!checkAccess(req, res, url)) return;
    if (req.method === "GET" && pathname === "/api/models") {
      return sendJson(res, 200, { models: await getClaudeModels() });
    }
    if (req.method === "POST" && pathname === "/api/chat") return await handleChat(req, res);
    if (req.method === "POST" && pathname === "/api/title") {
      const { text } = await readJson(req);
      if (typeof text !== "string" || !text.trim()) return sendJson(res, 400, { error: "Empty promt" });
      return sendJson(res, 200, { title: await makeDumbTitle(text) });
    }
    if (req.method === "GET" && pathname === "/api/chats") return sendJson(res, 200, await listChats());
    const chat = pathname.match(/^\/api\/chats\/([\w-]+)$/);
    if (chat && validChatId(chat[1])) {
      if (req.method === "PUT") {
        const body = await readJson(req);
        if (!body || typeof body !== "object" || !Array.isArray(body.messages)) {
          return sendJson(res, 400, { error: "Thats not a chat" });
        }
        await saveChat(chat[1], body);
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === "DELETE") {
        await deleteChat(chat[1]);
        return sendJson(res, 200, { ok: true });
      }
    }
    const del = pathname.match(/^\/api\/conversations\/([\w-]+)$/);
    if (req.method === "DELETE" && del) {
      const entry = conversations.get(del[1]);
      conversations.delete(del[1]);
      await entry?.session.disconnect().catch(() => {});
      await client.deleteSession(del[1]).catch(() => {});
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "GET") return await serveStatic(req, res);
    sendJson(res, 405, { error: "Methd not alowed" });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { error: e.message });
    else res.end();
  }
});

server.listen(PORT, HOST, () => console.log(`Clod is lurkin at http://${HOST}:${PORT}`));

async function shutdown() {
  server.close();
  await client.stop().catch(() => {});
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
