# 0107 — Research reads public web pages on an API key: Forerunner's own page reader, its network rules, no search

Date: 2026-11-02
Status: accepted

## Context

The owner decided on 2026-11-01 (`docs/status/handoff/NEXT-SESSION.md`, "Owner decisions"):
give the researcher and the science-evaluator web access on the API-key path through
Forerunner's own fetch/search capability, within the network rules, so plans can include
research.

Until now the registry's researcher and science-evaluator named `cc:WebFetch` and `cc:WebSearch`,
which only the Agent SDK driver (a Claude subscription) offers. Every run billed to an API key
goes through the in-process loop driver, which had no equivalent (ADR 0043), so U-044 routed such
a task to another specialist that reaches the web and, with none, to the person. Live (phase D,
2026-11-02) that meant: the researcher's and the science-evaluator's tasks were refused at once,
the task showed "Paused" and "needs your decision (Inbox)" with no card in the Inbox, and nothing
ran, even for a science check that needed only the project's data file. The intake was told to
plan no web work on an API key at all.

The app's existing network rules for tasks are allowlists: a run token lists domains (ADR 0004,
spec "Capability tokens"), the sandbox's egress proxy allows only those (ADR 0007), and the
browser capability reads the project's site list and block list (`settings.browser`, ADR 0047).
The researcher's registry entry names no domain, and no screen lets a person set a project's site
list, so "the token's domains only" would have left research with nothing it may read.
`packages/capabilities` holds no search capability and the loop driver has no search provider.

## Decision

1. **`web_fetch`, the loop driver's `cc:WebFetch`.** The web capability
   (`packages/capabilities/src/web/`) adds one tool: read one page by its full address with a GET
   and return its text. `registry/tools.ts` maps `WebFetch` to it; the composition root
   registers it as a built-in, so the researcher and the science-evaluator keep their registry
   entries and get it on an API key. `FORERUNNER_WEB_FETCH=off` leaves it out.
2. **Its network rules, all in code before a byte leaves the machine** (`web/policy.ts`):
   - only `http:` and `https:`, at most 2,000 characters, no user name or password in the
     address; no cookie, no authorisation header, no body; a user agent that says an AI agent
     reads;
   - the project's block list (`settings.browser.blockedDomains`) refuses a host, whatever else
     says;
   - a host the project names on its site list (`settings.browser.allowedDomains`, the browser's
     list) is read wherever it points, the local network included: the person named it;
   - any other host is read only while every address it resolves to is public. This computer,
     the private and shared ranges, link-local (cloud metadata), carrier-grade NAT, multicast,
     documentation and reserved ranges are refused, IPv4 inside IPv6 included. The check runs in
     the HTTP client's `lookup`, on the addresses the connection then uses, so a name that
     resolves to a private address, or changes its answer between two lookups, is refused too;
   - redirects are followed by the tool, hop by hop through the same rules, at most five;
   - at most 2 MiB (decompressed) within 30 s, and the run's own stop ends the request;
   - HTML becomes readable text through the browser's extractor (hidden text apart and flagged);
     text, JSON, XML, CSV and markdown pass as they are; anything else is refused in words.
   The result is untrusted data (`web_page`, the final address): the hooks wrap it in the data
   envelope, scan it for instructions and audit the call. A refusal by these rules is an error
   result in words ("Refused: 10.0.0.7 is a private or local network address; research reads
   public web pages only …") and an audit row with `allowed: false` and the reason.
3. **The token's domains stay the sandbox's egress and the browser's allowlist.** `web_fetch`
   declares no `domainFields`: its own rules above govern it. The run token still has to list
   the tool (only entries that name `cc:WebFetch` get it), and the science-evaluator's commands
   still run in a sandbox whose egress is the token's (empty) domain list: no command of a task
   reaches the web through this decision.
4. **No web search on an API key.** No search capability or provider exists in
   `packages/capabilities`; `cc:WebSearch` stays unmapped on the loop driver (one
   `registry.tool_unmapped` audit row, as before). The brief of a researcher on an API key says
   so: read pages by their address (the sources the brief names, the official site or
   documentation of what is researched, the pages those link to) and cite each page used.
5. **Route by what the task needs.** Where a runtime offers no web reader on the run's driver,
   the task still goes to a specialist that reaches the web when one fits (U-044); with none, the
   specialist runs without the web and its brief says so ("This run has no web access … If the
   task cannot be done without reading the web, stop and say so in the report"). It never waits
   for the person with no card, and a data-only task is never refused for a tool it does not
   need. The intake's "plan no web work" rule applies only to an install with no web reader and
   no subscription.
6. **The critic sees the sources.** The executor keeps every page a run read (address, status,
   title, the text it got, at most 8,000 characters of each of up to 12 pages) and the pages it
   could not read; the critic's evidence lists each page read as an input file named
   `web page <address>` (data) and each page not read as an artifact line, so a cited claim is
   checked against the text the specialist actually got. The Run row keeps the addresses, not the
   text. The session log names each page in one line ("read the web page gohugo.io/about/").

## Consequences

- A plan from a brief on an API key may include research; the researcher and the
  science-evaluator run on an API key. Nothing changes on a subscription: the Agent SDK's own
  `WebFetch` and `WebSearch` keep the token's domain check (ADR 0044), which for the researcher's
  empty list refuses every page; that path is a known gap (below).
- Research reads the public web without a per-site approval. The cost is the usual one of a
  reading agent: a page could carry instructions (wrapped as data, scanned, flagged and
  notified), and a manipulated model could put words from the project into a page address it
  asks for. Mitigations: only the two reading specialists get the tool, the researcher has no
  command tool, secrets never enter a model's context, every address is in the audit log and the
  session log, and a project can block hosts. A project that must stay closed sets its block
  list (no screen for it yet) or the install sets `FORERUNNER_WEB_FETCH=off`.
- A computer that reaches the web only through a proxy cannot read pages yet: the tool connects
  directly (the HTTP client ignores proxy variables).
- Known gaps: no search on an API key; the subscription path's `WebFetch` is still checked
  against the token's domains (empty for the researcher), so research there reads no page; no
  screen sets a project's site list or block list; PDF pages are refused.

## Alternatives considered

- **The token's domain list only** (declare `domainFields`): the researcher's list is empty and
  no screen sets one, so research would read nothing; it would also mean widening the token's
  domains, which are the sandbox's egress, to reach any site.
- **A wildcard "any public host" pattern in the token**: the same list is the sandbox's egress
  allowlist and the browser's site policy; one marker would have to mean different things in
  three places, and a science-evaluator's commands would reach the web.
- **The browser capability** (`browser_navigate`): it is off until the person adds it in
  Extensions and reads only the project's site list; a reading tool that needs neither is what
  the owner asked for.
- **Anthropic's server-side web search tool** on the Messages API: it runs outside the runtime's
  hooks (no per-call check, no audit row before it runs, a separate per-search charge the budget
  hooks do not price) and the stand-in model cannot play it; left for a later decision.
- **Scraping a search engine's result page**: brittle, against most engines' terms, and a search
  results page is reachable through `web_fetch` anyway when a model chooses to read one.
