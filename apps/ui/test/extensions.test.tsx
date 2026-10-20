import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { summarizePermissions } from "../src/pages/ExtensionsPage.tsx";
import { EXTENSIONS } from "./fixtures.ts";
import { createHarness, postedCalls, renderApp } from "./helpers.tsx";

describe("Extensions panel", () => {
  it("summarises permissions by count", () => {
    const github = EXTENSIONS[0];
    if (!github) throw new Error("fixture");
    expect(summarizePermissions(github.permissions)).toBe(
      "2 tools · 2 action classes · 1 domains · 1 secrets · 2 scopes",
    );
    expect(
      summarizePermissions({
        tools: [],
        actionClasses: [],
        domains: [],
        paths: [],
        secrets: [],
        scopes: [],
      }),
    ).toBe("no permissions");
  });

  it("lists every kind with status, version, cost and permissions, pending first for approval", async () => {
    renderApp("/extensions");
    const rows = await screen.findAllByTestId("extension");
    expect(rows).toHaveLength(5);
    const github = rows.find((r) => r.dataset.extensionId === "ext_github");
    if (!github) throw new Error("no github row");
    expect(github).toHaveAttribute("data-kind", "connector");
    expect(within(github).getByTestId("extension-status")).toHaveTextContent("enabled");
    expect(github).toHaveTextContent("v1.4.0");
    expect(github).toHaveTextContent("CHF 1.00");
    expect(within(github).getByTestId("extension-permissions")).toHaveTextContent("2 tools");
    expect(within(github).getByTestId("extension-toggle")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("extensions-group-model_provider")).toHaveTextContent("Anthropic");
    expect(screen.getByTestId("extensions-group-specialist")).toHaveTextContent("researcher");
    expect(screen.getByTestId("extensions-pending")).toHaveTextContent(
      "1 waiting for your approval",
    );
    const slack = rows.find((r) => r.dataset.extensionId === "ext_slack");
    if (!slack) throw new Error("no slack row");
    expect(within(slack).getByTestId("extension-review")).toHaveTextContent("high risk");
    expect(within(slack).getByTestId("extension-review")).toHaveTextContent(
      "needs secret:slack_token",
    );
    expect(within(slack).getByTestId("extension-approve")).toBeInTheDocument();
  });

  it("toggles an extension and removes one after a confirmation", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/extensions", harness);
    const rows = await screen.findAllByTestId("extension");
    const github = rows.find((r) => r.dataset.extensionId === "ext_github");
    if (!github) throw new Error("no github row");
    await user.click(within(github).getByTestId("extension-toggle"));
    await waitFor(() =>
      expect(within(github).getByTestId("extension-toggle")).toHaveAttribute(
        "aria-checked",
        "false",
      ),
    );
    expect(postedCalls(harness, "/extensions/ext_github/toggle")[0]?.body).toEqual({
      enabled: false,
    });
    expect(within(github).getByTestId("extension-status")).toHaveTextContent("disabled");

    const browser = rows.find((r) => r.dataset.extensionId === "ext_browser");
    if (!browser) throw new Error("no browser row");
    await user.click(within(browser).getByTestId("extension-remove"));
    await user.click(within(browser).getByTestId("extension-remove-confirm"));
    await waitFor(() => expect(screen.getAllByTestId("extension")).toHaveLength(4));
    expect(postedCalls(harness, "/extensions/ext_browser")[0]?.method).toBe("DELETE");
  });

  it("adds a connector from the catalog, which waits for approval, then approves it", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/extensions", harness);
    await screen.findAllByTestId("extension");
    await user.click(screen.getByTestId("add-extension"));
    const dialog = await screen.findByTestId("add-extension-dialog");
    await waitFor(() => expect(within(dialog).getAllByTestId("catalog-entry").length).toBe(4));
    await user.type(within(dialog).getByTestId("catalog-search"), "linear");
    await waitFor(() => expect(within(dialog).getAllByTestId("catalog-entry")).toHaveLength(1));
    await user.click(within(dialog).getByTestId("catalog-add"));
    await waitFor(() => expect(postedCalls(harness, "/extensions")).toHaveLength(1));
    expect(postedCalls(harness, "/extensions")[0]?.body).toEqual({ catalogId: "linear" });
    expect(await screen.findByTestId("extensions-notice")).toHaveTextContent(
      "waits for your approval",
    );
    const linear = (await screen.findAllByTestId("extension")).find((r) =>
      r.textContent?.includes("Linear"),
    );
    if (!linear) throw new Error("no linear row");
    expect(linear).toHaveAttribute("data-status", "pending_approval");
    // The grant request also reached the inbox (spec L.5).
    expect(harness.daemon.state.requests.some((r) => r.kind === "capability_grant")).toBe(true);
    await user.click(within(linear).getByTestId("extension-approve"));
    await waitFor(() => expect(linear).toHaveAttribute("data-status", "enabled"));
    expect(within(linear).getByTestId("extension-toggle")).toHaveAttribute("aria-checked", "true");
  });

  it("adds an MCP server from a URL and denies it", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/extensions", harness);
    await screen.findAllByTestId("extension");
    await user.click(screen.getByTestId("add-extension"));
    const dialog = await screen.findByTestId("add-extension-dialog");
    await user.type(within(dialog).getByTestId("add-url"), "https://mcp.example.test/tools");
    await user.click(within(dialog).getByTestId("add-url-submit"));
    await waitFor(() => expect(postedCalls(harness, "/extensions")).toHaveLength(1));
    expect(postedCalls(harness, "/extensions")[0]?.body).toEqual({
      url: "https://mcp.example.test/tools",
    });
    const row = (await screen.findAllByTestId("extension")).find((r) =>
      r.textContent?.includes("mcp.example.test"),
    );
    if (!row) throw new Error("no url row");
    expect(row).toHaveAttribute("data-status", "pending_approval");
    await user.click(within(row).getByTestId("extension-deny"));
    await waitFor(() =>
      expect(
        screen.getAllByTestId("extension").some((r) => r.textContent?.includes("mcp.example.test")),
      ).toBe(false),
    );
  });

  it("reloads when the daemon reports an extension change", async () => {
    const harness = createHarness();
    renderApp("/extensions", harness);
    await screen.findAllByTestId("extension");
    harness.daemon.state.extensions = harness.daemon.state.extensions.filter(
      (e) => e.id !== "ext_slack",
    );
    harness.store.dispatch({ type: "extension.changed" });
    await waitFor(() => expect(screen.getAllByTestId("extension")).toHaveLength(4));
  });
});
