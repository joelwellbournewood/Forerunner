import { expect, type Page, test } from "@playwright/test";
import { daemonUrl, resetDaemon } from "./helpers.ts";

test.beforeEach(async ({ request }) => resetDaemon(request));

/**
 * P7-12 (polish-screens): the Overview's "Change" opens /settings#other-settings. The sections
 * above Other settings (models, the subscription allowance, the credential order, devices,
 * sources, voice) load on their own, after the rows the page waits for, and each one pushes the
 * section down. Before, the page scrolled once, smoothly, when the rows came, and ended with
 * "Other settings" below the fold or halfway down. Measured in a real browser: where the
 * section's top is against the top of the scrolling area once everything has loaded.
 */

/** Hold back the answers of the daemon's routes `paths` until `gate` resolves. */
async function holdBack(page: Page, paths: string[], gate: Promise<void>): Promise<void> {
  const daemon = new URL(daemonUrl());
  await page.route(
    (url) => url.host === daemon.host && paths.includes(url.pathname),
    async (route) => {
      await gate;
      await route.continue();
    },
  );
}

/** How far the section's top is below the top of the page's scrolling area, in px. */
const offset = (page: Page) =>
  page.evaluate(() => {
    const target = document.getElementById("other-settings");
    const main = document.querySelector("main");
    if (!target || !main) return Number.NaN;
    return Math.round(target.getBoundingClientRect().top - main.getBoundingClientRect().top);
  });

test("a link to Other settings lands on it after the sections above it load, and stops once the person scrolls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  let releaseAbove: () => void = () => {};
  let releaseVoice: () => void = () => {};
  await holdBack(
    page,
    [
      "/settings/models",
      "/settings/plan-allowance",
      "/settings/billing-order",
      "/devices",
      "/sources",
    ],
    new Promise<void>((r) => {
      releaseAbove = r;
    }),
  );
  await holdBack(
    page,
    ["/voice/status"],
    new Promise<void>((r) => {
      releaseVoice = r;
    }),
  );

  await page.goto("/settings#other-settings");
  // The rows the page waits for are there: it lands a first time.
  await expect(page.getByTestId("setting-row").first()).toBeVisible();
  await expect(page.locator("#other-settings")).toHaveAttribute("data-targeted", "true");
  // Then the sections above load and grow.
  releaseAbove();
  await expect(page.getByTestId("plan-allowance-input")).toBeVisible();
  await expect(page.getByTestId("billing-order-section")).toBeVisible();
  await expect(page.getByTestId("model-settings-row").first()).toBeVisible();
  // "Other settings" is at the top of the view all the same (before: 400 to 1900 px down).
  await expect
    .poll(() => offset(page), {
      message: "the top of 'Other settings' against the top of the page's scrolling area",
      timeout: 10_000,
    })
    .toBeLessThanOrEqual(2);
  expect(await offset(page)).toBeGreaterThanOrEqual(-2);

  // The person scrolls up themselves: what loads afterwards no longer moves the page back.
  await page.locator("main").hover();
  await page.mouse.wheel(0, -600);
  await expect
    .poll(() => offset(page), { message: "the person's own scroll took effect", timeout: 10_000 })
    .toBeGreaterThan(300);
  releaseVoice();
  await expect(page.getByTestId("voice-providers")).toBeVisible();
  // Give a re-landing every chance to happen, then check it did not.
  await page.waitForTimeout(500);
  expect(await offset(page)).toBeGreaterThan(300);
});
