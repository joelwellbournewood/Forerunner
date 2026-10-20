/**
 * Writes docs/maintainers/data-model.md from the schema. Run with `pnpm docs:schema`.
 * Output is deterministic (sorted, LF) so a second run changes nothing.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, normalizeNewlines } from "@forerunner/platform";
import { renderDataModelDoc } from "../src/docs.ts";

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, "..", "..", "..", "docs", "maintainers", "data-model.md");
const next = normalizeNewlines(renderDataModelDoc());
let previous: string | undefined;
try {
  previous = normalizeNewlines(readFileSync(target, "utf8"));
} catch {
  previous = undefined;
}
if (previous === next) {
  console.log(`unchanged ${target}`);
} else {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, next, "utf8");
  console.log(`wrote ${target}`);
}
