export interface Migration {
  /** Monotonic, contiguous from 1. */
  version: number;
  name: string;
  /** Statements per dialect, run in order inside one transaction. */
  up: { sqlite: string[]; postgres: string[] };
}
