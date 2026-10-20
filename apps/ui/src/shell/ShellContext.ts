import { createContext, useContext } from "react";

/** Actions pages can trigger on the shell (dialogs the shell owns). */
export interface ShellActions {
  openNewProject: () => void;
  openPalette: () => void;
  openShortcuts: () => void;
}

export const ShellContext = createContext<ShellActions>({
  openNewProject: () => {},
  openPalette: () => {},
  openShortcuts: () => {},
});

export function useShell(): ShellActions {
  return useContext(ShellContext);
}
