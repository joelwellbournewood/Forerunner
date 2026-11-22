// Local-only Playwright config: the repo's apps/ui/playwright.config.ts with the preinstalled
// Chromium (this machine's browsers match Playwright 1.63, the UI pins 1.64). Copy into apps/ui
// as playwright.local.config.ts (never commit it) and run:
//   cd apps/ui && npx playwright test --config playwright.local.config.ts
import base from "./playwright.config.ts";
export default {
  ...base,
  use: { ...base.use, launchOptions: { executablePath: "/opt/pw-browsers/chromium" } },
};
