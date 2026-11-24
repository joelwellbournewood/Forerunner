// The bench's stand-in for GitHub (`start.mjs --githost`): the fake git host of testenv on a
// fixed port. Without --users: one user `bench`, a classic token for that user and two
// repositories:
//   bench/empty   no commit at all, as a repository just created on GitHub
//   bench/seeded  one commit (README.md) on main
// With --users ada,bob[,carol] (w8-two-homes, wave 8: two people's Forerunners meet on one
// GitHub): one user and one classic token per login; with --org team, the organisation team
// (members: every user, or --members ada,bob) and its repositories
//   team/shared   one commit (README.md) on main
//   team/empty    no commit
// (without --org the first user's <login>/shared and <login>/empty). --collaborators
// carol=write,dave=read sets a role on the shared repository (write, read or none).
// Run with tsx; writes { url, token, login, repos, users, org } to --out and serves until it is
// ended. `token` and `login` are the first user's (the single-user shape, kept).
//   node --import tsx scripts/bench/githost-server.ts --root <dir> --port <p> --out <file>
//        [--users ada,bob] [--org team] [--members ada,bob] [--collaborators carol=read]
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "@forerunner/platform";
import { FakeGitHost } from "../../testenv/src/githost/index.ts";

function arg(name: string): string {
  const at = process.argv.indexOf(`--${name}`);
  const v = at >= 0 ? process.argv[at + 1] : undefined;
  if (!v) {
    console.error(`--${name} is required`);
    process.exit(2);
  }
  return v;
}

function optional(name: string): string | null {
  const at = process.argv.indexOf(`--${name}`);
  const v = at >= 0 ? process.argv[at + 1] : undefined;
  return v && !v.startsWith("--") ? v : null;
}

const list = (v: string | null) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const root = arg("root");
const port = Number(arg("port"));
const out = arg("out");
const users = list(optional("users"));
const org = optional("org");
mkdirSync(root, { recursive: true });
const host = await FakeGitHost.start({ rootDir: root, port });
if (!host.gitHttpAvailable) {
  console.error("git http-backend was not found: the fake git host cannot serve clones");
  process.exit(3);
}

let info: Record<string, unknown>;
if (users.length === 0) {
  host.createUser({ login: "bench", name: "Bench Person", email: "bench@example.test" });
  const token = host.createToken({ owner: "bench", kind: "classic", scopes: ["repo"] });
  await host.createRepo({ owner: "bench", name: "empty", private: true });
  await host.createRepo({
    owner: "bench",
    name: "seeded",
    private: true,
    initialFiles: { "README.md": "# seeded\n\nA repository with one commit.\n" },
  });
  info = {
    url: host.baseUrl,
    token: token.token,
    login: "bench",
    repos: ["bench/empty", "bench/seeded"],
  };
} else {
  // Each person's account: a name, no email (nothing the stand-in shows names an address).
  for (const login of users)
    host.createUser({ login, name: login[0]?.toUpperCase() + login.slice(1) });
  const roles = Object.fromEntries(
    list(optional("collaborators")).map((pair) => {
      const [login, role] = pair.split("=");
      if (!login || !["write", "read", "none"].includes(role ?? "")) {
        console.error(`--collaborators expects login=write|read|none (got ${pair})`);
        process.exit(2);
      }
      return [login, role as "write" | "read" | "none"];
    }),
  );
  const owner = org ?? (users[0] as string);
  if (org) {
    const named = list(optional("members"));
    const members = named.length ? named : users.filter((u) => !(u in roles));
    host.createOrg({ login: org, name: org, members });
  }
  await host.createRepo({
    owner,
    name: "shared",
    private: true,
    initialFiles: { "README.md": "# shared\n\nThe team's repository.\n" },
  });
  await host.createRepo({ owner, name: "empty", private: true });
  for (const [login, role] of Object.entries(roles))
    host.setCollaboratorRole(`${owner}/shared`, login, role);
  const tokens = Object.fromEntries(
    users.map((login) => [
      login,
      { token: host.createToken({ owner: login, kind: "classic", scopes: ["repo"] }).token },
    ]),
  );
  info = {
    url: host.baseUrl,
    token: tokens[users[0] as string]?.token,
    login: users[0],
    repos: [`${owner}/shared`, `${owner}/empty`],
    users: tokens,
    ...(org ? { org } : {}),
    ...(Object.keys(roles).length ? { collaborators: roles } : {}),
  };
}
writeFileSync(out, JSON.stringify({ ...info, pid: process.pid }, null, 2));
console.log(`fake git host on ${host.baseUrl}: ${(info.repos as string[]).join(", ")}`);
// Every request the app made, one JSON line each (method, path, status, when, and the login
// its token belongs to; never a token), beside --out as githost-requests.jsonl: a walk reads
// when the app called GitHub (d1109-chat-guard: a chat turn's first model call is made before
// any GitHub request) and, with two people, whose Forerunner made each call (w8-two-homes).
const requestLog = join(dirname(out), "githost-requests.jsonl");
writeFileSync(requestLog, "");
let logged = 0;
const flush = () => {
  const all = host.requests();
  for (const r of all.slice(logged))
    appendFileSync(
      requestLog,
      // w8-issue-host: a conditional read's If-None-Match (a 304 is free), and GraphQL's operation.
      `${JSON.stringify({ at: r.at, method: r.method, path: r.path, query: r.query, status: r.status, login: r.auth?.login ?? null, ifNoneMatch: r.ifNoneMatch, ...(r.graphql ? { graphql: r.graphql } : {}) })}\n`,
    );
  logged = all.length;
};
const flusher = setInterval(flush, 100);
const stop = async () => {
  clearInterval(flusher);
  flush();
  await host.stop();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
