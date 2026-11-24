#!/usr/bin/env node
// One bench's way to GitHub (w8-two-homes, wave 8): a TCP proxy between this bench's daemon and
// the stand-in for GitHub, so `cut.mjs <bench> github off` makes GitHub unreachable for this
// home only (the other home's daemon talks to the stand-in through its own proxy). While the
// control file <bench>/github-cut exists the proxy listens on nothing (a refused connection, as
// when the network is gone) and every open connection is ended; when it goes, it listens again.
//   node scripts/bench/github-proxy.mjs --port <p> --target http://127.0.0.1:<githost> --dir <bench dir>
// Writes <bench dir>/github-proxy.json { url, port, pid, state } at every change.
import { existsSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import path from "node:path";

function arg(name) {
  const at = process.argv.indexOf(`--${name}`);
  const v = at >= 0 ? process.argv[at + 1] : undefined;
  if (!v) {
    console.error(`--${name} is required`);
    process.exit(2);
  }
  return v;
}

const port = Number(arg("port"));
const target = new URL(arg("target"));
const dir = arg("dir");
const cutFile = path.join(dir, "github-cut");
const stateFile = path.join(dir, "github-proxy.json");
const sockets = new Set();
let server = null;
let state = "starting";

function write(next) {
  state = next;
  writeFileSync(
    stateFile,
    `${JSON.stringify({ url: `http://127.0.0.1:${port}`, port, pid: process.pid, target: target.origin, state }, null, 2)}\n`,
  );
  console.log(`[github-proxy] ${new Date().toISOString()} ${state}`);
}

function open() {
  return new Promise((resolve, reject) => {
    const srv = createServer((client) => {
      const upstream = createConnection({ host: target.hostname, port: Number(target.port) });
      sockets.add(client);
      sockets.add(upstream);
      const end = () => {
        client.destroy();
        upstream.destroy();
        sockets.delete(client);
        sockets.delete(upstream);
      };
      client.on("error", end);
      upstream.on("error", end);
      client.on("close", end);
      upstream.on("close", end);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    srv.once("error", reject);
    srv.listen(port, "127.0.0.1", () => {
      srv.off("error", reject);
      server = srv;
      resolve();
    });
  });
}

function close() {
  return new Promise((resolve) => {
    for (const s of sockets) s.destroy();
    sockets.clear();
    if (!server) return resolve();
    const srv = server;
    server = null;
    srv.close(() => resolve());
  });
}

let busy = false;
async function follow() {
  if (busy) return;
  busy = true;
  try {
    const cut = existsSync(cutFile);
    if (cut && state !== "off") {
      await close();
      write("off");
    } else if (!cut && state !== "on") {
      await open();
      write("on");
    }
  } catch (e) {
    console.error(`[github-proxy] ${e.message}`);
  } finally {
    busy = false;
  }
}

await follow();
const timer = setInterval(follow, 200);
const stop = async () => {
  clearInterval(timer);
  await close();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
