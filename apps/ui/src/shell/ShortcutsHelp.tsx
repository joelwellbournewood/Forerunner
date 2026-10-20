import { Dialog } from "../components/Dialog.tsx";
import { KeyCap } from "../components/ui.tsx";
import { formatKeys, SHORTCUTS } from "./shortcuts.ts";

export function ShortcutsHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts" testId="shortcuts-help">
      <table className="w-full text-sm">
        <tbody>
          {SHORTCUTS.map((s) => (
            <tr key={s.id} className="border-t border-neutral-100 dark:border-neutral-800">
              <td className="py-1.5 pr-4">
                {formatKeys(s.keys).map((k, i) => (
                  <span key={`${s.id}-${k}`}>
                    {i > 0 ? <span className="mx-1 text-neutral-400">then</span> : null}
                    <KeyCap>{k}</KeyCap>
                  </span>
                ))}
              </td>
              <td className="py-1.5">{s.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Dialog>
  );
}
