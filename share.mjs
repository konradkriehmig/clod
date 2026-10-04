// Puts Clod on the internet: starts the server with a random access key and opens a Cloudflare quick
// tunnel to it. You get an HTTPS link (needed for the mic / voice mode) that only works with the key.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import qrcode from "qrcode-terminal";

const PORT = process.env.PORT || "3000";
const KEY = process.env.CLOD_KEY || randomBytes(18).toString("base64url");
const children = [];

function stopAll(code = 0) {
  for (const c of children) c.kill();
  process.exit(code);
}
process.on("SIGINT", () => stopAll());
process.on("SIGTERM", () => stopAll());

const server = spawn(process.execPath, ["server.mjs"], {
  cwd: import.meta.dirname,
  env: { ...process.env, PORT, HOST: "127.0.0.1", CLOD_KEY: KEY },
  stdio: "inherit",
});
children.push(server);
server.on("exit", (code) => {
  console.error(`Server exited (${code}). Is something else alredy using port ${PORT}?`);
  stopAll(1);
});

const tunnel = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${PORT}`]);
children.push(tunnel);
tunnel.on("error", () => {
  console.error("cloudflared not found. Install it: winget install Cloudflare.cloudflared (or brew install cloudflared)");
  stopAll(1);
});
tunnel.on("exit", (code) => {
  console.error(`Tunnel closed (${code}).`);
  stopAll(1);
});

let shown = false;
const onTunnelOutput = (buf) => {
  const m = !shown && buf.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (!m) return;
  shown = true;
  const link = `${m[0]}/?key=${KEY}`;
  console.log(`\nClod is on the interwebs! Open this on any devise (voice mode works there too):\n\n  ${link}\n`);
  console.log(`Locally: http://127.0.0.1:${PORT}/?key=${KEY}\n`);
  qrcode.generate(link, { small: true });
  console.log("\nAnyone with this link can use your Copilot. Ctrl+C to stop sharing.\n");
};
tunnel.stdout.on("data", onTunnelOutput);
tunnel.stderr.on("data", onTunnelOutput);
