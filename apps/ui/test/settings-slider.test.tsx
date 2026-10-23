import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createClient } from "../src/api/client.ts";
import {
  commandForSetting,
  SPEED_QUALITY_POSITIONS,
  speedQualityLabel,
  speedQualityPosition,
} from "../src/pages/SettingsPage.tsx";
import { createFakeDaemon } from "./fake-daemon.ts";
import { createHarness, fetchFromApp, postedCalls, renderApp, testConfig } from "./helpers.tsx";

/**
 * The speed-versus-quality slider in Settings (spec D.16): the project's
 * `speed_quality_offset` row is a slider with three stops (speed -1, balanced 0, quality +1),
 * not a raw value; a move runs `settings.set` through the command registry like chat and
 * voice, and the change log sentence says what the new position does, both ways.
 */
const QUALITY =
  "quality, every mode's default effort one step higher (slower, more thorough) from the next run, turn or planning session";
const SPEED =
  "speed, every mode's default effort one step lower (faster and cheaper) from the next run, turn or planning session";

const ROW = {
  key: "project.speed_quality_offset",
  scope: "project" as const,
  scopeId: "proj_atlas",
  value: 0,
  description: "Speed versus quality for Atlas",
  risk: "low" as const,
};

describe("the speed-versus-quality slider", () => {
  it("maps the row to a three-stop slider behind settings.set", () => {
    expect(SPEED_QUALITY_POSITIONS.map((p) => [p.value, p.label])).toEqual([
      [-1, "speed"],
      [0, "balanced"],
      [1, "quality"],
    ]);
    const cmd = commandForSetting(ROW);
    expect(cmd).toMatchObject({ name: "settings.set", inputType: "slider", min: -1, max: 1 });
    expect(cmd?.step).toBe(1);
    expect(cmd?.params("1")).toEqual({
      key: "speed_quality_offset",
      value: 1,
      project: "proj_atlas",
    });
    expect(cmd?.params("-1")).toEqual({
      key: "speed_quality_offset",
      value: -1,
      project: "proj_atlas",
    });
    expect(cmd?.params("2")).toBeNull();
    expect(cmd?.params("0.5")).toBeNull();
    // Unset or junk reads as balanced, as the runtime reads it.
    expect(cmd?.initial(undefined)).toBe("0");
    expect(cmd?.initial(5)).toBe("0");
    expect(cmd?.initial(-1)).toBe("-1");
    expect(speedQualityPosition("1").label).toBe("quality");
    expect(speedQualityLabel(1)).toBe("quality (+1)");
    expect(speedQualityLabel(-1)).toBe("speed (-1)");
    expect(speedQualityLabel(null)).toBe("balanced (0)");
  });

  it("shows the row by position, moves it with the slider and logs the effect both ways, with undo", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/settings", harness);
    const findRow = async () =>
      (await screen.findAllByTestId("setting-row")).find(
        (r) => r.dataset.key === "project.speed_quality_offset",
      ) as HTMLElement;
    const row = await findRow();
    expect(within(row).getByTestId("setting-value-cell")).toHaveTextContent("balanced (0)");
    expect(within(row).getByTestId("setting-scope")).toHaveTextContent("project: proj_atlas");

    // Up to quality with the range input itself.
    await user.click(within(row).getByTestId("setting-change"));
    let dialog = await screen.findByTestId("setting-dialog");
    const slider = within(dialog).getByTestId("setting-value") as HTMLInputElement;
    expect(slider.type).toBe("range");
    expect(slider).toHaveAttribute("min", "-1");
    expect(slider).toHaveAttribute("max", "1");
    expect(slider).toHaveAttribute("step", "1");
    expect(slider.value).toBe("0");
    expect(within(dialog).getByTestId("slider-stop-balanced")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.change(slider, { target: { value: "1" } });
    expect(slider).toHaveAttribute("aria-valuetext", "quality");
    expect(within(dialog).getByTestId("slider-effect")).toHaveTextContent(
      "quality: every mode's effort one step higher",
    );
    await user.click(within(dialog).getByTestId("setting-apply"));
    await waitFor(() => expect(postedCalls(harness, "/commands/execute")).toHaveLength(1));
    expect(postedCalls(harness, "/commands/execute")[0]?.body).toEqual({
      commands: [
        {
          name: "settings.set",
          params: { key: "speed_quality_offset", value: 1, project: "proj_atlas" },
        },
      ],
      wordsUsed: "Settings: project.speed_quality_offset to quality (+1)",
      source: "ui",
      projectId: "proj_atlas",
    });
    // Low risk: done at once, the sentence names what the move changes.
    let done = await within(dialog).findByTestId("command-done");
    expect(within(done).getByTestId("command-sentence")).toHaveTextContent(
      `Set the speed-versus-quality slider for Atlas from unset to 1: ${QUALITY}. Undo.`,
    );
    expect(harness.daemon.state.speedQuality.proj_atlas).toBe(1);
    expect(harness.daemon.state.changes[0]).toMatchObject({
      source: "ui",
      sentence: `Set the speed-versus-quality slider for Atlas from unset to 1: ${QUALITY}. Undo.`,
    });
    await user.click(within(done).getByTestId("command-close"));
    await waitFor(async () =>
      expect(within(await findRow()).getByTestId("setting-value-cell")).toHaveTextContent(
        "quality (+1)",
      ),
    );

    // Down to speed with the stop's name: the other direction's sentence.
    await user.click(within(await findRow()).getByTestId("setting-change"));
    dialog = await screen.findByTestId("setting-dialog");
    expect((within(dialog).getByTestId("setting-value") as HTMLInputElement).value).toBe("1");
    await user.click(within(dialog).getByTestId("slider-stop-speed"));
    expect((within(dialog).getByTestId("setting-value") as HTMLInputElement).value).toBe("-1");
    await user.click(within(dialog).getByTestId("setting-apply"));
    done = await within(dialog).findByTestId("command-done");
    expect(within(done).getByTestId("command-sentence")).toHaveTextContent(
      `Set the speed-versus-quality slider for Atlas from 1 to -1: ${SPEED}. Undo.`,
    );
    expect(harness.daemon.state.speedQuality.proj_atlas).toBe(-1);
    expect(postedCalls(harness, "/commands/execute")[1]?.body).toMatchObject({
      wordsUsed: "Settings: project.speed_quality_offset to speed (-1)",
    });

    // Undo puts the slider back at quality.
    await user.click(within(done).getByTestId("command-undo"));
    expect(await within(dialog).findByTestId("setting-undone")).toHaveTextContent(
      "Undone: Set the speed-versus-quality slider for Atlas from 1 to -1",
    );
    expect(harness.daemon.state.speedQuality.proj_atlas).toBe(1);
  });

  it("the fake refuses an off-scale position in the daemon's words, each way, and writes nothing", async () => {
    const daemon = createFakeDaemon({ token: "tok" });
    const client = createClient(testConfig("tok"), fetchFromApp(daemon.app));
    const send = (value: unknown) =>
      client.executeCommands({
        commands: [
          {
            name: "settings.set",
            params: { key: "speed_quality_offset", value, project: "proj_atlas" },
          },
        ],
        wordsUsed: `slider to ${String(value)}`,
        source: "ui",
        projectId: "proj_atlas",
      });
    // The messages `settings.set` in @forerunner/commands gives for the same values.
    const cases: [unknown, string][] = [
      [-2, "speed_quality_offset: Too small: expected number to be >=-1"],
      [2, "speed_quality_offset: Too big: expected number to be <=1"],
      [0.5, "speed_quality_offset: Invalid input: expected int, received number"],
      ["1", "speed_quality_offset: Invalid input: expected number, received string"],
    ];
    for (const [value, reason] of cases) {
      expect(await send(value)).toMatchObject({ status: "refused", reason, code: "validation" });
    }
    expect(daemon.state.speedQuality.proj_atlas).toBeUndefined();
  });
});
