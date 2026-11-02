import { existsSync, readFileSync, statSync } from "node:fs";
import { isInside, join, normalize } from "@forerunner/platform";

/**
 * What a task's work is tried as (ADR 0110, the owner's decision (3) of 2026-11-01: work a
 * person will use is started in its own environment and used as a person would). Decided from
 * what the task made, read from its brief, its acceptance criteria, its README and its files:
 *
 * - a **command line tool**: a command the brief, a criterion or the task's README names
 *   (`node wc.js <file>`, `python3 cli.py --name <name>`) is run with sample input in the task's
 *   sandbox, and its output is the evidence;
 * - an **API or server**: a file the task wrote that listens on a port is started (the command
 *   the brief names, else the file itself) and its routes (the ones the brief names, else the
 *   ones its code handles) are called; the replies are the evidence;
 * - a **page**: opened in a browser (`try-it.ts` `pagesToTry`);
 * - a **library**: nothing is started; its tests are what check it (`project-checks.ts`).
 *
 * Only what is said exactly is run: a command in backticks or in a README's code, or one whose
 * words end where a sentence goes on ("node wc.js <file> prints ..."). A tool whose usage nobody
 * wrote down is not guessed at: the review says it was not tried and why. Placeholders
 * (`<file>`, `<name>`, a file the folder does not have) become sample input written for the try
 * under `TRY_FOLDER`, which is removed afterwards.
 */

/** Where the try's own files go (samples, the server driver): inside the task's folder, removed after. */
export const TRY_FOLDER = ".forerunner-try";
/** At most this many commands are run per review. */
export const MAX_COMMANDS_TRIED = 3;
/** At most this many servers are started per review. */
export const MAX_SERVERS_TRIED = 1;
/** At most this many routes are called per server. */
export const MAX_ROUTES_CALLED = 5;

export interface TrySample {
  /** Relative to the task's folder, forward slashes, under `TRY_FOLDER`. */
  path: string;
  /** The file's text; for a folder sample, the files in it. */
  content: string | Record<string, string>;
  /** How the evidence names it: "<file>: a sample text file written for the try (2 lines, 9 words)". */
  stands: string;
}

export interface CommandTry {
  kind: "command";
  /** The command as it was written ("node wc.js <file>"): the try's name and its finding's target. */
  target: string;
  /** What runs: the placeholders replaced by sample input. */
  argv: string[];
  /** Text written to its standard input (`echo "a b" | node wc.js`, `node wc.js < <file>`). */
  input?: string;
  samples: TrySample[];
  /** The text around it expects an error or a non-zero exit: a failing exit is then no problem. */
  expectsError: boolean;
  /** Where it was written: "the brief", "an acceptance criterion" or "README.md". */
  source: string;
}

export interface ServerTry {
  kind: "server";
  /** The start command as written or as made from the file ("node server.js"). */
  target: string;
  argv: string[];
  /** The file that listens. */
  file: string;
  /** Ports its code or the brief names; the try also sets PORT to a free one. */
  ports: number[];
  /** GET routes to call; `documented` when the brief, a criterion or the README names it. */
  routes: { path: string; documented: boolean }[];
  /** Routes it names that a try cannot call ("POST /items": only GET routes are called). */
  skippedRoutes: string[];
  source: string;
  /**
   * The brief, a criterion or the README says how to start it or names a route of it: a server
   * the task was asked for. A server only found in the code (a task that edited a big app's
   * server file) is tried, but what goes wrong there (it needs a database, a key) is told, never
   * held against the task.
   */
  expected: boolean;
}

export interface TryPlan {
  commands: CommandTry[];
  servers: ServerTry[];
  /** What could be tried but is not, and why, in words for "See what was checked". */
  notTried: string[];
}

export interface TryBrief {
  title: string;
  outcome: string;
  criteria: readonly string[];
}

const SCRIPT = /^[\w@][\w@./-]*\.(?:m?js|cjs|py)$/i;
const PROGRAMS = new Set(["node", "python3", "python"]);
/** Code that listens on a port: an API or a server. */
const LISTENS =
  /\.listen\s*\(|\bserve_forever\s*\(|\bapp\.run\s*\(|\buvicorn\.run\s*\(|\bBun\.serve\s*\(|\bDeno\.serve\s*\(/;
/** Code that reads its command line: a command line tool. */
const READS_ARGS =
  /^#!|\bprocess\.argv\b|\bsys\.argv\b|\bargparse\b|\bparseArgs\s*\(|\bcommander\b|\byargs\b/m;
/** Words that end a command written in a sentence ("node wc.js <file> prints the count"). */
const STOP_WORDS = new Set(
  "prints print outputs output shows show returns return writes write answers answer lists list counts count says say exits exit should must will can and or then to with which that it gives give displays display reports report logs log on in for as is are when where so from at by listens listen serves serve starts start runs run opens open accepts accept reads read takes take expects expect uses use needs need creates create makes make builds build generates generate converts convert computes compute calculates calculate greets greet responds respond replies reply handles handle sorts sort finds find adds add prompts prompt asks ask".split(
    " ",
  ),
);
const TEST_FILE =
  /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]s$|(^|\/)test_[^/]*\.py$|_test\.py$/i;

/** What is tried of a task's work besides its pages (ADR 0110). */
export function planTries(input: {
  changedFiles: readonly string[];
  root: string | undefined;
  brief: TryBrief;
}): TryPlan {
  const plan: TryPlan = { commands: [], servers: [], notTried: [] };
  const { root } = input;
  if (!root) return plan;
  const files = input.changedFiles
    .map((f) => f.replace(/\\/g, "/").replace(/^\.\//, ""))
    .filter((f) => !f.split("/").some((s) => s === "node_modules" || s.startsWith(".")));
  const texts: { text: string; source: string }[] = [
    ...input.brief.criteria.map((c) => ({ text: c, source: "an acceptance criterion" })),
    { text: `${input.brief.title}\n${input.brief.outcome}`, source: "the brief" },
  ];
  const readme = files.find((f) => /^readme(\.md|\.markdown|\.txt)?$/i.test(f));
  const readmeText = readme ? readText(root, readme) : null;
  if (readme && readmeText !== null) texts.push({ text: readmeText, source: readme });

  const seen = new Set<string>();
  for (const { text, source } of texts) {
    for (const found of commandsIn(text)) {
      const key = found.words.join(" ");
      if (seen.has(key)) continue;
      seen.add(key);
      const script = found.words[1] ?? "";
      const abs = normalize(join(root, ...script.split("/")));
      if (!isInside(root, abs) || !isFile(abs)) {
        if (plan.notTried.length < 3)
          plan.notTried.push(
            `${found.target} was not tried: ${script} is not in the task's folder`,
          );
        continue;
      }
      const code = readText(root, script) ?? "";
      if (LISTENS.test(code)) {
        if (plan.servers.length < MAX_SERVERS_TRIED && !plan.servers.some((s) => s.file === script))
          plan.servers.push(serverTry(root, script, found.words, found.target, source, texts));
        continue;
      }
      if (plan.commands.length >= MAX_COMMANDS_TRIED) continue;
      const made = commandTry(found, source, root);
      if ("unsupported" in made) plan.notTried.push(made.unsupported);
      else plan.commands.push(made);
    }
  }

  // A file the task wrote that listens, whose start nobody wrote down: started as it is.
  for (const f of files) {
    if (plan.servers.length >= MAX_SERVERS_TRIED) break;
    if (!/\.(m?js|cjs|py)$/i.test(f) || TEST_FILE.test(f)) continue;
    if (plan.servers.some((s) => s.file === f)) continue;
    const code = readText(root, f);
    if (!code || !LISTENS.test(code)) continue;
    const program = /\.py$/i.test(f) ? "python3" : "node";
    plan.servers.push(serverTry(root, f, [program, f], `${program} ${f}`, "its code", texts));
  }

  // A command line tool the task wrote that nothing says how to run: told, not guessed at.
  for (const f of files) {
    if (!/\.(m?js|cjs|py)$/i.test(f) || TEST_FILE.test(f)) continue;
    if (plan.commands.some((c) => c.argv[1] === f) || plan.servers.some((s) => s.file === f))
      continue;
    if ([...seen].some((k) => k.split(" ")[1] === f)) continue;
    const code = readText(root, f);
    if (!code || LISTENS.test(code) || !READS_ARGS.test(code)) continue;
    plan.notTried.push(
      `${f} reads its command line, but neither the brief nor ${readme ?? "a README"} says how to run it, so it was not tried`,
    );
    break;
  }
  return plan;
}

interface FoundCommand {
  /** The program, the script and the arguments as written. */
  words: string[];
  /** The command as shown: the words joined, with the stdin part. */
  target: string;
  /** `echo "x" |` / `cat <file> |` / `< <file>`: what goes to standard input. */
  stdin?: { text: string } | { file: string };
  /** The sentence (or line) the command was written in. */
  sentence: string;
}

/** The commands a text names: in backticks, in a code block, or in a sentence that ends them. */
export function commandsIn(text: string): FoundCommand[] {
  const out: FoundCommand[] = [];
  const exact: string[] = [];
  for (const m of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g))
    for (const line of (m[1] ?? "").split(/\r?\n/)) exact.push(line);
  const noFences = text.replace(/```[\s\S]*?```/g, " ");
  for (const m of noFences.matchAll(/`([^`\n]+)`/g)) exact.push(m[1] ?? "");
  for (const raw of exact) {
    const parsed = parseCommand(raw.trim().replace(/^\$\s+/, ""), sentenceOf(text, raw), true);
    if (parsed) out.push(parsed);
  }
  const plain = noFences.replace(/`[^`\n]+`/g, " ");
  for (const m of plain.matchAll(
    /(?:(?:echo|printf)\s+(?:"[^"\n]*"|'[^'\n]*'|\S+)\s*\|\s*|cat\s+\S+\s*\|\s*)?\b(?:node|python3?)\s+[\w@./-]+\.(?:m?js|cjs|py)\b[^\n]*/gi,
  )) {
    const parsed = parseCommand(m[0], sentenceOf(text, m[0]), false);
    if (parsed) out.push(parsed);
  }
  return out;
}

function sentenceOf(text: string, part: string): string {
  const at = text.indexOf(part);
  if (at < 0) return part;
  const start = Math.max(
    text.lastIndexOf("\n", at) + 1,
    ...[". ", "; "].map((s) => {
      const i = text.lastIndexOf(s, at);
      return i < 0 ? 0 : i + 2;
    }),
  );
  const ends = ["\n", ". ", "; "]
    .map((s) => text.indexOf(s, at + part.length))
    .filter((i) => i >= 0);
  return text.slice(start, ends.length ? Math.min(...ends) : text.length).trim();
}

/** Splits like a shell, keeping quotes and `<placeholders>` as one word each. */
function words(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/"([^"]*)"|'([^']*)'|<[^>\s]+>|\[[^\]\s]+\]|\|[^\s]*|[^\s"'|]+/g)) {
    const w = m[0];
    if (w.startsWith('"') || w.startsWith("'")) out.push(m[1] ?? m[2] ?? "");
    else out.push(w);
  }
  return out;
}

function isArgWord(w: string): boolean {
  return (
    isPlaceholder(w) ||
    w.startsWith("-") ||
    /[./\\]/.test(w) ||
    /^\d+(\.\d+)?$/.test(w) ||
    /^[A-Z][A-Z0-9_]+$/.test(w)
  );
}

function isPlaceholder(w: string): boolean {
  return /^<[^>\s]+>$|^\[[^\]\s]+\]$|^[A-Z][A-Z_]{2,}$/.test(w);
}

function parseCommand(raw: string, sentence: string, exact: boolean): FoundCommand | null {
  let line = raw.trim();
  let stdin: FoundCommand["stdin"];
  const pipe = /^(echo|printf|cat)\s+("[^"]*"|'[^']*'|\S+)\s*\|\s*/i.exec(line);
  if (pipe) {
    const arg = (pipe[2] ?? "").replace(/^["']|["']$/g, "");
    stdin = /^cat$/i.test(pipe[1] ?? "")
      ? { file: arg }
      : { text: `${arg.replace(/\\n/g, "\n")}\n` };
    line = line.slice(pipe[0].length);
  }
  const redirect = /\s<\s*(\S+)\s*$/.exec(line);
  if (redirect && !isPlaceholder(line.slice(redirect.index + 1).trim())) {
    stdin = { file: redirect[1] ?? "" };
    line = line.slice(0, redirect.index);
  } else if (/\s<\s+(<[^>\s]+>)\s*$/.test(line)) {
    const m = /\s<\s+(<[^>\s]+>)\s*$/.exec(line);
    stdin = { file: m?.[1] ?? "" };
    line = line.slice(0, m?.index ?? line.length);
  }
  const all = words(line);
  const program = all[0]?.toLowerCase() ?? "";
  if (!PROGRAMS.has(program) || !SCRIPT.test(all[1] ?? "")) return null;
  if ((all[1] ?? "").split("/").includes("..")) return null;
  let args = all.slice(2);
  if (args.some((a) => /^[|;&>]/.test(a))) {
    const cut = args.findIndex((a) => /^[|;&>]/.test(a));
    if (!exact) args = args.slice(0, cut);
    else return null; // a pipeline or a redirection the try does not reproduce
  }
  if (!exact) {
    // In a sentence, the command ends at its last argument-looking word; the next word must
    // be one that goes on the sentence ("prints", "and"), else where it ends is a guess.
    const kept: string[] = [];
    for (const a of args) {
      const bare = a.replace(/[.,;:)]+$/, "");
      if (isArgWord(bare) && !/^[.,;:]+$/.test(bare)) {
        kept.push(bare);
        if (bare !== a) break;
      } else {
        if (!STOP_WORDS.has(bare.toLowerCase())) return null;
        break;
      }
    }
    args = kept;
  }
  const command = [program, all[1] ?? "", ...args];
  const shown =
    stdin && "text" in stdin
      ? `echo ${JSON.stringify(stdin.text.trimEnd())} | ${command.join(" ")}`
      : stdin && "file" in stdin
        ? `${command.join(" ")} < ${stdin.file}`
        : command.join(" ");
  return { words: command, target: shown, ...(stdin ? { stdin } : {}), sentence };
}

const SAMPLE_TEXT = "the quick brown fox\njumps over the lazy dog\n";

function sampleContent(ext: string): { content: string; kind: string } {
  switch (ext) {
    case ".csv":
      return { content: "name,count\napples,3\npears,5\n", kind: "a sample CSV file" };
    case ".json":
      return { content: '{ "items": [1, 2, 3] }\n', kind: "a sample JSON file" };
    case ".md":
      return {
        content: "# Sample\n\nThe quick brown fox jumps over the lazy dog.\n",
        kind: "a sample Markdown file",
      };
    default:
      return { content: SAMPLE_TEXT, kind: "a sample text file" };
  }
}

function describeSample(content: string, kind: string): string {
  const lines = content.split("\n").filter((l) => l.length).length;
  const wordCount = content.split(/\s+/).filter(Boolean).length;
  return `${kind} written for the try (${lines} line${lines === 1 ? "" : "s"}, ${wordCount} word${wordCount === 1 ? "" : "s"})`;
}

function commandTry(
  found: FoundCommand,
  source: string,
  root: string,
): CommandTry | { unsupported: string } {
  const samples: TrySample[] = [];
  const argv: string[] = [found.words[0] ?? "node", found.words[1] ?? ""];
  const sampleFor = (word: string): string | { unsupported: string } => {
    const name = word.replace(/^[<[]|[>\]]$/g, "").toLowerCase();
    if (isPlaceholder(word)) {
      if (/url|link|host|address|endpoint/.test(name))
        return {
          unsupported: `${found.target} was not tried: it needs a web address, and the network is off during the try`,
        };
      if (/dir|folder|directory/.test(name)) {
        const path = `${TRY_FOLDER}/sample-folder`;
        if (!samples.some((s) => s.path === path))
          samples.push({
            path,
            content: { "a.txt": SAMPLE_TEXT, "b.txt": "hello world\n" },
            stands: `${word}: a sample folder written for the try (a.txt and b.txt)`,
          });
        return path;
      }
      if (/file|path|input|txt|csv|json|doc|data|log/.test(name)) {
        const ext =
          /\.(\w+)$/.exec(name)?.[0] ??
          (/csv/.test(name) ? ".csv" : /json/.test(name) ? ".json" : ".txt");
        const path = `${TRY_FOLDER}/sample-${samples.length + 1}${ext}`;
        const s = sampleContent(ext);
        samples.push({
          path,
          content: s.content,
          stands: `${word}: ${describeSample(s.content, s.kind)}`,
        });
        return path;
      }
      if (/name|user|person|who/.test(name)) return "Ada";
      if (/num|count|amount|size|limit|age|year|seconds|minutes|^n$|^x$|^y$|^a$|^b$/.test(name))
        return "3";
      if (/word|text|string|message|query|term|phrase/.test(name)) return "hello";
      return "sample";
    }
    // A file the folder does not have ("node wc.js notes.txt"): a sample of that name.
    if (/^[\w@][\w@.-]*\.[a-z0-9]{1,5}$/i.test(word) && !existsSync(join(root, word))) {
      const ext = /\.\w+$/.exec(word)?.[0]?.toLowerCase() ?? ".txt";
      const path = `${TRY_FOLDER}/${word}`;
      const s = sampleContent(ext);
      if (!samples.some((x) => x.path === path))
        samples.push({
          path,
          content: s.content,
          stands: `${word}: ${describeSample(s.content, s.kind)}`,
        });
      return path;
    }
    return word;
  };
  for (const w of found.words.slice(2)) {
    const v = sampleFor(w);
    if (typeof v !== "string") return v;
    argv.push(v);
  }
  let input: string | undefined;
  if (found.stdin && "text" in found.stdin) input = found.stdin.text;
  else if (found.stdin && "file" in found.stdin) {
    const file = found.stdin.file;
    if (existsSync(join(root, file)) && !isPlaceholder(file)) input = readText(root, file) ?? "";
    else {
      const ext = /\.\w+$/.exec(file)?.[0]?.toLowerCase() ?? ".txt";
      const s = sampleContent(ext);
      input = s.content;
      samples.push({
        path: `${TRY_FOLDER}/stdin${ext}`,
        content: s.content,
        stands: `${file} (its standard input): ${describeSample(s.content, s.kind)}`,
      });
    }
  }
  const expectsError =
    /\bexit(?:s|ing)?\s+(?:with\s+)?(?:code\s+|status\s+)?[1-9]|\bnon-?zero\b|\b(?:an?|the)\s+(?:error|usage)\b|\bfails?\b|\berrors?\s+(?:out|message)\b/i.test(
      found.sentence,
    );
  return {
    kind: "command",
    target: found.target,
    argv,
    ...(input !== undefined ? { input } : {}),
    samples,
    expectsError,
    source,
  };
}

function serverTry(
  root: string,
  file: string,
  startWords: string[],
  target: string,
  source: string,
  texts: readonly { text: string; source: string }[],
): ServerTry {
  const code = readText(root, file) ?? "";
  const ports = new Set<number>();
  const portIn = (re: RegExp, s: string) => {
    for (const m of s.matchAll(re)) {
      const n = Number(m[1]);
      if (n >= 80 && n <= 65535) ports.add(n);
    }
  };
  portIn(/\.listen\s*\(\s*(\d{2,5})/g, code);
  portIn(/\bPORT\b[^\n\d]{0,40}?(\d{2,5})/g, code);
  portIn(/\bport\s*[=:]\s*(\d{2,5})/gi, code);
  portIn(/HTTPServer\s*\(\s*\(\s*['"][^'"]*['"]\s*,\s*(\d{2,5})/g, code);
  for (const t of texts) {
    portIn(/(?:localhost|127\.0\.0\.1):(\d{2,5})/g, t.text);
    portIn(/\bport\s+(\d{2,5})\b/gi, t.text);
  }
  const documented: { method: string; path: string }[] = [];
  for (const t of texts)
    for (const m of t.text.matchAll(/\b(GET|POST|PUT|PATCH|DELETE|HEAD)\s+(\/[^\s`'",;)]*)/g))
      documented.push({ method: m[1] ?? "GET", path: trimPath(m[2] ?? "/") });
  for (const t of texts)
    for (const m of t.text.matchAll(/`(\/[\w\-./]*)`/g))
      if (!documented.some((d) => d.path === trimPath(m[1] ?? "")))
        documented.push({ method: "GET", path: trimPath(m[1] ?? "/") });
  const fromCode: string[] = [];
  for (const re of [
    /\.(?:get|all)\(\s*['"`](\/[^'"`]*)['"`]/g,
    /\b(?:url|pathname|path)\s*===?\s*['"`](\/[^'"`?]*)['"`]/g,
    /\bcase\s+['"`](\/[^'"`]*)['"`]\s*:/g,
    /@\w+\.(?:route|get)\(\s*['"](\/[^'"]*)['"]/g,
    /self\.path\s*==\s*['"](\/[^'"]*)['"]/g,
  ])
    for (const m of code.matchAll(re)) fromCode.push(trimPath(m[1] ?? "/"));
  const callable = (p: string) => !/[:{}<>*]/.test(p);
  const routes: ServerTry["routes"] = [];
  const skippedRoutes: string[] = [];
  for (const d of documented) {
    if (d.method !== "GET" || !callable(d.path)) {
      const w = `${d.method} ${d.path}`;
      if (!skippedRoutes.includes(w)) skippedRoutes.push(w);
      continue;
    }
    if (!routes.some((r) => r.path === d.path)) routes.push({ path: d.path, documented: true });
  }
  for (const p of fromCode)
    if (callable(p) && !routes.some((r) => r.path === p))
      routes.push({ path: p, documented: false });
  if (!routes.length) routes.push({ path: "/", documented: false });
  return {
    kind: "server",
    target,
    argv: startWords,
    file,
    ports: [...ports].slice(0, 4),
    routes: routes.slice(0, MAX_ROUTES_CALLED),
    skippedRoutes: skippedRoutes.slice(0, 5),
    source,
    expected: source !== "its code" || documented.length > 0,
  };
}

function trimPath(p: string): string {
  return p.replace(/[.,;:)]+$/, "") || "/";
}

function isFile(abs: string): boolean {
  try {
    return statSync(abs).isFile();
  } catch {
    return false;
  }
}

/** A text file of the task's folder (at most 200 kB), or null. */
function readText(root: string, rel: string): string | null {
  const abs = normalize(join(root, ...rel.split("/")));
  if (!isInside(root, abs) || !isFile(abs)) return null;
  try {
    if (statSync(abs).size > 200_000) return null;
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}
