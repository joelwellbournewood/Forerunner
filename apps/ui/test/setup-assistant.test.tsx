import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createHarness, postedCalls, renderApp } from "./helpers.tsx";

// The setup assistant (ADR 0092). 1.0.0 had none: a new user of the installer had to find a
// terminal and `fr setup` before the agent could do anything.

// Credential-shaped values built by concatenation so no scanner sees a token. // not-a-secret
const API_KEY = ["sk-ant-api03-", "ui", "2".repeat(40)].join(""); // not-a-secret
const BAD_KEY = ["sk-ant-api03-", "bad", "2".repeat(40)].join(""); // not-a-secret
const GH_TOKEN = ["github_pat_", "ui_", "1".repeat(40)].join(""); // not-a-secret

const FRESH = {
  setup: {
    complete: false,
    showAssistant: true,
    name: "Dada-",
    timezone: "UTC",
    credentials: { github: false, anthropicApiKey: false, subscription: false },
  },
};

describe("setup assistant", () => {
  it("a fresh install opens the assistant instead of the home page", async () => {
    renderApp("/", createHarness(FRESH));
    expect(await screen.findByTestId("setup-page")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Set up Forerunner" })).toBeInTheDocument();
    expect(screen.getByTestId("setup-name")).toHaveValue("Dada-");
  });

  it("says where keys are kept as the vault reports it, and leaves a name the daemon does not know empty (U-077)", async () => {
    const harness = createHarness({ setup: { ...FRESH.setup, name: "" } });
    renderApp("/", harness);
    const page = await screen.findByTestId("setup-page");
    // The fixture daemon's vault is the encrypted file: the page does not say "never in a file".
    await waitFor(() =>
      expect(page).toHaveTextContent("stored in an encrypted file on this computer"),
    );
    expect(page).not.toHaveTextContent("never in a file");
    expect(screen.getByTestId("setup-name")).toHaveValue("");
    expect(screen.getByTestId("setup-next")).toBeDisabled();
    const health = harness.store.getState().connection.health;
    if (!health) throw new Error("no health");
    harness.store.dispatch({
      type: "connection",
      patch: { health: { ...health, vaultBackend: "keyring" } },
    });
    await waitFor(() =>
      expect(page).toHaveTextContent(
        "stored in your computer's secure credential store, never in a file",
      ),
    );
  });

  it("a set-up install and a daemon without the routes stay where the app opened", async () => {
    renderApp("/settings");
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.queryByTestId("setup-page")).not.toBeInTheDocument();
    // Settings links to the assistant for later changes.
    expect(screen.getByRole("link", { name: "Open the setup assistant" })).toHaveAttribute(
      "href",
      "/setup",
    );
  });

  it("an older daemon without /setup leaves the app alone", async () => {
    renderApp("/settings", createHarness({ ...FRESH, missingRoutes: ["/setup"] }));
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("setup-page")).not.toBeInTheDocument();
  });

  it("walks through name, Claude key and GitHub token, checks each on paste and restarts once", async () => {
    const user = userEvent.setup();
    const harness = createHarness(FRESH);
    renderApp("/", harness);
    await screen.findByTestId("setup-page");

    await user.clear(screen.getByTestId("setup-name"));
    await user.type(screen.getByTestId("setup-name"), "Joel");
    await user.clear(screen.getByTestId("setup-timezone"));
    await user.type(screen.getByTestId("setup-timezone"), "Europe/Zurich");
    await user.click(screen.getByTestId("setup-next"));
    await screen.findByTestId("setup-anthropic-input");
    expect(postedCalls(harness, "/setup/profile").map((c) => c.body)).toEqual([
      { name: "Joel", timezone: "Europe/Zurich" },
    ]);
    // The link to the Claude Console leaves the app.
    expect(screen.getByTestId("setup-anthropic-link")).toHaveAttribute(
      "href",
      "https://console.anthropic.com/settings/keys",
    );

    // A wrong key is explained and nothing is marked saved.
    await user.click(screen.getByTestId("setup-anthropic-input"));
    await user.paste(BAD_KEY);
    expect(await screen.findByTestId("setup-check-result")).toHaveTextContent(/rejected/);
    expect(screen.queryByTestId("setup-saved")).not.toBeInTheDocument();
    // Pasting checks at once; the field is emptied and the key is not shown anywhere.
    await user.click(screen.getByTestId("setup-anthropic-input"));
    await user.paste(API_KEY);
    await waitFor(() =>
      expect(screen.getByTestId("setup-check-result")).toHaveTextContent("✓ Key works"),
    );
    expect(screen.getByTestId("setup-anthropic-input")).toHaveValue("");
    expect(document.body.textContent).not.toContain(API_KEY);
    expect(screen.getByTestId("setup-saved")).toHaveTextContent("An API key is saved.");
    expect(postedCalls(harness, "/setup/anthropic").map((c) => c.body)).toEqual([
      { value: BAD_KEY },
      { value: API_KEY },
    ]);

    await user.click(screen.getByTestId("setup-next"));
    await screen.findByTestId("setup-github-input");
    expect(screen.getByTestId("setup-github-link").getAttribute("href")).toContain(
      "github.com/settings/personal-access-tokens/new",
    );
    // An Anthropic key in the GitHub box says where it belongs.
    await user.click(screen.getByTestId("setup-github-input"));
    await user.paste(API_KEY);
    expect(await screen.findByRole("alert")).toHaveTextContent(/Anthropic credential/);
    await user.type(screen.getByTestId("setup-github-input"), GH_TOKEN);
    await user.click(screen.getByTestId("setup-github-check"));
    await waitFor(() =>
      expect(screen.getByTestId("setup-check-result")).toHaveTextContent("✓ Token works"),
    );

    await user.click(screen.getByTestId("setup-next"));
    expect(await screen.findByTestId("setup-done")).toHaveTextContent("Claude is connected");
    expect(screen.getByTestId("setup-done")).toHaveTextContent("GitHub is connected");
    await user.click(screen.getByTestId("setup-finish"));
    // The fake comes back at once, so the app lands on Home after the restart wait.
    await waitFor(() => expect(screen.queryByTestId("setup-page")).not.toBeInTheDocument(), {
      timeout: 5000,
    });
    expect(postedCalls(harness, "/setup/finish")).toHaveLength(1);
  });

  it("the restart after setup is announced as such, not as an update", async () => {
    const harness = createHarness();
    renderApp("/settings", harness);
    await screen.findByRole("heading", { name: "Settings" });
    harness.store.dispatch({
      type: "restart",
      restart: { reason: "setup", targetVersion: "1.0.1", fromVersion: "1.0.1", exitCode: 86 },
    });
    const banner = await screen.findByTestId("restart-banner");
    expect(banner).toHaveTextContent("to use your new keys");
    expect(banner).not.toHaveTextContent("1.0.1 → 1.0.1");
  });

  it("a first key saved and the assistant left through the sidebar still restarts the service once (U-049)", async () => {
    const user = userEvent.setup();
    const harness = createHarness(FRESH);
    renderApp("/", harness);
    await screen.findByTestId("setup-page");
    await user.click(screen.getByTestId("setup-next"));
    await screen.findByTestId("setup-anthropic-input");
    await user.click(screen.getByTestId("setup-anthropic-input"));
    await user.paste(API_KEY);
    expect(await screen.findByTestId("setup-in-use")).toHaveTextContent(
      "Forerunner restarts its background service once when you finish or leave this assistant",
    );
    // The person goes Home through the sidebar instead of finishing.
    await user.click(screen.getByRole("link", { name: "Home" }));
    await waitFor(() => expect(screen.queryByTestId("setup-page")).not.toBeInTheDocument());
    await waitFor(() => expect(postedCalls(harness, "/setup/finish")).toHaveLength(1));
  });

  it("a replaced key is in use at once: the assistant says so and nothing restarts (U-049)", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/setup", harness);
    await screen.findByTestId("setup-page");
    await user.click(screen.getByTestId("setup-next"));
    expect(await screen.findByTestId("setup-saved")).toHaveTextContent("An API key is saved.");
    await user.click(screen.getByTestId("setup-anthropic-input"));
    await user.paste(API_KEY);
    expect(await screen.findByTestId("setup-in-use")).toHaveTextContent(
      "In use from the next request. No restart needed.",
    );
    await user.click(screen.getByRole("link", { name: "Home" }));
    await waitFor(() => expect(screen.queryByTestId("setup-page")).not.toBeInTheDocument());
    await new Promise((r) => setTimeout(r, 50));
    expect(postedCalls(harness, "/setup/finish")).toHaveLength(0);
  });

  it("the GitHub check lists the repositories the token reaches with its access, and warns (U-051)", async () => {
    const user = userEvent.setup();
    const harness = createHarness(FRESH);
    renderApp("/", harness);
    await screen.findByTestId("setup-page");
    await user.click(screen.getByTestId("setup-next"));
    await screen.findByTestId("setup-anthropic-input");
    await user.click(screen.getByTestId("setup-next"));
    await user.click(await screen.findByTestId("setup-github-input"));
    await user.paste(GH_TOKEN);
    const list = await screen.findByTestId("setup-github-repos");
    expect(list).toHaveTextContent("Repositories this token reaches:");
    expect(list).toHaveTextContent("joel/site: read and write");
    expect(list).toHaveTextContent("joel/notes: read only");
    expect(screen.getByTestId("setup-check-result")).toHaveTextContent(
      "joel/notes: read only. Your agent cannot push there",
    );
    expect(postedCalls(harness, "/setup/github").map((c) => c.body)).toEqual([{ token: GH_TOKEN }]);

    // A token that reaches nothing says what to change on GitHub.
    await user.click(screen.getByTestId("setup-github-input"));
    await user.paste(`${GH_TOKEN}none`);
    await waitFor(() =>
      expect(screen.getByTestId("setup-check-result")).toHaveTextContent(
        "The token reaches no repository. On GitHub, edit the token",
      ),
    );
    expect(screen.queryByTestId("setup-github-repos")).not.toBeInTheDocument();
  });

  it("a key pasted with a line break inside is not sent and never shown (U-053)", async () => {
    const user = userEvent.setup();
    const harness = createHarness(FRESH);
    renderApp("/", harness);
    await screen.findByTestId("setup-page");
    await user.click(screen.getByTestId("setup-next"));
    await user.click(await screen.findByTestId("setup-anthropic-input"));
    await user.paste(`${API_KEY.slice(0, 25)}\n${API_KEY.slice(25)}`);
    expect(
      await screen.findByText(/It has a line break inside, so it was not checked or saved/),
    ).toBeInTheDocument();
    expect(postedCalls(harness, "/setup/anthropic")).toHaveLength(0);
    expect(screen.getByTestId("setup-anthropic-input")).toHaveValue("");
    expect(document.body.textContent).not.toContain(API_KEY.slice(0, 25));
    expect(document.body.textContent).not.toContain(API_KEY.slice(25));
    // Pasted again in one piece, it is checked as usual.
    await user.paste(API_KEY);
    await waitFor(() =>
      expect(screen.getByTestId("setup-check-result")).toHaveTextContent("✓ Key works"),
    );
    expect(screen.queryByText(/line break inside/)).not.toBeInTheDocument();
  });

  it("set up later closes the assistant without a restart", async () => {
    const user = userEvent.setup();
    const harness = createHarness(FRESH);
    renderApp("/", harness);
    await screen.findByTestId("setup-page");
    await user.click(screen.getByTestId("setup-later"));
    await waitFor(() => expect(screen.queryByTestId("setup-page")).not.toBeInTheDocument());
    expect(postedCalls(harness, "/setup/finish")).toHaveLength(1);
    expect(postedCalls(harness, "/setup/anthropic")).toHaveLength(0);
  });
});
