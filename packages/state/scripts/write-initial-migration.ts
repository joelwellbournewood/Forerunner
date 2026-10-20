/**
 * Snapshot migration v1 from the schema into src/migrations/0001-initial.ts.
 * Run once when creating the baseline (`pnpm --filter @forerunner/state exec tsx
 * scripts/write-initial-migration.ts`). After v1 has shipped, never re-run it: add a new
 * migration file instead (docs/maintainers/migrations.md).
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, normalizeNewlines } from "@forerunner/platform";
import { generateInitialMigration, renderMigrationModule } from "../src/migrations/generate.ts";

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, "..", "src", "migrations", "0001-initial.ts");
const source = renderMigrationModule({
  version: 1,
  name: "initial",
  up: generateInitialMigration(),
});
writeFileSync(target, normalizeNewlines(source), "utf8");
console.log(`wrote ${target}`);
