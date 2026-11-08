import {
  cleanSiteList,
  type WebAccess,
  webAccessOf,
  webAccessWords,
} from "@forerunner/runtime/wiring/web-access";
import { Field, INPUT_CLASS } from "../components/ui.tsx";

/**
 * "Web pages research may read" ('sites', the owner's decision of 2026-11-02): the Settings row's
 * control, also opened from the Overview's "Research reads: ... · Change". Any public website
 * (with an optional list of websites research never reads) or only the websites listed. What the
 * person types goes through the daemon's own clean-up (`cleanSiteList`, the same module
 * `settings.set` uses) and is shown back before saving: each entry as it will be stored, each
 * one changed ("https://example.com/page" becomes "example.com"), and each one refused with its
 * reason; Save stays off until nothing is refused, so nothing is dropped silently.
 */

/** The dialog's value: the mode and the two lists as typed (one site per line). */
interface Draft {
  mode: "any" | "only";
  only: string;
  never: string;
}

function readDraft(raw: string): Draft {
  try {
    const v = JSON.parse(raw) as Partial<Draft>;
    return {
      mode: v.mode === "only" ? "only" : "any",
      only: typeof v.only === "string" ? v.only : "",
      never: typeof v.never === "string" ? v.never : "",
    };
  } catch {
    return { mode: "any", only: "", never: "" };
  }
}

/** The dialog's first value, from the rule in force (the row's value). */
export function webAccessInitial(current: unknown): string {
  const v: WebAccess = webAccessOf({ web_access: current as never });
  return JSON.stringify({ mode: v.mode, only: v.only.join("\n"), never: v.never.join("\n") });
}

/** What the draft cleans to, and whether it can be saved. */
export function cleanDraft(raw: string) {
  const d = readDraft(raw);
  const only = cleanSiteList(d.only, "only");
  const never = cleanSiteList(d.never, "never");
  const refused = [...(d.mode === "only" ? only.refused : []), ...never.refused];
  const empty = d.mode === "only" && only.sites.length === 0;
  const value: WebAccess = {
    mode: d.mode,
    only: d.mode === "only" ? only.sites : [],
    never: never.sites,
  };
  return {
    draft: d,
    value,
    changed: [...(d.mode === "only" ? only.changed : []), ...never.changed],
    refused,
    empty,
    ok: refused.length === 0 && !empty,
  };
}

/** The `settings.set` parameters for the draft, or null while an entry is refused. */
export function webAccessParams(
  raw: string,
  projectParam: Record<string, string>,
): Record<string, unknown> | null {
  const c = cleanDraft(raw);
  return c.ok ? { key: "web_access", value: c.value, ...projectParam } : null;
}

/** The draft in words, for the change log's words used. */
export function webAccessDisplay(raw: string): string {
  return webAccessWords(cleanDraft(raw).value);
}

export const WEB_ACCESS_MODES = [
  { value: "any", label: "Any public website" },
  { value: "only", label: "Only these websites" },
] as const;

export function WebAccessInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const c = cleanDraft(value);
  const set = (patch: Partial<Draft>) => onChange(JSON.stringify({ ...c.draft, ...patch }));
  return (
    <div className="space-y-2" data-testid="web-access-input">
      <Field label="Web pages research may read">
        <select
          className={INPUT_CLASS}
          value={c.draft.mode}
          onChange={(e) => set({ mode: e.target.value === "only" ? "only" : "any" })}
          data-testid="web-access-mode"
        >
          {WEB_ACCESS_MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </Field>
      {c.draft.mode === "only" ? (
        <Field
          label="Only these websites (one per line)"
          hint="Each covers the site and its subdomains: example.com also reads docs.example.com."
        >
          <textarea
            className={`${INPUT_CLASS} min-h-16`}
            value={c.draft.only}
            onChange={(e) => set({ only: e.target.value })}
            data-testid="web-access-only"
          />
        </Field>
      ) : null}
      <Field
        label="Never these websites (one per line, optional)"
        hint="Each covers the site and its subdomains."
      >
        <textarea
          className={`${INPUT_CLASS} min-h-16`}
          value={c.draft.never}
          onChange={(e) => set({ never: e.target.value })}
          data-testid="web-access-never"
        />
      </Field>
      <div className="text-xs" data-testid="web-access-preview">
        <p>
          Saved as: <span data-testid="web-access-saved-as">{webAccessWords(c.value)}</span>
        </p>
        {c.changed.length ? (
          <ul data-testid="web-access-changed">
            {c.changed.map((x) => (
              <li key={x.entry}>
                {x.entry} becomes {x.site}
              </li>
            ))}
          </ul>
        ) : null}
        {c.refused.length ? (
          <ul className="text-red-700 dark:text-red-300" data-testid="web-access-refused">
            {c.refused.map((x) => (
              <li key={x.entry}>
                Not taken: {x.entry} is {x.why}.
              </li>
            ))}
          </ul>
        ) : null}
        {c.empty ? (
          <p className="text-red-700 dark:text-red-300" data-testid="web-access-empty">
            Name at least one website, or research would be stuck.
          </p>
        ) : null}
        <p className="text-neutral-500">
          Research never reads this computer or your home or office network, whatever the lists say.
        </p>
      </div>
    </div>
  );
}
