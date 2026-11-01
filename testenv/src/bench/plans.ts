import { slug } from "./roles.ts";

/**
 * What the stand-in project manager plans and what the stand-in specialists write. Plausible,
 * small and deterministic: the same brief gives the same plan, so a journey can be repeated.
 * None of it is a judgement of what a real model would plan.
 */

export interface PlanTaskOut {
  key: string;
  title: string;
  outcome: string;
  acceptanceCriteria: string[];
  priority: "low" | "medium" | "high";
  dependsOn: string[];
  specialist: string;
  riskTier?: number;
}

export interface PlanShape {
  milestone: string;
  successCriteria: string[];
  tasks: PlanTaskOut[];
  decision: { slug: string; title: string; body: string };
}

export interface PlanOptions {
  /** `chain`: seven tasks, each waiting on the one before (FORERUNNER_BENCH_PLAN=chain). */
  kind: "default" | "chain";
  /** Add a task only the person can answer (FORERUNNER_BENCH_PERSON=1). */
  personTask: boolean;
  /** Tasks whose title contains one of these get risk tier 2 (FORERUNNER_BENCH_RISK2). */
  risk2: readonly string[];
}

export interface IntakeInput {
  project: string;
  goal: string;
  brief: string;
  smallProject: boolean;
}

const WEB = /\b(web\s?site|web\s?page|webpage|html|landing page|site|page)\b/i;

export function isWebBrief(text: string): boolean {
  return WEB.test(text);
}

function webTasks(quotes: boolean): PlanTaskOut[] {
  const what = quotes ? "a random quote and its author" : "the main content";
  return [
    {
      key: "page",
      title: "Create the page skeleton in index.html",
      outcome: `index.html is a valid HTML5 page that loads styles.css and script.js and has a place for ${what}.`,
      acceptanceCriteria: [
        "index.html exists and is valid HTML5",
        "index.html links styles.css and script.js",
      ],
      priority: "high",
      dependsOn: [],
      specialist: "coder",
    },
    {
      key: "logic",
      title: quotes
        ? "Show a random quote on every load in script.js"
        : "Add the page behaviour in script.js",
      outcome: quotes
        ? "script.js holds at least ten quotes and puts a random one, with its author, into the page each time it is opened."
        : "script.js fills the page when it is opened.",
      acceptanceCriteria: quotes
        ? [
            "script.js contains at least ten quotes with authors",
            "Opening index.html shows one of them, picked at random",
          ]
        : ["script.js runs without errors when index.html is opened"],
      priority: "high",
      dependsOn: ["page"],
      specialist: "coder",
    },
    {
      key: "style",
      title: "Style the page in styles.css",
      outcome: "styles.css centres the content, uses a readable font size and works on a phone.",
      acceptanceCriteria: [
        "styles.css exists and index.html uses it",
        "The text is readable on a narrow screen",
      ],
      priority: "medium",
      dependsOn: ["page"],
      specialist: "designer",
    },
    {
      key: "check",
      title: "Check that index.html, styles.css and script.js work together",
      outcome: "A short check confirms the three files load together without errors.",
      acceptanceCriteria: [
        "node --check passes on script.js",
        "Every file index.html references exists",
      ],
      priority: "medium",
      dependsOn: ["logic", "style"],
      specialist: "tester",
    },
    {
      key: "readme",
      title: "Write the README: what the page does and how to open it",
      outcome: "README.md says in a few lines what the page does and how to open it locally.",
      acceptanceCriteria: ["README.md explains how to open index.html in a browser"],
      priority: "low",
      dependsOn: ["logic"],
      specialist: "writer-marketing",
    },
  ];
}

function genericTasks(goal: string): PlanTaskOut[] {
  return [
    {
      key: "scope",
      title: "Write down the scope in docs/scope.md",
      outcome: `docs/scope.md says what is in and out of scope for: ${goal.slice(0, 120)}`,
      acceptanceCriteria: ["docs/scope.md lists what is in scope and what is not"],
      priority: "high",
      dependsOn: [],
      specialist: "writer-marketing",
    },
    {
      key: "build",
      title: "Build the first working version in src/main.js",
      outcome: "src/main.js runs with node and does the smallest useful thing the brief asks for.",
      acceptanceCriteria: ["node src/main.js exits 0"],
      priority: "high",
      dependsOn: ["scope"],
      specialist: "coder",
    },
    {
      key: "test",
      title: "Add a check for src/main.js in test/main.test.js",
      outcome: "test/main.test.js checks the main behaviour of src/main.js.",
      acceptanceCriteria: ["node --check passes on test/main.test.js"],
      priority: "medium",
      dependsOn: ["build"],
      specialist: "tester",
    },
    {
      key: "readme",
      title: "Write the README with how to run it",
      outcome: "README.md says what the project does and how to run it.",
      acceptanceCriteria: ["README.md has a 'How to run' section"],
      priority: "low",
      dependsOn: ["build"],
      specialist: "writer-marketing",
    },
  ];
}

function chainTasks(web: boolean): PlanTaskOut[] {
  const steps = web
    ? [
        ["Create index.html", "index.html", "coder"],
        ["Add the quote list in quotes.js", "quotes.js", "coder"],
        ["Pick a random quote in script.js", "script.js", "coder"],
        ["Style the page in styles.css", "styles.css", "designer"],
        ["Add a 'New quote' button in button.js", "button.js", "coder"],
        ["Check every file loads in check-notes.md", "check-notes.md", "tester"],
        ["Write the README.md", "README.md", "writer-marketing"],
      ]
    : [1, 2, 3, 4, 5, 6, 7].map((n) => [
        `Step ${n} of 7: write part ${n} in parts/part-${n}.md`,
        `parts/part-${n}.md`,
        n % 2 ? "writer-marketing" : "coder",
      ]);
  return steps.map(([title, file, specialist], i) => ({
    key: `step${i + 1}`,
    title: title as string,
    outcome: `${file} exists and builds on the step before.`,
    acceptanceCriteria: [`${file} exists`],
    priority: "medium" as const,
    dependsOn: i === 0 ? [] : [`step${i}`],
    specialist: specialist as string,
  }));
}

function personTask(web: boolean): PlanTaskOut {
  return {
    key: "decide",
    title: web ? "Decide where the page is published" : "Decide who the project is for",
    outcome: "The person's answers are in the decision record.",
    acceptanceCriteria: web
      ? [
          "Where should the page be published: GitHub Pages, Netlify, or only as a local file?",
          "Should the quotes be in English only?",
        ]
      : ["Who is the first user of this project?", "What must the first version do?"],
    priority: "high",
    dependsOn: [],
    specialist: "person",
  };
}

export function planFor(input: IntakeInput, opts: PlanOptions): PlanShape {
  const text = `${input.goal}\n${input.brief}`;
  const web = isWebBrief(text);
  const quotes = /\bquotes?\b/i.test(text);
  let tasks =
    opts.kind === "chain" ? chainTasks(web) : web ? webTasks(quotes) : genericTasks(input.goal);
  if (opts.personTask) {
    const decide = personTask(web);
    const last = tasks.at(-1);
    tasks = [
      decide,
      ...tasks.slice(0, -1),
      ...(last ? [{ ...last, dependsOn: [...last.dependsOn, decide.key] }] : []),
    ];
  }
  if (opts.risk2.length)
    tasks = tasks.map((t) =>
      opts.risk2.some((n) => n && t.title.toLowerCase().includes(n.toLowerCase()))
        ? { ...t, riskTier: 2 }
        : t,
    );
  const decision = web
    ? {
        slug: "plain-static-page",
        title: "A plain static page, no build step",
        body: [
          "## Decision",
          "",
          "The page is plain HTML, CSS and JavaScript in three files (index.html, styles.css,",
          "script.js), opened straight from the folder. No framework, no build step, no server.",
          "",
          "## Why",
          "",
          "- The brief asks for no build step and a single page.",
          quotes
            ? "- The quotes live in script.js as a list; no network call is needed to show one."
            : "- The content lives in the files themselves; no network call is needed.",
          "",
          "## Assumed",
          "",
          "- Hosting is not decided; the page works as a local file and on any static host.",
        ].join("\n"),
      }
    : {
        slug: "start-small",
        title: "Start with the smallest working version",
        body: [
          "## Decision",
          "",
          "Build the smallest version that does what the brief asks, in plain JavaScript run with",
          "Node.js, before adding anything else.",
          "",
          "## Why",
          "",
          "- The brief does not name a stack; Node.js runs on Windows and Linux without setup.",
        ].join("\n"),
      };
  return {
    milestone: web ? "First working page" : "First working version",
    successCriteria: web
      ? ["Opening index.html shows the page with its content", "README.md says how to open it"]
      : ["The first version runs", "README.md says how to run it"],
    tasks,
    decision,
  };
}

/** The intake reply object (IntakeProposalBody in packages/runtime/src/session/intake.ts). */
export function intakeProposal(input: IntakeInput, opts: PlanOptions): Record<string, unknown> {
  const plan = planFor(input, opts);
  const name = input.project || "the project";
  const goal = input.goal || input.brief.split("\n")[0] || name;
  const ready = plan.tasks;
  const docs: Record<string, string> = {
    "README.md": `# ${name}\n\n${goal}\n\nPlanned by Forerunner (stand-in model). See docs/overview.md.\n`,
    "docs/overview.md": `# Overview\n\n${goal}\n\n## Brief\n\n${input.brief.slice(0, 1500) || "(no brief)"}\n`,
    "docs/architecture.md": `# Architecture\n\n${
      isWebBrief(`${input.goal}\n${input.brief}`)
        ? "Three static files: index.html (structure), styles.css (look), script.js (behaviour)."
        : "One Node.js entry point, src/main.js, with a check in test/."
    }\n`,
    [`docs/decisions/0001-${plan.decision.slug}.md`]: `# 0001: ${plan.decision.title}\n\n${plan.decision.body}\n`,
  };
  return {
    plan: {
      reason: `planned from the brief for ${name}`,
      milestones: [
        {
          name: plan.milestone,
          successCriteria: plan.successCriteria,
          targetDate: null,
          tasks: plan.tasks.map((t) => ({
            key: t.key,
            title: t.title,
            outcome: t.outcome,
            acceptanceCriteria: t.acceptanceCriteria,
            priority: t.priority,
            dependsOn: t.dependsOn,
            specialist: t.specialist,
            ...(t.riskTier !== undefined ? { riskTier: t.riskTier } : {}),
          })),
        },
      ],
      tasks: [],
    },
    docs,
    firstSession: {
      summary: `Start with ${ready[0]?.title ?? "the first task"} and the tasks that follow from it.`,
      items: ready.map((t, i) => ({
        key: t.key,
        estimateUsdMicro: 150_000 + i * 25_000,
        rationale:
          i === 0
            ? "nothing else can start before it"
            : `follows ${t.dependsOn.join(", ") || "the plan order"}`,
      })),
    },
  };
}

// ---------------------------------------------------------------------------------------
// What a specialist writes
// ---------------------------------------------------------------------------------------

const FILE_RE =
  /(?:^|[\s(`'"])((?:[\w-]+\/)*[\w-]+\.(?:html|css|js|mjs|ts|md|json|txt|py|yml|yaml))\b/gi;

/** Files a brief names (title, outcome, criteria), in order, at most six. */
export function filesNamed(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(FILE_RE)) {
    const f = m[1];
    if (f && !out.includes(f) && !/^(e\.g|i\.e)\./i.test(f)) out.push(f);
  }
  return out.slice(0, 6);
}

/** The file a specialist writes when its brief names none. */
export function defaultFile(title: string, specialist: string): string {
  return `notes/${slug(specialist, 20)}-${slug(title)}.md`;
}

const QUOTES: readonly [string, string][] = [
  ["Well begun is half done.", "Aristotle"],
  ["The journey of a thousand miles begins with one step.", "Lao Tzu"],
  ["Knowing yourself is the beginning of all wisdom.", "Aristotle"],
  ["It does not matter how slowly you go as long as you do not stop.", "Confucius"],
  ["Life is really simple, but we insist on making it complicated.", "Confucius"],
  ["The best way out is always through.", "Robert Frost"],
  ["Be yourself; everyone else is already taken.", "Oscar Wilde"],
  ["He who has a why to live can bear almost any how.", "Friedrich Nietzsche"],
  ["Simplicity is the ultimate sophistication.", "Leonardo da Vinci"],
  ["What we think, we become.", "Buddha"],
];

/**
 * Plausible content for `file`, from the task's title, outcome and criteria and what the
 * specialist read in the folder (`seen`: the files it read, so a README writer that read
 * script.js knows the page shows quotes).
 */
export function contentFor(
  file: string,
  task: { title: string; outcome: string; criteria: string[] },
  seen = "",
): string {
  const lower = file.toLowerCase();
  const about = `${task.title}\n${task.outcome}\n${task.criteria.join("\n")}\n${seen}`;
  const quotes = /\bquotes?\b/i.test(about);
  if (lower.endsWith(".html")) {
    return [
      "<!doctype html>",
      '<html lang="en">',
      "  <head>",
      '    <meta charset="utf-8" />',
      '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
      `    <title>${quotes ? "A random quote" : "Page"}</title>`,
      '    <link rel="stylesheet" href="styles.css" />',
      '    <script src="script.js" defer></script>',
      "  </head>",
      "  <body>",
      "    <main>",
      quotes
        ? '      <blockquote id="quote">Loading a quote…</blockquote>\n      <p id="author"></p>'
        : '      <h1 id="title">Hello</h1>\n      <p id="content"></p>',
      "    </main>",
      "  </body>",
      "</html>",
      "",
    ].join("\n");
  }
  if (lower.endsWith(".css")) {
    return [
      "body {",
      "  margin: 0;",
      "  min-height: 100vh;",
      "  display: grid;",
      "  place-items: center;",
      "  font-family: Georgia, 'Times New Roman', serif;",
      "  background: #f7f4ee;",
      "  color: #222;",
      "}",
      "",
      "main {",
      "  max-width: 40rem;",
      "  padding: 2rem;",
      "  text-align: center;",
      "}",
      "",
      "blockquote {",
      "  font-size: clamp(1.4rem, 4vw, 2.2rem);",
      "  line-height: 1.4;",
      "  margin: 0 0 1rem;",
      "}",
      "",
      "#author {",
      "  font-style: italic;",
      "  color: #555;",
      "}",
      "",
    ].join("\n");
  }
  if (lower.endsWith(".js") || lower.endsWith(".mjs")) {
    if (quotes && !/test/.test(lower)) {
      return [
        "// Shows a random quote each time the page is opened.",
        "const QUOTES = [",
        ...QUOTES.map(
          ([q, a]) => `  { text: ${JSON.stringify(q)}, author: ${JSON.stringify(a)} },`,
        ),
        "];",
        "",
        "function pickQuote(list) {",
        "  return list[Math.floor(Math.random() * list.length)];",
        "}",
        "",
        "if (typeof document !== 'undefined') {",
        "  document.addEventListener('DOMContentLoaded', () => {",
        "    const quote = pickQuote(QUOTES);",
        "    document.getElementById('quote').textContent = quote.text;",
        "    document.getElementById('author').textContent = '— ' + quote.author;",
        "  });",
        "}",
        "",
      ].join("\n");
    }
    return [
      `// ${task.title}`,
      `// ${task.outcome}`,
      "function main() {",
      `  return ${JSON.stringify(task.outcome.slice(0, 80))};`,
      "}",
      "",
      "if (typeof process !== 'undefined' && process.argv[1] && process.argv[1].endsWith('main.js')) {",
      "  console.log(main());",
      "}",
      "",
    ].join("\n");
  }
  if (lower.endsWith(".json"))
    return `${JSON.stringify({ name: slug(task.title), private: true }, null, 2)}\n`;
  if (lower.endsWith(".py"))
    return `# ${task.title}\nprint(${JSON.stringify(task.outcome.slice(0, 80))})\n`;
  if (lower.endsWith("readme.md")) {
    return [
      quotes ? "# A random quote" : `# ${task.title.replace(/^Write (the )?/i, "")}`,
      "",
      quotes
        ? "A one-page website that shows a random quote each time it is opened."
        : task.outcome,
      "",
      "## How to open it",
      "",
      "Open `index.html` in any web browser (double-click it). There is no build step and",
      "nothing to install.",
      "",
    ].join("\n");
  }
  return [
    `# ${task.title}`,
    "",
    task.outcome,
    "",
    "## Covers",
    "",
    ...task.criteria.map((c) => `- ${c}`),
    "",
  ].join("\n");
}
