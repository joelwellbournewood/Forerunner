import { ForerunnerError } from "@forerunner/platform";

/**
 * A small, tolerant HTML parser and CSS selector matcher with no dependencies. It exists so the
 * page extractor and the guards can run on HTML fixtures without a browser (the injection suite
 * runs in CI without Chromium). It is not a spec-complete parser: it builds a tree from start
 * tags, end tags, comments and text, treats script/style/textarea/title as raw text, knows the
 * void elements and closes p/li/option/td/th/tr/dt/dd implicitly.
 */
export interface HtmlElement {
  kind: "element";
  tag: string;
  attrs: Record<string, string>;
  children: HtmlNode[];
  parent: HtmlElement | null;
}

export interface HtmlText {
  kind: "text";
  text: string;
  parent: HtmlElement | null;
}

export interface HtmlComment {
  kind: "comment";
  text: string;
  parent: HtmlElement | null;
}

export type HtmlNode = HtmlElement | HtmlText | HtmlComment;

const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

const RAW_TEXT = new Set(["script", "style", "textarea", "title", "xmp"]);

const BLOCK_CLOSES_P = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "details",
  "div",
  "dl",
  "fieldset",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "ul",
]);

/** Tags that close an open element of the same name, bounded by a scope tag. */
const SELF_CLOSING_SCOPE: Record<string, Set<string>> = {
  li: new Set(["ul", "ol", "menu"]),
  dt: new Set(["dl"]),
  dd: new Set(["dl"]),
  option: new Set(["select", "datalist"]),
  td: new Set(["tr", "table"]),
  th: new Set(["tr", "table"]),
  tr: new Set(["table", "tbody", "thead", "tfoot"]),
};

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  deg: "°",
  middot: "·",
  bull: "•",
  times: "×",
  divide: "÷",
  zwnj: "‌",
  zwj: "‍",
  shy: "­",
};

export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return m;
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? m;
  });
}

function makeElement(tag: string, attrs: Record<string, string>, parent: HtmlElement | null) {
  const el: HtmlElement = { kind: "element", tag, attrs, children: [], parent };
  parent?.children.push(el);
  return el;
}

function appendText(parent: HtmlElement, text: string): void {
  if (!text) return;
  const last = parent.children[parent.children.length - 1];
  if (last && last.kind === "text") last.text += text;
  else parent.children.push({ kind: "text", text, parent });
}

const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

function parseAttrs(src: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  for (;;) {
    const m = ATTR_RE.exec(src);
    if (!m) break;
    const name = (m[1] ?? "").toLowerCase();
    if (!name || name === "/") continue;
    const value = m[2] ?? m[3] ?? m[4] ?? "";
    if (!(name in attrs)) attrs[name] = decodeEntities(value);
  }
  return attrs;
}

/** Parse HTML into a tree. The returned root is a synthetic `#document` element. */
export function parseHtml(html: string): HtmlElement {
  const root = makeElement("#document", {}, null);
  let cur = root;
  let i = 0;
  const n = html.length;

  const findOpen = (tag: string, stopAt?: Set<string>): HtmlElement | null => {
    for (let e: HtmlElement | null = cur; e && e !== root; e = e.parent) {
      if (e.tag === tag) return e;
      if (stopAt?.has(e.tag)) return null;
    }
    return null;
  };
  const closeTo = (el: HtmlElement) => {
    cur = el.parent ?? root;
  };

  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      appendText(cur, decodeEntities(html.slice(i)));
      break;
    }
    if (lt > i) appendText(cur, decodeEntities(html.slice(i, lt)));
    i = lt;

    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      const body = end === -1 ? html.slice(i + 4) : html.slice(i + 4, end);
      cur.children.push({ kind: "comment", text: body, parent: cur });
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (html.startsWith("<!", i) || html.startsWith("<?", i)) {
      const end = html.indexOf(">", i);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (html.startsWith("</", i)) {
      const end = html.indexOf(">", i);
      const name = html
        .slice(i + 2, end === -1 ? n : end)
        .trim()
        .toLowerCase()
        .split(/\s/)[0];
      i = end === -1 ? n : end + 1;
      if (!name) continue;
      const open = findOpen(name);
      if (open) closeTo(open);
      continue;
    }
    const tagMatch = /^<([a-zA-Z][^\s/>]*)/.exec(html.slice(i, i + 200));
    if (!tagMatch) {
      appendText(cur, "<");
      i += 1;
      continue;
    }
    const tag = (tagMatch[1] ?? "").toLowerCase();
    // find the end of the start tag, honouring quotes
    let j = i + tagMatch[0].length;
    let quote: string | null = null;
    while (j < n) {
      const c = html[j];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === ">") break;
      j++;
    }
    const inner = html.slice(i + tagMatch[0].length, j);
    const selfClosing = /\/\s*$/.test(inner);
    const attrs = parseAttrs(selfClosing ? inner.replace(/\/\s*$/, "") : inner);
    i = Math.min(n, j + 1);

    if (tag === "p" || BLOCK_CLOSES_P.has(tag)) {
      const p = findOpen("p", new Set(["div", "section", "article", "td", "th", "li", "main"]));
      if (p && (tag === "p" || p === cur)) closeTo(p);
    }
    const scope = SELF_CLOSING_SCOPE[tag];
    if (scope) {
      const same = findOpen(tag, scope);
      if (same) closeTo(same);
    }

    const el = makeElement(tag, attrs, cur);
    if (VOID.has(tag) || selfClosing) continue;
    if (RAW_TEXT.has(tag)) {
      const closeRe = new RegExp(`</${tag}\\s*>`, "i");
      const rest = html.slice(i);
      const m = closeRe.exec(rest);
      const raw = m ? rest.slice(0, m.index) : rest;
      appendText(el, tag === "textarea" || tag === "title" ? decodeEntities(raw) : raw);
      i = m ? i + m.index + m[0].length : n;
      continue;
    }
    cur = el;
  }
  return root;
}

export function getAttr(el: HtmlElement, name: string): string | undefined {
  return el.attrs[name.toLowerCase()];
}

export function hasAttr(el: HtmlElement, name: string): boolean {
  return name.toLowerCase() in el.attrs;
}

/** Concatenated text of every descendant text node (comments and raw script/style excluded). */
export function textContent(node: HtmlNode, opts: { skipRaw?: boolean } = {}): string {
  if (node.kind === "text") return node.text;
  if (node.kind === "comment") return "";
  if (opts.skipRaw !== false && RAW_TEXT.has(node.tag) && node.tag !== "textarea") return "";
  let out = "";
  for (const c of node.children) out += textContent(c, opts);
  return out;
}

export function* walkElements(root: HtmlElement): Generator<HtmlElement> {
  const stack: HtmlNode[] = [...root.children].reverse();
  while (stack.length) {
    const node = stack.pop();
    if (node?.kind !== "element") continue;
    yield node;
    for (let k = node.children.length - 1; k >= 0; k--) {
      const c = node.children[k];
      if (c) stack.push(c);
    }
  }
}

export function* walkNodes(root: HtmlElement): Generator<HtmlNode> {
  const stack: HtmlNode[] = [...root.children].reverse();
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    yield node;
    if (node.kind === "element") {
      for (let k = node.children.length - 1; k >= 0; k--) {
        const c = node.children[k];
        if (c) stack.push(c);
      }
    }
  }
}

export function classList(el: HtmlElement): string[] {
  return (el.attrs.class ?? "").split(/\s+/).filter(Boolean);
}

// ---------------------------------------------------------------------------------------------
// Selectors: tag, #id, .class, [attr], [attr=value] (= ^= $= *= ~=), compound, descendant (" ")
// and child (">") combinators, comma lists. Anything else is a validation error.
// ---------------------------------------------------------------------------------------------

interface AttrTest {
  name: string;
  op?: "=" | "^=" | "$=" | "*=" | "~=";
  value?: string;
}

interface Compound {
  tag?: string;
  id?: string;
  classes: string[];
  attrs: AttrTest[];
}

interface Complex {
  parts: { compound: Compound; combinator: " " | ">" }[];
}

const COMPOUND_RE =
  /^([a-zA-Z][\w-]*|\*)?((?:#[\w-]+|\.[\w-]+|\[[^\]]+\])*)$|^(?:(#[\w-]+|\.[\w-]+|\[[^\]]+\])+)$/;

function parseCompound(src: string): Compound {
  const c: Compound = { classes: [], attrs: [] };
  const s = src.trim();
  if (!s || !COMPOUND_RE.test(s)) {
    throw new ForerunnerError("validation", `unsupported selector: ${src}`);
  }
  let rest = s;
  const tag = /^([a-zA-Z][\w-]*|\*)/.exec(rest);
  if (tag) {
    if (tag[1] !== "*") c.tag = (tag[1] ?? "").toLowerCase();
    rest = rest.slice(tag[0].length);
  }
  const partRe = /#([\w-]+)|\.([\w-]+)|\[([^\]]+)\]/g;
  for (;;) {
    const m = partRe.exec(rest);
    if (!m) break;
    if (m[1]) c.id = m[1];
    else if (m[2]) c.classes.push(m[2]);
    else if (m[3]) {
      const am = /^\s*([\w:-]+)\s*(?:([\^$*~]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+)))?\s*$/.exec(
        m[3],
      );
      if (!am) throw new ForerunnerError("validation", `unsupported attribute selector: ${m[3]}`);
      const t: AttrTest = { name: (am[1] ?? "").toLowerCase() };
      if (am[2]) {
        t.op = am[2] as AttrTest["op"];
        t.value = am[3] ?? am[4] ?? am[5] ?? "";
      }
      c.attrs.push(t);
    }
  }
  return c;
}

function parseComplex(src: string): Complex {
  const tokens = src
    .trim()
    .replace(/\s*>\s*/g, " > ")
    .split(/\s+/)
    .filter(Boolean);
  const parts: Complex["parts"] = [];
  let combinator: " " | ">" = " ";
  for (const t of tokens) {
    if (t === ">") {
      combinator = ">";
      continue;
    }
    parts.push({ compound: parseCompound(t), combinator });
    combinator = " ";
  }
  if (!parts.length) throw new ForerunnerError("validation", `empty selector: ${src}`);
  return { parts };
}

function matchesCompound(el: HtmlElement, c: Compound): boolean {
  if (c.tag && el.tag !== c.tag) return false;
  if (c.id && el.attrs.id !== c.id) return false;
  if (c.classes.length) {
    const have = classList(el);
    if (!c.classes.every((k) => have.includes(k))) return false;
  }
  for (const a of c.attrs) {
    const v = el.attrs[a.name];
    if (v === undefined) return false;
    if (!a.op) continue;
    const want = a.value ?? "";
    const lv = v.toLowerCase();
    const lw = want.toLowerCase();
    if (a.op === "=" && lv !== lw) return false;
    if (a.op === "^=" && !lv.startsWith(lw)) return false;
    if (a.op === "$=" && !lv.endsWith(lw)) return false;
    if (a.op === "*=" && !lv.includes(lw)) return false;
    if (a.op === "~=" && !lv.split(/\s+/).includes(lw)) return false;
  }
  return true;
}

function matchesComplex(el: HtmlElement, sel: Complex): boolean {
  const parts = sel.parts;
  const last = parts[parts.length - 1];
  if (!last || !matchesCompound(el, last.compound)) return false;
  let idx = parts.length - 2;
  let node: HtmlElement | null = el;
  let comb = last.combinator;
  while (idx >= 0) {
    const part = parts[idx];
    if (!part) break;
    if (comb === ">") {
      node = node?.parent ?? null;
      if (!node || node.tag === "#document" || !matchesCompound(node, part.compound)) return false;
    } else {
      let found: HtmlElement | null = null;
      for (
        let a: HtmlElement | null = node?.parent ?? null;
        a && a.tag !== "#document";
        a = a.parent
      ) {
        if (matchesCompound(a, part.compound)) {
          found = a;
          break;
        }
      }
      if (!found) return false;
      node = found;
    }
    comb = part.combinator;
    idx--;
  }
  return true;
}

export function querySelectorAll(root: HtmlElement, selector: string): HtmlElement[] {
  const list = selector
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseComplex);
  if (!list.length) throw new ForerunnerError("validation", `empty selector: ${selector}`);
  const out: HtmlElement[] = [];
  for (const el of walkElements(root)) {
    if (list.some((sel) => matchesComplex(el, sel))) out.push(el);
  }
  return out;
}

export function querySelector(root: HtmlElement, selector: string): HtmlElement | null {
  return querySelectorAll(root, selector)[0] ?? null;
}

export function closest(el: HtmlElement, tag: string): HtmlElement | null {
  for (let e: HtmlElement | null = el; e && e.tag !== "#document"; e = e.parent) {
    if (e.tag === tag) return e;
  }
  return null;
}

/** Parse `a: b; c: d` into a lower-cased property map. */
export function parseDeclarations(style: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!style) return out;
  for (const decl of style.split(";")) {
    const idx = decl.indexOf(":");
    if (idx === -1) continue;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    const value = decl
      .slice(idx + 1)
      .replace(/!important/gi, "")
      .trim()
      .toLowerCase();
    if (prop) out[prop] = value;
  }
  return out;
}

export interface StyleRule {
  selector: Compound;
  declarations: Record<string, string>;
}

/**
 * Parse the simple rules of a stylesheet: single compound selectors (`.x`, `#y`, `tag`,
 * `tag.x`) with their declarations. At-rules and complex selectors are skipped: the static
 * extractor is a heuristic, the browser path uses real computed styles.
 */
export function parseStylesheet(css: string): StyleRule[] {
  const rules: StyleRule[] = [];
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (;;) {
    const m = re.exec(src);
    if (!m) break;
    const selectors = (m[1] ?? "").trim();
    if (!selectors || selectors.startsWith("@")) continue;
    const declarations = parseDeclarations(m[2]);
    for (const s of selectors.split(",")) {
      const t = s.trim();
      if (!t || /[\s>+~:]/.test(t)) continue;
      try {
        rules.push({ selector: parseCompound(t), declarations });
      } catch {
        // unsupported selector: ignore
      }
    }
  }
  return rules;
}

export function applyStyleRules(el: HtmlElement, rules: StyleRule[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rules) {
    if (matchesCompound(el, r.selector)) Object.assign(out, r.declarations);
  }
  Object.assign(out, parseDeclarations(el.attrs.style));
  return out;
}
