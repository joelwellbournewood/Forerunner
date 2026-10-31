import { AGENT_NAME_MAX } from "@forerunner/runtime/daemon/api-types";
import { type FormEvent, useState } from "react";
import { describeError, isRouteMissing } from "../api/client.ts";
import { RouteMissing } from "../components/RouteMissing.tsx";
import { Button, ErrorBanner, Field, INPUT_CLASS } from "../components/ui.tsx";
import { refreshIdentity, useClient, useUiState, useUiStore } from "../store/context.tsx";
import { ownPrincipal } from "../store/store.ts";

/**
 * Settings -> Your agent (U-025): the name of the signed-in human's principal agent, created as
 * "Alice" on the first start. Save posts `POST /agents/:id/rename`; the daemon trims and checks
 * the name (its refusal shows here as it says it), then `/me` and `/agents` are read again so
 * every place that names the agent shows the new name.
 */
export function AgentNameSection() {
  const client = useClient();
  const store = useUiStore();
  const agent = useUiState(ownPrincipal);
  // What the field holds while it is being edited; null shows the agent's current name.
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const value = draft ?? agent?.name ?? "";
  const unchanged = value.trim() === "" || value.trim() === agent?.name;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!agent || busy || unchanged) return;
    setBusy(true);
    setError(null);
    setMissing(false);
    setSaved(null);
    try {
      const renamed = await client.renameAgent(agent.id, value);
      setSaved(`Saved. Your agent is now called ${renamed.name}.`);
      try {
        await refreshIdentity(client, store);
        setDraft(null);
      } catch (err) {
        // Saved on the daemon; the next agent.changed frame or a reload brings it everywhere.
        setDraft(renamed.name);
        setError(`Saved, but the app could not reload your agent: ${describeError(err)}`);
      }
    } catch (err) {
      setMissing(isRouteMissing(err));
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="rounded border border-neutral-200 p-3 dark:border-neutral-800"
      data-testid="agent-name-section"
    >
      <h2 className="font-semibold">Your agent</h2>
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        The name your agent goes by in the app, in notifications, in its commits and email
        signature. Your projects, sessions and memory stay with it.
      </p>
      {agent ? (
        <form onSubmit={(e) => void save(e)} className="mt-2 space-y-2">
          <Field label="Name" hint={`1 to ${AGENT_NAME_MAX} characters, one line.`}>
            <input
              className={INPUT_CLASS}
              value={value}
              maxLength={AGENT_NAME_MAX}
              onChange={(e) => {
                setDraft(e.target.value);
                setSaved(null);
              }}
              data-testid="agent-name-input"
            />
          </Field>
          {missing ? (
            <RouteMissing route="renameAgent" what="renaming your agent" />
          ) : error ? (
            <ErrorBanner message={error} testId="agent-name-error" />
          ) : null}
          {saved ? (
            <output className="block text-sm" data-testid="agent-name-saved">
              {saved}
            </output>
          ) : null}
          <Button
            type="submit"
            variant="primary"
            disabled={busy || unchanged}
            data-testid="agent-name-save"
          >
            {busy ? "Saving…" : "Save"}
          </Button>
        </form>
      ) : (
        <p className="mt-2 text-sm text-neutral-500" data-testid="agent-name-none">
          Your agent is not loaded yet.
        </p>
      )}
    </div>
  );
}
