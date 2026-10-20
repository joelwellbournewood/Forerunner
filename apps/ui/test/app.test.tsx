import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/App.tsx";

describe("App shell", () => {
  it("always shows the active project and the kill switch", () => {
    render(<App />);
    expect(screen.getByTestId("active-project")).toHaveTextContent("No active project");
    expect(screen.getByTestId("kill-switch")).toBeEnabled();
    expect(screen.getByTestId("empty-state")).toBeVisible();
  });
});
