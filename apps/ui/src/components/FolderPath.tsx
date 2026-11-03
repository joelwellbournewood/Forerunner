import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { inTauriShell } from "../shell/hotkey.ts";
import { Button } from "./ui.tsx";

/** What Open folder does, said with the button (design §3.4). */
export const OPEN_FOLDER_EXPLAIN = "Opens the project's folder.";

/**
 * Open the folder in the system's file manager: the desktop shell's `open_folder` command
 * (apps/desktop/src-tauri/src/folder.rs), which opens only an existing folder. Null when this
 * page is not in the desktop shell (a browser shows the path to copy instead).
 */
export function folderOpener(): ((path: string) => Promise<void>) | null {
  if (!inTauriShell()) return null;
  return async (path) => {
    await invoke("open_folder", { path });
  };
}

/**
 * The project's folder (design §3.4 "Your files", §3.10): the path, **Open folder** in the
 * desktop app, and **Copy path** everywhere (a browser cannot open a folder).
 */
export function FolderPath({
  path,
  open = folderOpener(),
  testId = "folder",
  explain = OPEN_FOLDER_EXPLAIN,
}: {
  path: string;
  open?: ((path: string) => Promise<void>) | null;
  testId?: string;
  /** Open folder's one line (the Local only row opens that folder, not the project's). */
  explain?: string;
}) {
  const [note, setNote] = useState<string | null>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(path);
      setNote("Copied.");
    } catch {
      setNote("Select the path and copy it.");
    }
  };
  return (
    <span className="flex flex-wrap items-center gap-2" data-testid={testId}>
      <code
        className="select-all break-all rounded bg-neutral-100 px-1.5 py-0.5 text-xs dark:bg-neutral-800"
        data-testid={`${testId}-path`}
      >
        {path}
      </code>
      {open ? (
        <Button
          onClick={() =>
            void open(path).catch((e: unknown) =>
              setNote(`The folder did not open: ${e instanceof Error ? e.message : String(e)}`),
            )
          }
          title={explain}
          data-testid={`${testId}-open`}
        >
          Open folder
        </Button>
      ) : null}
      <Button variant="ghost" onClick={() => void copy()} data-testid={`${testId}-copy`}>
        Copy path
      </Button>
      {note ? (
        <output className="text-xs text-neutral-500" data-testid={`${testId}-note`}>
          {note}
        </output>
      ) : null}
    </span>
  );
}
