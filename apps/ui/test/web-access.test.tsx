import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createHarness, postedCalls, renderApp } from "./helpers.tsx";

/**
 * "Web pages research may read" ('sites', the owner's decision of 2026-11-02): a row in Settings
 * (Per project) and one line on the project's Overview, "Research reads: any public website ·
 * Change". What the person types is cleaned and shown back before saving, an entry that cannot be
 * taken is named with its reason (never dropped), narrowing acts at once and widening asks a yes.
 */
const atlasRow = async () => {
  const rows = await screen.findAllByTestId("setting-row");
  const row = rows.find(
    (r) =>
      r.dataset.key === "project.web_access" &&
      within(r).getByTestId("setting-scope").textContent?.includes("Atlas"),
  );
  if (!row) throw new Error("no web_access row for Atlas");
  return row as HTMLElement;
};

describe("Settings: Web pages research may read ('sites')", () => {
  it("the row says any public website; 'only these websites' is cleaned and shown back, a refused entry is named, and narrowing acts at once", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/settings", harness);
    const row = await atlasRow();
    expect(within(row).getByTestId("setting-label")).toHaveTextContent(
      "Web pages research may read",
    );
    // P7-31: the rule in words, lower case, as it reads inside a sentence.
    expect(within(row).getByTestId("setting-value-cell")).toHaveTextContent("any public website");
    // One sentence on the agent browser's own list, which changes nothing here.
    expect(row).toHaveTextContent(
      "The agent browser's own site list is separate and changes nothing here",
    );
    await user.click(within(row).getByTestId("setting-change"));
    const dialog = await screen.findByTestId("setting-dialog");
    await user.selectOptions(within(dialog).getByTestId("web-access-mode"), "only");
    // Nothing on the list yet: research would be stuck, so it cannot be saved.
    expect(within(dialog).getByTestId("web-access-empty")).toHaveTextContent(
      "Name at least one website",
    );
    expect(within(dialog).getByTestId("setting-apply")).toBeDisabled();
    await user.type(
      within(dialog).getByTestId("web-access-only"),
      "https://developer.mozilla.org/en-US/docs/Web{enter}192.168.1.1{enter}github.io",
    );
    // Shown back before saving: the cleaned site, and each entry refused with its reason.
    expect(within(dialog).getByTestId("web-access-changed")).toHaveTextContent(
      "https://developer.mozilla.org/en-US/docs/Web becomes developer.mozilla.org",
    );
    const refused = within(dialog).getByTestId("web-access-refused");
    expect(refused).toHaveTextContent(
      "Not taken: 192.168.1.1 is an IP address: name the website instead.",
    );
    expect(refused).toHaveTextContent(
      "Not taken: github.io is too broad: anyone can have a site under it; name the site itself.",
    );
    expect(within(dialog).getByTestId("setting-apply")).toBeDisabled();
    // Take the two refused entries out.
    const only = within(dialog).getByTestId("web-access-only");
    await user.clear(only);
    await user.type(only, "https://developer.mozilla.org/en-US/docs/Web");
    expect(within(dialog).getByTestId("web-access-saved-as")).toHaveTextContent(
      "only developer.mozilla.org",
    );
    await user.click(within(dialog).getByTestId("setting-apply"));
    await waitFor(() => expect(postedCalls(harness, "/commands/execute")).toHaveLength(1));
    expect(postedCalls(harness, "/commands/execute")[0]?.body).toEqual({
      commands: [
        {
          name: "settings.set",
          params: {
            key: "web_access",
            value: { mode: "only", only: ["developer.mozilla.org"], never: [] },
            project: "proj_atlas",
          },
        },
      ],
      wordsUsed: "Settings: Web pages research may read to only developer.mozilla.org",
      source: "ui",
      projectId: "proj_atlas",
    });
    // Narrowing what research reads acts at once: no yes asked.
    await within(dialog).findByTestId("command-done");
    expect(harness.daemon.state.settingValues["web_access:proj_atlas"]).toEqual({
      mode: "only",
      only: ["developer.mozilla.org"],
      never: [],
    });
    await user.click(within(dialog).getByTestId("command-close"));
    await waitFor(async () =>
      expect(within(await atlasRow()).getByTestId("setting-value-cell")).toHaveTextContent(
        "only developer.mozilla.org",
      ),
    );
  });

  it("widening (back to any public website) asks a yes first", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    harness.daemon.state.settingValues["web_access:proj_atlas"] = {
      mode: "only",
      only: ["developer.mozilla.org"],
      never: [],
    };
    renderApp("/settings", harness);
    const row = await atlasRow();
    await user.click(within(row).getByTestId("setting-change"));
    const dialog = await screen.findByTestId("setting-dialog");
    await user.selectOptions(within(dialog).getByTestId("web-access-mode"), "any");
    await user.click(within(dialog).getByTestId("setting-apply"));
    const pending = await within(dialog).findByTestId("command-pending");
    expect(pending).toHaveAttribute("data-decision", "needs_yes");
    // P7-10: what it changes is the read-back's second sentence.
    expect(pending).toHaveTextContent("Research reads any public website except the ones listed");
    await user.click(within(pending).getByTestId("command-yes"));
    await within(dialog).findByTestId("command-done");
    expect(harness.daemon.state.settingValues["web_access:proj_atlas"]).toEqual({
      mode: "any",
      only: [],
      never: [],
    });
  });
});

describe("the Overview says what research reads ('sites')", () => {
  it("Research reads: any public website · Change, and Change opens the same dialog; the line follows the change", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/projects/proj_atlas/summary", harness);
    const line = await screen.findByTestId("research-reads");
    expect(within(line).getByTestId("research-reads-line")).toHaveTextContent(
      "Research reads: any public website",
    );
    expect(line).toHaveTextContent("Research reads: any public website · Change");
    await user.click(within(line).getByTestId("research-reads-change"));
    const dialog = await screen.findByTestId("setting-dialog");
    expect(dialog).toHaveTextContent("Change web pages research may read for Atlas");
    await user.type(within(dialog).getByTestId("web-access-never"), "www.facebook.com");
    expect(within(dialog).getByTestId("web-access-changed")).toHaveTextContent(
      "www.facebook.com becomes facebook.com",
    );
    await user.click(within(dialog).getByTestId("setting-apply"));
    await within(dialog).findByTestId("command-done");
    await user.click(within(dialog).getByTestId("command-close"));
    await waitFor(() =>
      expect(screen.getByTestId("research-reads-line")).toHaveTextContent(
        "Research reads: any public website, never facebook.com",
      ),
    );
  });
});
