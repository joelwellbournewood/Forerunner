import { describe, expect, it } from "vitest";
import { memoryStorage, storageKey } from "../src/lib/storage.ts";
import { activeProject, createStore, defaultAgent } from "../src/store/store.ts";
import { nextTheme, resolveTheme } from "../src/store/theme.ts";
import { AGENTS, ME, PROJECTS } from "./fixtures.ts";
import { testConfig } from "./helpers.tsx";

describe("ui store", () => {
  it("restores the persisted active project and falls back to the daemon's active flag", () => {
    const storage = memoryStorage();
    storage.set(storageKey("test", "activeProject"), "proj_beacon");
    const store = createStore(testConfig(), storage);
    expect(store.getState().activeProjectId).toBe("proj_beacon");
    store.dispatch({ type: "projects", projects: PROJECTS });
    expect(activeProject(store.getState())?.name).toBe("Beacon");

    const fresh = createStore(testConfig(), memoryStorage());
    fresh.dispatch({ type: "projects", projects: PROJECTS });
    expect(fresh.getState().activeProjectId).toBe("proj_atlas");

    // A persisted id that no longer exists is replaced, not kept.
    const stale = memoryStorage();
    stale.set(storageKey("test", "activeProject"), "gone");
    const s3 = createStore(testConfig(), stale);
    s3.dispatch({ type: "projects", projects: PROJECTS });
    expect(s3.getState().activeProjectId).toBe("proj_atlas");
    expect(stale.get(storageKey("test", "activeProject"))).toBe("proj_atlas");
  });

  it("persists theme and active project and notifies subscribers once per change", () => {
    const storage = memoryStorage();
    const store = createStore(testConfig(), storage);
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
    });
    store.dispatch({ type: "theme", theme: "dark" });
    store.dispatch({ type: "theme", theme: "dark" });
    expect(calls).toBe(1);
    expect(storage.get(storageKey("test", "theme"))).toBe("dark");
    store.dispatch({ type: "activeProject", id: "p9" });
    expect(storage.get(storageKey("test", "activeProject"))).toBe("p9");
    store.dispatch({ type: "activeProject", id: null });
    expect(storage.get(storageKey("test", "activeProject"))).toBeNull();
    unsubscribe();
  });

  it("picks the human's principal agent as the default", () => {
    const store = createStore(testConfig(), memoryStorage());
    store.dispatch({ type: "me", me: ME });
    store.dispatch({ type: "agents", agents: [...AGENTS].reverse() });
    expect(defaultAgent(store.getState())?.id).toBe("agent_alice");
  });

  it("upserts a project without losing the others", () => {
    const store = createStore(testConfig(), memoryStorage());
    store.dispatch({ type: "projects", projects: PROJECTS });
    const atlas = PROJECTS[0] as (typeof PROJECTS)[number];
    store.dispatch({ type: "project.upsert", project: { ...atlas, stage: "launch" } });
    expect(store.getState().projects.map((p) => p.stage)).toEqual(["launch", "idea"]);
    expect(store.getState().projects).toHaveLength(2);
  });

  it("keeps the restart announcement and counts extension changes", () => {
    const store = createStore(testConfig(), memoryStorage());
    expect(store.getState().restart).toBeNull();
    const restart = {
      reason: "update",
      targetVersion: "0.2.0",
      fromVersion: "0.1.0",
      exitCode: 86,
    };
    store.dispatch({ type: "restart", restart });
    expect(store.getState().restart).toEqual(restart);
    store.dispatch({ type: "restart", restart: null });
    expect(store.getState().restart).toBeNull();
    store.dispatch({ type: "extension.changed" });
    store.dispatch({ type: "extension.changed" });
    expect(store.getState().extensionsVersion).toBe(2);
  });

  it("resolves and cycles the theme", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(nextTheme("system")).toBe("light");
    expect(nextTheme("dark")).toBe("system");
  });
});
