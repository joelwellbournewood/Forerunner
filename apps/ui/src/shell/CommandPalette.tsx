import { useEffect, useMemo, useRef, useState } from "react";
import { INPUT_CLASS } from "../components/ui.tsx";
import { type Command, filterCommands } from "./commands.ts";

/** Ctrl/Cmd+K palette: type to filter, arrows to move, Enter to run, Escape to close. */
export function CommandPalette({
  open,
  commands,
  onClose,
}: {
  open: boolean;
  commands: Command[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const filtered = useMemo(() => filterCommands(commands, query), [commands, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setIndex(0);
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [open]);

  useEffect(() => {
    if (index >= filtered.length) setIndex(0);
  }, [filtered.length, index]);

  if (!open) return null;

  const run = (command: Command | undefined) => {
    if (!command) return;
    onClose();
    command.run();
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop closes the palette
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/40 p-4 pt-[10vh]"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      data-testid="command-palette"
    >
      <div
        role="dialog"
        aria-label="Command palette"
        className="w-full max-w-lg rounded-lg border border-neutral-200 bg-white shadow-xl dark:border-neutral-700 dark:bg-neutral-900"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={() => {}}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => Math.min(filtered.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              run(filtered[index]);
            }
          }}
          placeholder="Type a command or a project name…"
          aria-label="Command"
          className={`${INPUT_CLASS} rounded-b-none border-0 border-b px-3 py-2`}
          data-testid="command-input"
        />
        <ul className="max-h-80 overflow-auto py-1" aria-label="Commands">
          {filtered.length === 0 ? (
            <li className="px-3 py-2 text-sm text-neutral-500">No matching command.</li>
          ) : null}
          {filtered.map((c, i) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => run(c)}
                onMouseEnter={() => setIndex(i)}
                className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-sm ${
                  i === index ? "bg-blue-50 dark:bg-blue-950" : ""
                }`}
                data-testid="command-item"
                aria-current={i === index ? "true" : undefined}
              >
                <span>
                  <span className="mr-2 text-xs uppercase text-neutral-400">{c.group}</span>
                  {c.title}
                </span>
                {c.hint ? <span className="text-xs text-neutral-500">{c.hint}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
