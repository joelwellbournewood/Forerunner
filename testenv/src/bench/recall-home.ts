import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A home full of records for chat's recall (d1109-chat-recall, ADR 0114, CR-7): two projects,
 * 24 tasks (3 renamed, 2 cancelled), 6 sessions over four weeks, 14 cards (open and answered),
 * 5 decisions, 5 lessons, a docs folder, 120 lines of conversation in English and German, and a
 * second person whose records must never come back. The golden set (`RECALL_GOLDEN`, 24
 * questions with the record each must find) runs over it in packages/runtime/test/
 * recall-rank.test.ts; the bench and live check 4 seed the same home.
 *
 * The store is typed by what is used here, so testenv takes no dependency on the state package.
 */

interface Row {
  id: string;
  version: number;
}
type Insert = (row: Record<string, unknown>) => Promise<Row>;

export interface RecallHomeStore {
  project: { insert: Insert };
  task: { insert: Insert; patch: (id: string, patch: Record<string, unknown>) => Promise<Row> };
  session: { insert: Insert };
  run: { insert: Insert };
  costLedger: { record: Insert };
  humanRequest: {
    insert: Insert;
    answer: (id: string, version: number, answer: unknown, by: string) => Promise<Row>;
  };
  decision: { record: Insert };
  changeLog: { record: Insert };
  mergeRecord: { insert: Insert };
  event: { append: (sessionId: string, type: string, payload: unknown) => Promise<unknown> };
  human: { insert: Insert };
  agent: { insert: Insert };
}

export interface RecallHomeOptions {
  store: RecallHomeStore;
  /** Moves the store's clock forward to an ISO time (never back). */
  at: (iso: string) => Promise<void>;
  humanId: string;
  agentId: string;
  /** The conversation session of an agent for a project (ConversationAgent's own). */
  conversationSession: (agentId: string, projectId: string | null) => Promise<string>;
  /** Keeps a lesson in the agent's memory (the memory port's record). */
  recordLesson: (agentId: string, projectId: string | null, text: string) => Promise<void>;
  /** Where the main project's docs are written (README.md and docs/). */
  docsRoot: string;
}

export interface RecallHome {
  quote: string;
  bakery: string;
  kim: string;
  kimsAgent: string;
  tasks: Record<string, string>;
}

/** The clock of the seeded home's "now": Wednesday 11 Nov 2026, 10:00 in Zurich. */
export const RECALL_HOME_NOW = "2026-11-11T09:00:00.000Z";

const QUOTE_TASKS = [
  "Create the page skeleton in index.html",
  "Style the page in styles.css",
  "Show a random quote on every load",
  "Write the README",
  "Add a copy button",
  "Add the dark theme",
  "Check the page on a phone",
  "Write the FAQ",
  "Add the quote of the day",
  "Translate the page into German",
  "Add a share link",
  "Tidy the stylesheet",
  "Write the deploy notes",
  "Add keyboard shortcuts",
  "Measure the page load time",
  "Fix the footer on small screens",
];
const BAKERY_TASKS = [
  "Ask for the opening hours",
  "Photograph the bread counter",
  "Write the menu page",
  "Add the croissant prices",
  "Make the map to the shop",
  "Collect customer reviews",
  "Design the logo",
  "Set up the order form",
];

/** Renames (earlier title to the title now) and cancels. */
const RENAMES: [string, string][] = [
  ["Write the README", "Write the guide"],
  ["Add the dark theme", "Add the night mode"],
  ["Design the logo", "Draw the brand mark"],
];
const CANCELLED = ["Add keyboard shortcuts", "Collect customer reviews"];

/** English and German lines of the conversation about Quote Page (60 turns). */
const LINES: [string, string][] = [
  ["Das Logo bleibt dunkelblau", "Noted: the logo stays dark blue."],
  ["set the budget for this week", "I set the budget to CHF 2.00."],
  ["the quotes should come from a local file", "The quotes are read from quotes.json."],
  [
    "Wir veröffentlichen die Seite erst im Dezember",
    "Verstanden: die Veröffentlichung kommt im Dezember.",
  ],
  ["the font is Inter everywhere", "The page uses Inter for every heading and paragraph."],
  ["remind me what the share link does", "The share link copies the page address with the quote."],
];

export async function seedRecallHome(o: RecallHomeOptions): Promise<RecallHome> {
  const { store, at } = o;
  await at("2026-10-19T07:00:00.000Z");
  const project = (name: string, goal: string, agentId: string) =>
    store.project.insert({
      name,
      goal,
      repos: [],
      stage: "build",
      status: "active",
      budget_usd_micro: 0,
      autonomy_level: 2,
      summary_cache: {},
      data_assets: [],
      settings: { members: [agentId] },
      small_project_mode: false,
      active: true,
    });
  const quote = (await project("Quote Page", "A page that shows a random quote", o.agentId)).id;
  const bakery = (await project("Bakery", "A page for the bakery", o.agentId)).id;
  const kim = (
    await store.human.insert({ name: "Kim", email: "kim@example.test", timezone: "UTC" })
  ).id;
  const kimsAgent = (
    await store.agent.insert({ name: "Kai", owner_human_id: kim, kind: "principal" })
  ).id;
  await project("Kims Garden", "A page about the garden", kimsAgent);
  const tasks: Record<string, string> = {};
  // Every record is written at its own time, in time order (the store's clock never goes back).
  const plan: [string, () => Promise<void>][] = [];
  const later = (iso: string, step: () => Promise<void>) => plan.push([iso, step]);
  for (const [projectId, titles] of [
    [quote, QUOTE_TASKS],
    [bakery, BAKERY_TASKS],
  ] as const)
    for (const title of titles)
      tasks[title] = (
        await store.task.insert({
          project_id: projectId,
          title,
          outcome: `${title}.`,
          acceptance_criteria: [],
          risk_tier: 1,
          status: "ready",
          priority: 50,
          depends_on: [],
          budget_usd_micro: 0,
          reason: "",
        })
      ).id;
  // The renames as the drawer's Edit records them (task.update's change log), on 20 Oct.
  await at("2026-10-20T08:00:00.000Z");
  for (const [from, to] of RENAMES) {
    const id = tasks[from] as string;
    await store.task.patch(id, { title: to });
    await store.changeLog.record({
      human_id: o.humanId,
      agent_id: null,
      words_used: `Edit: ${to}`,
      commands: [{ name: "task.update" }],
      before: { task_id: id, title: from, fields: {} },
      after: { task_id: id, title: to },
      scope: "project",
      project_id: BAKERY_TASKS.includes(from) ? bakery : quote,
      source: "ui",
      sentence: `Changed "${from}": the title to "${to}". Undo.`,
    });
    tasks[to] = id;
  }
  for (const title of CANCELLED) {
    await store.task.patch(tasks[title] as string, { status: "cancelled" });
    await store.changeLog.record({
      human_id: o.humanId,
      agent_id: null,
      words_used: `cancel ${title}`,
      commands: [{ name: "task.transition" }],
      before: { task_id: tasks[title], status: "ready" },
      after: { task_id: tasks[title], status: "cancelled" },
      scope: "project",
      project_id: BAKERY_TASKS.includes(title) ? bakery : quote,
      source: "chat",
      sentence: `Cancelled "${title}". Undo.`,
    });
  }
  // Six sessions over four weeks: what each did, its result and its spend.
  const sessions: [string, string, string[], string[], number][] = [
    ["2026-10-21T09:00:00.000Z", quote, ["Create the page skeleton in index.html"], [], 300_000],
    [
      "2026-10-27T09:00:00.000Z",
      quote,
      ["Show a random quote on every load"],
      ["Style the page in styles.css"],
      450_000,
    ],
    ["2026-10-29T13:00:00.000Z", bakery, ["Ask for the opening hours"], [], 120_000],
    ["2026-11-03T09:00:00.000Z", quote, ["Write the guide", "Write the FAQ"], [], 400_000],
    [
      "2026-11-05T14:00:00.000Z",
      bakery,
      ["Write the menu page"],
      ["Make the map to the shop"],
      260_000,
    ],
    ["2026-11-06T13:00:00.000Z", quote, [], ["Translate the page into German"], 250_000],
  ];
  for (const [startedAt, projectId, done, failed, usd] of sessions)
    later(startedAt, async () => {
      const named = (titles: string[]) => titles.map((t) => ({ id: tasks[t], title: t }));
      for (const t of done) await store.task.patch(tasks[t] as string, { status: "done" });
      for (const t of failed)
        await store.task.patch(tasks[t] as string, {
          status: "failed",
          reason: t.startsWith("Translate")
            ? "the German strings file was empty"
            : t.startsWith("Make the map")
              ? "the map service refused the request"
              : "styles.css was never linked from index.html",
        });
      const row = await store.session.insert({
        agent_id: o.agentId,
        project_id: projectId,
        trigger: "manual",
        plan: {},
        budget_cap_usd_micro: 2_000_000,
        step_cap: 100,
        spent_usd_micro: usd,
        steps: 3,
        started_at: startedAt,
        ended_at: new Date(Date.parse(startedAt) + 40 * 60_000).toISOString(),
        status: "completed",
        summary: [
          done.length ? `Did ${done.map((t) => `"${t}"`).join(" and ")}.` : "",
          failed.length ? `${failed.map((t) => `"${t}"`).join(" and ")} failed.` : "",
        ]
          .filter(Boolean)
          .join(" "),
        handoff: {
          outcome: {
            done: named(done),
            failed: named(failed),
            needsYou: [],
            paused: [],
            cancelled: [],
            spentChfMicro: Math.round(usd * 0.8),
          },
        },
        runner: "pc",
      });
      await store.costLedger.record({
        human_id: o.humanId,
        agent_id: o.agentId,
        project_id: projectId,
        session_id: row.id,
        kind: "api",
        usd_micro: usd,
        chf_micro: Math.round(usd * 0.8),
        rate_chf_per_usd: 0.8,
        model: "fake-sonnet",
      });
    });
  // The guide's pull request merged on 4 Nov; the FAQ's waits for the person's Merge.
  later("2026-11-04T16:00:00.000Z", async () => {
    for (const [title, state, pr] of [
      ["Write the guide", "merged", 7],
      ["Write the FAQ", "queued", 8],
    ] as const)
      await store.mergeRecord.insert({
        task_id: tasks[title],
        project_id: quote,
        agent_id: o.agentId,
        pr_number: pr,
        pr_url: `https://github.test/o/quote/pull/${pr}`,
        reviewed_head_sha: "a".repeat(40),
        state,
        approval: state === "merged" ? "person" : "none",
      });
  });
  // Fourteen cards: ten answered, four open, over the weeks.
  const cards: [string, string, string, string[], unknown | null][] = [
    [
      "2026-10-22T10:00:00.000Z",
      quote,
      "Where is the page published?",
      ["On GitHub Pages", "Only as a local file for now"],
      { choice: "Only as a local file for now" },
    ],
    [
      "2026-10-23T10:00:00.000Z",
      quote,
      "Which font should the page use?",
      ["Inter", "Georgia"],
      { choice: "Inter" },
    ],
    [
      "2026-10-24T10:00:00.000Z",
      quote,
      "Should the quotes rotate every day?",
      ["Yes", "No"],
      { choice: "Yes" },
    ],
    [
      "2026-10-26T10:00:00.000Z",
      bakery,
      "What are the opening hours?",
      [],
      { answers: [{ question: "What are the opening hours?", answer: "Mon to Fri 9 to 18" }] },
    ],
    [
      "2026-10-28T10:00:00.000Z",
      bakery,
      "Which photos may we use?",
      ["Only the new ones", "All of them"],
      { choice: "Only the new ones" },
    ],
    [
      "2026-10-30T10:00:00.000Z",
      quote,
      "May the page load a web font?",
      ["Yes", "No, use system fonts"],
      { choice: "No, use system fonts" },
    ],
    [
      "2026-11-02T10:00:00.000Z",
      quote,
      "Which licence should the README name?",
      ["MIT", "Apache-2.0"],
      { choice: "MIT" },
    ],
    [
      "2026-11-04T10:00:00.000Z",
      bakery,
      "Where should the map point?",
      ["Main street 4", "The market stall"],
      { choice: "Main street 4" },
    ],
    [
      "2026-11-06T10:00:00.000Z",
      quote,
      "Should the copy button show a message?",
      ["Yes", "No"],
      { choice: "Yes" },
    ],
    [
      "2026-11-09T10:00:00.000Z",
      bakery,
      "What do the croissants cost?",
      [],
      { answers: [{ question: "What do the croissants cost?", answer: "CHF 2.20 each" }] },
    ],
    [
      "2026-11-10T10:00:00.000Z",
      quote,
      "Which phone should the check use?",
      ["An iPhone", "An Android phone"],
      null,
    ],
    ["2026-11-10T11:00:00.000Z", quote, "May the page track visits?", ["Yes", "No"], null],
    [
      "2026-11-10T12:00:00.000Z",
      bakery,
      "Is the order form for pickup only?",
      ["Pickup only", "Pickup and delivery"],
      null,
    ],
    ["2026-11-10T13:00:00.000Z", bakery, "Should the menu list allergens?", ["Yes", "No"], null],
  ];
  for (const [when, projectId, why, options, answer] of cards)
    later(when, async () => {
      const questions = Array.isArray((answer as { answers?: unknown } | null)?.answers);
      const r = await store.humanRequest.insert({
        human_id: o.humanId,
        project_id: projectId,
        kind: "decision",
        why,
        steps: questions ? [why] : [],
        options,
        blocking: false,
        risk: "low",
        ...(questions
          ? { change_card: { key: `person_questions:${why}`, outcome: "answered" } }
          : {}),
      });
      if (answer !== null) {
        await at(new Date(Date.parse(when) + 15 * 60_000).toISOString());
        await store.humanRequest.answer(r.id, r.version, answer, o.humanId);
      }
    });
  // Five decisions, as the Overview lists them.
  const decisions: [string, string, string, string][] = [
    [
      "2026-10-22T10:20:00.000Z",
      quote,
      "Where is the page published?",
      "Only as a local file for now",
    ],
    ["2026-10-23T10:20:00.000Z", quote, "Which font should the page use?", "Inter"],
    ["2026-10-30T10:20:00.000Z", quote, "May the page load a web font?", "No, use system fonts"],
    ["2026-11-02T10:20:00.000Z", quote, "Which licence should the README name?", "MIT"],
    ["2026-11-04T10:20:00.000Z", bakery, "Where should the map point?", "Main street 4"],
  ];
  for (const [when, projectId, question, chosen] of decisions)
    later(when, async () => {
      await store.decision.record({
        project_id: projectId,
        question,
        chosen,
        decided_by: o.humanId,
        rationale: "",
      });
    });
  // Five lessons of the principal; one private lesson of the other person's agent.
  later("2026-11-07T09:00:00.000Z", async () => {
    for (const text of [
      "The brand mark uses the dark blue of the logo sketch.",
      "Quotes are read from quotes.json, never from the network.",
      "The page is checked on a phone before it is called done.",
      "Prices are always shown in CHF with two decimals.",
      "Headings use sentence case on every page.",
    ])
      await o.recordLesson(o.agentId, quote, text);
    await o.recordLesson(
      kimsAgent,
      null,
      "Kim keeps the garden photos private and never shares the logo.",
    );
  });
  // The docs folder of Quote Page.
  mkdirSync(join(o.docsRoot, "docs"), { recursive: true });
  writeFileSync(
    join(o.docsRoot, "README.md"),
    "# Quote Page\n\nA page that shows a random quote from quotes.json.\n",
  );
  writeFileSync(
    join(o.docsRoot, "docs", "deploy.md"),
    "# Deploy\n\n## Steps\n\nCopy index.html, styles.css and quotes.json to the local folder. Nothing is published online yet.\n",
  );
  writeFileSync(
    join(o.docsRoot, "docs", "brand.md"),
    "# Brand\n\n## Colours\n\nThe logo is dark blue (#123a6b) on white.\n",
  );
  // 120 lines of conversation: 60 turns about Quote Page, English and German, and one line of
  // the other person's conversation on the same project.
  const sid = await o.conversationSession(o.agentId, quote);
  let n = 0;
  for (let day = 0; day < 10; day++) {
    for (const [i, [human, reply]] of LINES.entries()) {
      const when = new Date(Date.parse("2026-10-26T08:00:00.000Z") + day * 86_400_000 + i * 60_000);
      const turn = n;
      later(when.toISOString(), async () => {
        const said = day === 0 ? human : `${human} (${day + 1})`;
        const answer = day === 0 ? reply : `${reply} (${day + 1})`;
        for (const [type, text] of [
          ["chat.human", said],
          ["chat.reply", answer],
        ] as const)
          await store.event.append(sid, type, {
            transcriptId: `rh-${turn}`,
            text,
            source: "text",
            conversationProjectId: quote,
            actions: [],
            actionDetails: [],
          });
      });
      n++;
    }
  }
  const kimsSession = await o.conversationSession(kimsAgent, quote);
  await store.event.append(kimsSession, "chat.human", {
    transcriptId: "kim-1",
    text: "Kim's plan: publish the logo on the garden page",
    source: "text",
    conversationProjectId: quote,
  });
  plan.sort((a, b) => a[0].localeCompare(b[0]));
  for (const [when, step] of plan) {
    await at(when);
    await step();
  }
  await at(RECALL_HOME_NOW);
  return { quote, bakery, kim, kimsAgent, tasks };
}

/** One question of the golden set: the recall input and the record it must find. */
export interface RecallGolden {
  ask: string;
  input: {
    words?: string;
    also?: string[];
    kinds?: string[];
    from?: string;
    to?: string;
    project?: string;
  };
  /** A part of the hit line of the record it must find. */
  expect: string;
}

/** 24 questions a person asks about the seeded home, with what recall must find. */
export const RECALL_GOLDEN: RecallGolden[] = [
  {
    ask: "what did we decide about hosting?",
    input: { words: "hosting", also: ["published", "GitHub Pages"], kinds: ["decisions"] },
    expect: "Where is the page published?: Only as a local file",
  },
  {
    ask: "which font did I pick?",
    input: { words: "font", kinds: ["cards"] },
    expect: "Which font should the page use?",
  },
  {
    ask: "what did I answer about the opening hours?",
    input: { words: "opening hours", project: "Bakery" },
    expect: "Mon to Fri 9 to 18",
  },
  {
    ask: "what did the session of 3 Nov do?",
    input: { kinds: ["sessions"], from: "2026-11-03", to: "2026-11-03" },
    expect: 'Did 2 tasks: "Write the guide" and "Write the FAQ"',
  },
  {
    ask: "what happened to the README task?",
    input: { words: "README task" },
    expect: 'Earlier called "Write the README"',
  },
  {
    ask: "when was the README merged?",
    input: { words: "README merged", kinds: ["tasks"] },
    expect: "merged on 4 Nov",
  },
  {
    ask: "what about stlye the page?",
    input: { words: "stlye the page", kinds: ["tasks"] },
    expect: "Style the page in styles.css",
  },
  {
    ask: "what did I say about the logo?",
    input: { words: "logo", also: ["Logo", "dunkelblau"], kinds: ["conversation"] },
    expect: "Das Logo bleibt dunkelblau",
  },
  {
    ask: "what did you set the budget to?",
    input: { words: "budget to CHF 2.00", kinds: ["conversation"] },
    expect: "I set the budget to CHF 2.00.",
  },
  {
    ask: "wann veröffentlichen wir?",
    input: { words: "veröffentlichen", also: ["publish"], kinds: ["conversation"] },
    expect: "Wir veröffentlichen die Seite erst im Dezember",
  },
  {
    ask: "what did last week's sessions do?",
    input: { kinds: ["sessions"], from: "2026-11-02", to: "2026-11-08" },
    expect: "The session of Fri 6 Nov",
  },
  {
    ask: "why did the translation fail?",
    input: { words: "translation German failed", kinds: ["tasks", "sessions"] },
    expect: "Translate the page into German",
  },
  {
    ask: "what is the lesson about the brand colour?",
    input: { words: "brand colour", also: ["logo", "dark blue"], kinds: ["lessons"] },
    expect: "The brand mark uses the dark blue",
  },
  {
    ask: "how do we deploy?",
    input: { words: "deploy", kinds: ["documents"] },
    expect: "docs/deploy.md > Deploy > Steps",
  },
  {
    ask: "what colour is the logo in the docs?",
    input: { words: "logo colour", also: ["dark blue"], kinds: ["documents"] },
    expect: "docs/brand.md > Brand > Colours",
  },
  {
    ask: "what happened to the night mode?",
    input: { words: "dark theme", kinds: ["tasks"] },
    expect: "Add the night mode",
  },
  {
    ask: "which tasks did I cancel?",
    input: { words: "cancelled", kinds: ["changes"] },
    expect: 'cancelled "Add keyboard shortcuts"',
  },
  {
    ask: "what did the bakery work cost last week?",
    input: { kinds: ["spending"], from: "2026-11-02", to: "2026-11-08", project: "Bakery" },
    expect: "CHF 0.21",
  },
  {
    ask: "what did the croissants cost?",
    input: { words: "croissants price", also: ["cost"], kinds: ["cards"], project: "Bakery" },
    expect: "CHF 2.20 each",
  },
  {
    ask: "where does the map point?",
    input: { words: "map", kinds: ["decisions"], project: "Bakery" },
    expect: "Where should the map point?: Main street 4",
  },
  {
    ask: "which licence did we choose?",
    input: { words: "licence", also: ["license", "MIT"] },
    expect: "Which licence should the README name?",
  },
  {
    ask: "what is still open about tracking?",
    input: { words: "track visits", kinds: ["cards"] },
    expect: "May the page track visits?",
  },
  {
    ask: "what happened to the brand mark task?",
    input: { words: "logo", kinds: ["tasks"], project: "Bakery" },
    expect: "Draw the brand mark",
  },
  {
    ask: "what did I say about quotes in the first week?",
    input: {
      words: "quotes local file",
      kinds: ["conversation"],
      from: "2026-10-26",
      to: "2026-11-01",
    },
    expect: "the quotes should come from a local file",
  },
];
