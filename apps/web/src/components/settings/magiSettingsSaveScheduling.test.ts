import { describe, expect, it } from "vite-plus/test";

import {
  canSaveMagiPersonalities,
  replacePendingMagiSettingsSave,
} from "./magiSettingsSaveScheduling";

describe("canSaveMagiPersonalities", () => {
  const personality = (name: string, prompt = "Review carefully.") => ({
    id: `personality-${name}` as never,
    name,
    prompt,
    included: true,
  });

  it("rejects empty fields and duplicate normalized names", () => {
    expect(canSaveMagiPersonalities([personality("Reviewer"), personality(" reviewer ")])).toBe(
      false,
    );
    expect(canSaveMagiPersonalities([personality("Reviewer", " ")])).toBe(false);
  });

  it("accepts a complete uniquely named roster", () => {
    expect(canSaveMagiPersonalities([personality("Reviewer"), personality("Skeptic")])).toBe(true);
  });
});

describe("replacePendingMagiSettingsSave", () => {
  it("clears a stale save without scheduling another one for invalid input", () => {
    const cleared: Array<string> = [];
    let scheduled = false;

    const next = replacePendingMagiSettingsSave({
      current: "old-timer",
      shouldSchedule: false,
      clear: (timer) => cleared.push(timer),
      schedule: () => {
        scheduled = true;
        return "new-timer";
      },
    });

    expect(cleared).toEqual(["old-timer"]);
    expect(scheduled).toBe(false);
    expect(next).toBeNull();
  });

  it("replaces a stale save when the new input is valid", () => {
    const cleared: Array<string> = [];

    const next = replacePendingMagiSettingsSave({
      current: "old-timer",
      shouldSchedule: true,
      clear: (timer) => cleared.push(timer),
      schedule: () => "new-timer",
    });

    expect(cleared).toEqual(["old-timer"]);
    expect(next).toBe("new-timer");
  });
});
