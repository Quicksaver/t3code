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

export interface MagiSettingsAutosave<TValue> {
  /** Records a local edit. `null` keeps an incomplete value local without saving it. */
  readonly edit: (value: TValue | null, options?: { readonly immediate?: boolean }) => void;
  /** Sends a scheduled save now, e.g. when the editor unmounts. */
  readonly flush: () => void;
  /** Drops local edits so an older scheduled or in-flight save cannot settle over a restore. */
  readonly discard: () => void;
  /** Whether local state holds an edit the server has not acknowledged yet. */
  readonly isDirty: () => boolean;
}

/**
 * Debounced autosave for one settings field. Server snapshots should replace the
 * local value only while `isDirty()` is false, so a save completing or an unrelated
 * refresh never reverts newer keystrokes. `onSettled` runs only for the latest edit.
 */
export function createMagiSettingsAutosave<TValue, TTimer, TResult>(options: {
  readonly delayMs: number;
  readonly schedule: (run: () => void, delayMs: number) => TTimer;
  readonly clear: (timer: TTimer) => void;
  readonly save: (value: TValue) => Promise<TResult>;
  readonly onSettled: (result: TResult) => void;
}): MagiSettingsAutosave<TValue> {
  let latestEdit = 0;
  let acknowledgedEdit = 0;
  let timer: TTimer | null = null;
  let pending: { readonly value: TValue; readonly edit: number } | null = null;

  const cancelTimer = () => {
    if (timer !== null) options.clear(timer);
    timer = null;
  };
  const send = (value: TValue, edit: number) => {
    void options.save(value).then((result) => {
      if (edit !== latestEdit) return;
      acknowledgedEdit = edit;
      options.onSettled(result);
    });
  };
  const flush = () => {
    const next = pending;
    cancelTimer();
    pending = null;
    if (next) send(next.value, next.edit);
  };

  return {
    edit: (value, { immediate = false } = {}) => {
      latestEdit += 1;
      cancelTimer();
      pending = value === null ? null : { value, edit: latestEdit };
      if (pending === null) return;
      if (immediate) {
        flush();
        return;
      }
      timer = options.schedule(() => {
        timer = null;
        flush();
      }, options.delayMs);
    },
    flush,
    discard: () => {
      cancelTimer();
      pending = null;
      latestEdit += 1;
      acknowledgedEdit = latestEdit;
    },
    isDirty: () => acknowledgedEdit !== latestEdit,
  };
}
