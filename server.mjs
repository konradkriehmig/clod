import http from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CopilotClient } from "@github/copilot-sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";

// Sessions run in an empty scratch dir so the model never sees this repo.
const WORK_DIR = path.join(__dirname, ".clod-workdir");
await mkdir(WORK_DIR, { recursive: true });

const SYSTEM_PROMPT = `You are Clod, a friendly, thoughtful and genuinely helpful AI assistant chatting with a user in a web browser.
Answer clearly and conversationally. Use Markdown (headings, lists, tables, fenced code blocks with language tags) when it improves readability.
You have no tools, files or internet access in this chat; rely on your own knowledge and say so when you're unsure.`;

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
      name: m.name.replace(/claude/gi, "Clod"),
      reasoningEfforts: m.supportedReasoningEfforts ?? [],
      vision: Boolean(m.capabilities?.supports?.vision),
      contextWindow: m.capabilities?.limits?.max_context_window_tokens ?? null,
    }));
  modelCache = { at: Date.now(), models };
  return models;
}

function sessionConfig(model, effort) {
  return {
    model,
    ...(effort ? { reasoningEffort: effort } : {}),
    streaming: true,
    availableTools: [],
    enableSessionStore: false,
    systemMessage: { mode: "replace", content: SYSTEM_PROMPT },
    onPermissionRequest: () => ({ kind: "denied-interactively-by-user" }),
  };
}

async function getSession(conversationId, model, effort) {
  const existing = conversations.get(conversationId);
  if (existing) {
    if (existing.model !== model || existing.effort !== effort) {
      await existing.session.setModel(model, effort ? { reasoningEffort: effort } : undefined);
      existing.model = model;
      existing.effort = effort;
    }
    return existing;
  }

  let session;
  if (conversationId) {
    // After a server restart, try to pick the conversation back up.
    try {
      session = await client.resumeSession(conversationId, sessionConfig(model, effort));
      await session.setModel(model, effort ? { reasoningEffort: effort } : undefined);
    } catch {
      session = undefined;
    }
  }
  session ??= await client.createSession(sessionConfig(model, effort));
  const entry = { session, model, effort, busy: false };
  conversations.set(session.sessionId, entry);
  return entry;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 2_000_000) reject(new Error("Body too large"));
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
  const { conversationId, model, effort, prompt } = await readJson(req);
  if (typeof prompt !== "string" || !prompt.trim()) return sendJson(res, 400, { error: "Empty promt" });

  const models = await getClaudeModels();
  const modelInfo = models.find((m) => m.id === model);
  if (!modelInfo) return sendJson(res, 400, { error: `Unknwon Clod modle: ${model}` });
  const validEffort = effort && modelInfo.reasoningEfforts.includes(effort) ? effort : undefined;

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
    await session.send({ prompt });
  } catch (e) {
    finish("error", { error: e.message });
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/svg+xml",
};

async function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const rel = urlPath === "/" ? "index.html" : urlPath === "/favicon.ico" ? "logo.svg" : urlPath.slice(1);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: "Forbidden" });
  try {
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: "Not fond" });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, "http://x");
    if (req.method === "GET" && pathname === "/api/models") {
      return sendJson(res, 200, { models: await getClaudeModels() });
    }
    if (req.method === "POST" && pathname === "/api/chat") return await handleChat(req, res);
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
