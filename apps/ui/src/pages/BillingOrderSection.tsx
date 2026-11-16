import { useAsync } from "../lib/use-async.ts";
import { useClient } from "../store/context.tsx";

/**
 * d1109-cred-screens (CS-2, ADR 0120 amended 2026-11-16): Settings -> Advanced keeps only "What
 * each can do here"; the choice of which Claude does the work is one section under Basics
 * (`CredentialPolicySection.tsx`), so the order list with Move up / Move down and its row words
 * ("Resting until ...; your session that waits for it goes on then", C3-left-9) are gone: one
 * place for one fact (design section 5 rule 10).
 */

/**
 * "What each can do here" (U-078, the credential chooser): the daemon's table from the capability
 * function (`GET /settings/models` `credentials`), one row per need and one column per
 * credential, so a choice that moves work onto the other one is never a surprise. An older daemon
 * without it shows nothing.
 */
export function AbilityTable() {
  const client = useClient();
  const models = useAsync((signal) => client.modelSettings(signal), [client]);
  const table = models.data?.credentials ?? null;
  if (!table) return null;
  return (
    <div data-testid="credential-table">
      <h3 className="text-sm font-medium">What each can do here</h3>
      <table className="mt-1 w-full text-left text-sm">
        <thead>
          <tr>
            <th className="py-1 pr-2 font-normal text-neutral-600 dark:text-neutral-400">
              <span className="sr-only">What</span>
            </th>
            {table.columns.map((c) => (
              <th key={c.kind} className="py-1 pr-2" data-testid={`credential-table-${c.kind}`}>
                {c.name}
                {c.saved ? "" : " (not saved)"}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((r) => (
            <tr
              key={r.need}
              className="border-t border-neutral-200 dark:border-neutral-800"
              data-testid="credential-table-row"
            >
              <th scope="row" className="py-1 pr-2 font-normal">
                {r.label}
              </th>
              {r.cells.map((cell, i) => (
                <td
                  key={table.columns[i]?.kind ?? i}
                  className={`py-1 pr-2 ${cell.can ? "" : "text-amber-800 dark:text-amber-200"}`}
                >
                  {cell.words}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
