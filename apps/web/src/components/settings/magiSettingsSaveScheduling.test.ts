import { describe, expect, it } from "vite-plus/test";

import { canSaveMagiPersonalities, createMagiSettingsAutosave } from "./magiSettingsSaveScheduling";

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

describe("createMagiSettingsAutosave", () => {
  function harness() {
    const timers = new Map<number, () => void>();
    let nextTimer = 0;
    const saves: Array<{ readonly value: string; readonly resolve: (result: string) => void }> = [];
    const settled: Array<string> = [];
    const autosave = createMagiSettingsAutosave({
      delayMs: 400,
      schedule: (run) => {
        timers.set(++nextTimer, run);
        return nextTimer;
      },
      clear: (timer) => timers.delete(timer),
      save: (value: string) => new Promise<string>((resolve) => saves.push({ value, resolve })),
      onSettled: (result) => settled.push(result),
    });
    const fireTimers = () => {
      const pending = [...timers.values()];
      timers.clear();
      for (const run of pending) run();
    };
    return { autosave, timers, saves, settled, fireTimers };
  }

  it("debounces edits into one save of the latest valid value", () => {
    const { autosave, saves, fireTimers } = harness();
    autosave.edit("A");
    autosave.edit("AB");
    expect(saves).toEqual([]);
    fireTimers();
    expect(saves.map((save) => save.value)).toEqual(["AB"]);
  });

  it("stays dirty while a newer edit follows an in-flight save", async () => {
    const { autosave, saves, settled, fireTimers } = harness();
    autosave.edit("A");
    fireTimers();
    autosave.edit("AB");
    saves[0]!.resolve("saved A");
    await Promise.resolve();
    expect(autosave.isDirty()).toBe(true);
    expect(settled).toEqual([]);

    fireTimers();
    saves[1]!.resolve("saved AB");
    await Promise.resolve();
    expect(autosave.isDirty()).toBe(false);
    expect(settled).toEqual(["saved AB"]);
  });

  it("keeps an incomplete value local without saving it", () => {
    const { autosave, timers, saves } = harness();
    autosave.edit("A");
    autosave.edit(null);
    expect(timers.size).toBe(0);
    autosave.flush();
    expect(saves).toEqual([]);
    expect(autosave.isDirty()).toBe(true);
  });

  it("flushes a scheduled save immediately", () => {
    const { autosave, timers, saves } = harness();
    autosave.edit("A");
    autosave.flush();
    expect(timers.size).toBe(0);
    expect(saves.map((save) => save.value)).toEqual(["A"]);
  });

  it("discards scheduled and in-flight saves before a restore", async () => {
    const { autosave, timers, saves, settled, fireTimers } = harness();
    autosave.edit("A");
    fireTimers();
    autosave.edit("AB");
    autosave.discard();
    expect(timers.size).toBe(0);
    expect(autosave.isDirty()).toBe(false);

    saves[0]!.resolve("saved A");
    await Promise.resolve();
    expect(saves).toHaveLength(1);
    expect(settled).toEqual([]);
  });
});
