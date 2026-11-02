// The bench's stand-in for GitHub (`start.mjs --githost`): the fake git host of testenv on a
// fixed port, with one user, a classic token for that user and two repositories:
//   bench/empty   no commit at all, as a repository just created on GitHub
//   bench/seeded  one commit (README.md) on main
// Run with tsx; writes { url, token, login, repos } to --out and serves until it is ended.
//   node --import tsx scripts/bench/githost-server.ts --root <dir> --port <p> --out <file>
import { mkdirSync, writeFileSync } from "node:fs";
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

const root = arg("root");
const port = Number(arg("port"));
const out = arg("out");
mkdirSync(root, { recursive: true });
const host = await FakeGitHost.start({ rootDir: root, port });
if (!host.gitHttpAvailable) {
  console.error("git http-backend was not found: the fake git host cannot serve clones");
  process.exit(3);
}
host.createUser({ login: "bench", name: "Bench Person", email: "bench@example.test" });
const token = host.createToken({ owner: "bench", kind: "classic", scopes: ["repo"] });
await host.createRepo({ owner: "bench", name: "empty", private: true });
await host.createRepo({
  owner: "bench",
  name: "seeded",
  private: true,
  initialFiles: { "README.md": "# seeded\n\nA repository with one commit.\n" },
});
writeFileSync(
  out,
  JSON.stringify(
    {
      url: host.baseUrl,
      token: token.token,
      login: "bench",
      repos: ["bench/empty", "bench/seeded"],
      pid: process.pid,
    },
    null,
    2,
  ),
);
console.log(`fake git host on ${host.baseUrl}: bench/empty, bench/seeded`);
const stop = async () => {
  await host.stop();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
