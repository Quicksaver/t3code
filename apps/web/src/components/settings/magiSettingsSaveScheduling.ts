import type { MagiPersonality } from "@t3tools/contracts";

export function canSaveMagiPersonalities(personalities: ReadonlyArray<MagiPersonality>): boolean {
  const names = new Set<string>();
  for (const personality of personalities) {
    const name = personality.name.trim().toLocaleLowerCase();
    if (!name || !personality.prompt.trim() || names.has(name)) return false;
    names.add(name);
  }
  return true;
}

export function replacePendingMagiSettingsSave<TTimer>(input: {
  readonly current: TTimer | null;
  readonly shouldSchedule: boolean;
  readonly clear: (timer: TTimer) => void;
  readonly schedule: () => TTimer;
}): TTimer | null {
  if (input.current !== null) input.clear(input.current);
  return input.shouldSchedule ? input.schedule() : null;
}
