import { type FormEvent, useState } from "react";
import { describeError } from "../../api/client.ts";
import { IMPORT_SOURCES, type ImportResultView } from "../../api/contracts.ts";
import { RouteMissing } from "../../components/RouteMissing.tsx";
import { Badge, Button, ErrorBanner, Field, INPUT_CLASS, Loading } from "../../components/ui.tsx";
import { formatBytes } from "../../lib/format.ts";
import { formatDateTime } from "../../lib/time.ts";
import { useAsync } from "../../lib/use-async.ts";
import { useClient } from "../../store/context.tsx";

const DATA_KINDS = ["folder", "csv", "parquet", "sqlite", "zip", "dataset", "other"] as const;

/**
 * Data tab (spec L.1, A.3): datasets registered by path or URI (agents see metadata and a
 * sample, never the whole file; large data stays where it is), plus imports from a ZIP, a
 * folder or a repository that run on a branch with the original untouched.
 */
export function DataTab({ projectId }: { projectId: string }) {
  const client = useClient();
  const assets = useAsync((signal) => client.dataAssets(projectId, signal), [client, projectId]);
  const [locator, setLocator] = useState("");
  const [kind, setKind] = useState<string>("folder");
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [importSource, setImportSource] = useState<(typeof IMPORT_SOURCES)[number]>("repo");
  const [importLocator, setImportLocator] = useState("");
  const [importResult, setImportResult] = useState<ImportResultView | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  if (assets.routeMissing) return <RouteMissing route="dataAssets" what="registered data" />;

  const register = async (e: FormEvent) => {
    e.preventDefault();
    if (!locator.trim() || busy) return;
    setBusy(true);
    setRegisterError(null);
    try {
      const created = await client.registerDataAsset(projectId, { locator: locator.trim(), kind });
      assets.setData((prev) => [created, ...(prev ?? [])]);
      setLocator("");
    } catch (error) {
      setRegisterError(describeError(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await client.removeDataAsset(id);
      assets.setData((prev) => (prev ?? []).filter((a) => a.id !== id));
      setConfirmRemove(null);
    } catch (error) {
      setRegisterError(describeError(error));
    } finally {
      setBusy(false);
    }
  };

  const runImport = async (e: FormEvent) => {
    e.preventDefault();
    if (!importLocator.trim() || busy) return;
    setBusy(true);
    setImportError(null);
    setImportResult(null);
    try {
      const result = await client.importProject(projectId, {
        source: importSource,
        locator: importLocator.trim(),
      });
      setImportResult(result);
      setImportLocator("");
    } catch (error) {
      setImportError(describeError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5" data-testid="data">
      <section>
        <h2 className="font-semibold">Registered data</h2>
        <p className="text-xs text-neutral-500">
          Agents see the metadata and a sample, never the whole file. Large data never goes into
          git; it stays at its path or URI.
        </p>
        {assets.loading && !assets.data ? <Loading what="data assets" /> : null}
        {assets.error && !assets.data ? (
          <ErrorBanner message={assets.error} onRetry={assets.reload} />
        ) : null}
        {assets.data && assets.data.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500" data-testid="data-empty">
            Nothing registered yet.
          </p>
        ) : null}
        {assets.data && assets.data.length > 0 ? (
          <table className="mt-2 w-full text-sm">
            <thead className="text-left text-xs text-neutral-500">
              <tr>
                <th className="py-1 pr-2">Name</th>
                <th className="py-1 pr-2">Kind</th>
                <th className="py-1 pr-2">Size</th>
                <th className="py-1 pr-2">Locator</th>
                <th className="py-1 pr-2">Registered</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody>
              {assets.data.map((a) => (
                <tr
                  key={a.id}
                  className="border-t border-neutral-100 align-top dark:border-neutral-800"
                  data-testid="data-row"
                  data-asset-id={a.id}
                >
                  <td className="py-1 pr-2 font-medium">{a.name}</td>
                  <td className="py-1 pr-2">
                    <Badge>{a.kind}</Badge>
                  </td>
                  <td className="py-1 pr-2">{a.sizeBytes > 0 ? formatBytes(a.sizeBytes) : "—"}</td>
                  <td className="py-1 pr-2">
                    <code className="text-xs break-all">{a.locator}</code>
                    {a.sample !== null && a.sample !== undefined ? (
                      <details className="mt-1 text-xs">
                        <summary className="cursor-pointer text-neutral-500">Sample</summary>
                        <pre className="overflow-auto rounded bg-neutral-100 p-2 dark:bg-neutral-900">
                          {JSON.stringify(a.sample, null, 2)}
                        </pre>
                      </details>
                    ) : null}
                  </td>
                  <td className="py-1 pr-2 text-xs text-neutral-500">
                    {a.registeredBy} · {formatDateTime(a.createdAt)}
                  </td>
                  <td className="py-1 text-right">
                    {confirmRemove === a.id ? (
                      <span className="inline-flex gap-1">
                        <Button
                          variant="danger"
                          onClick={() => void remove(a.id)}
                          disabled={busy}
                          data-testid="data-remove-confirm"
                        >
                          Confirm remove
                        </Button>
                        <Button variant="ghost" onClick={() => setConfirmRemove(null)}>
                          Keep
                        </Button>
                      </span>
                    ) : (
                      <Button
                        variant="ghost"
                        onClick={() => setConfirmRemove(a.id)}
                        data-testid="data-remove"
                        title="Unregisters the asset; the data itself is not touched"
                      >
                        Remove
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        <form
          onSubmit={(e) => void register(e)}
          className="mt-3 grid gap-2 md:grid-cols-[1fr_auto_auto]"
        >
          <Field label="Path or URI">
            <input
              className={INPUT_CLASS}
              value={locator}
              onChange={(e) => setLocator(e.target.value)}
              placeholder="s3://bucket/file.parquet or C:\data\exports"
              data-testid="data-locator"
            />
          </Field>
          <Field label="Kind">
            <select
              className={INPUT_CLASS}
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              data-testid="data-kind"
            >
              {DATA_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </Field>
          <div className="flex items-end">
            <Button
              type="submit"
              variant="primary"
              disabled={busy || !locator.trim()}
              data-testid="data-register"
            >
              Register
            </Button>
          </div>
        </form>
        {registerError ? <ErrorBanner message={registerError} /> : null}
      </section>

      <section>
        <h2 className="font-semibold">Import</h2>
        <p className="text-xs text-neutral-500">
          From a ZIP, a local folder or an existing repository. The original is preserved untouched;
          the migration runs on a branch.
        </p>
        <form
          onSubmit={(e) => void runImport(e)}
          className="mt-2 grid gap-2 md:grid-cols-[auto_1fr_auto]"
        >
          <Field label="Source">
            <select
              className={INPUT_CLASS}
              value={importSource}
              onChange={(e) => setImportSource(e.target.value as (typeof IMPORT_SOURCES)[number])}
              data-testid="import-source"
            >
              {IMPORT_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Location">
            <input
              className={INPUT_CLASS}
              value={importLocator}
              onChange={(e) => setImportLocator(e.target.value)}
              placeholder="https://example.test/org/repo or /path/to/folder"
              data-testid="import-locator"
            />
          </Field>
          <div className="flex items-end">
            <Button type="submit" disabled={busy || !importLocator.trim()} data-testid="import-run">
              Import
            </Button>
          </div>
        </form>
        {importError ? <ErrorBanner message={importError} /> : null}
        {importResult ? (
          <output
            className="mt-2 block rounded border border-emerald-200 p-2 text-sm dark:border-emerald-900"
            data-testid="import-result"
            data-status={importResult.status}
          >
            {importResult.message}
            {importResult.taskId ? (
              <span className="ml-1 text-xs text-neutral-500">(task {importResult.taskId})</span>
            ) : null}
          </output>
        ) : null}
      </section>
    </div>
  );
}
