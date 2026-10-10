import {
  AuthSettingsWriteScope,
  EnvironmentAuthorizationError,
  type EnvironmentId,
  KeybindingRule as KeybindingRuleSchema,
  type KeybindingCommand,
  type KeybindingRule,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import * as Schema from "effect/Schema";

export const PROJECT_SCRIPT_KEYBINDING_INVALID_MESSAGE = "Invalid keybinding.";

/** Save the script first, then recheck the same destination before changing its shortcut. */
export async function saveProjectScriptWithKeybinding(input: {
  readonly environmentId: EnvironmentId;
  readonly keybinding: string | null | undefined;
  readonly keybindingCommand: KeybindingCommand | null;
  readonly isDeletingScript: boolean;
  readonly isElectron: boolean;
  readonly readKeybindings: (environmentId: EnvironmentId) => ResolvedKeybindingsConfig;
  readonly canWriteSettings: (environmentId: EnvironmentId) => boolean;
  readonly saveProject: () => Promise<AtomCommandResult<void, unknown>>;
  readonly saveKeybinding: (
    rule: KeybindingRule | null,
  ) => Promise<AtomCommandResult<void, unknown>>;
}): Promise<AtomCommandResult<void, unknown>> {
  const previous = keybindingValueForCommand(
    input.readKeybindings(input.environmentId),
    input.keybindingCommand,
  );
  const changesKeybinding =
    input.isElectron &&
    input.keybinding !== undefined &&
    (input.keybinding?.trim() || null) !== previous &&
    (!input.isDeletingScript || input.canWriteSettings(input.environmentId));
  const denied = (message: string): AtomCommandResult<void, unknown> =>
    AsyncResult.failure(
      Cause.fail(
        new EnvironmentAuthorizationError({ requiredScope: AuthSettingsWriteScope, message }),
      ),
    );
  if (changesKeybinding && !input.canWriteSettings(input.environmentId)) {
    return denied("This connection cannot change keyboard shortcuts.");
  }
  const rule = changesKeybinding
    ? decodeProjectScriptKeybindingRule({
        keybinding: input.keybinding,
        command: input.keybindingCommand,
      })
    : null;
  const result = await input.saveProject();
  if (result._tag === "Failure" || !changesKeybinding) return result;
  if (!input.canWriteSettings(input.environmentId)) {
    return denied(
      input.isDeletingScript
        ? "The script was deleted, but its keyboard shortcut could not be removed because permission changed."
        : "The script was saved, but this connection can no longer change keyboard shortcuts.",
    );
  }
  return input.saveKeybinding(rule);
}

const decodeKeybindingRule = Schema.decodeUnknownOption(KeybindingRuleSchema);

function normalizeProjectScriptKeybindingInput(
  keybinding: string | null | undefined,
): string | null {
  const trimmed = keybinding?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

export function decodeProjectScriptKeybindingRule(input: {
  keybinding: string | null | undefined;
  command: KeybindingCommand | null;
}): KeybindingRule | null {
  const normalizedKey = normalizeProjectScriptKeybindingInput(input.keybinding);
  if (!normalizedKey) return null;

  if (input.command === null) {
    throw new Error(PROJECT_SCRIPT_KEYBINDING_INVALID_MESSAGE);
  }

  const decoded = decodeKeybindingRule({
    key: normalizedKey,
    command: input.command,
  });
  if (decoded._tag === "None") {
    throw new Error(PROJECT_SCRIPT_KEYBINDING_INVALID_MESSAGE);
  }
  return decoded.value;
}

export function keybindingValueForCommand(
  keybindings: ResolvedKeybindingsConfig,
  command: KeybindingCommand | null,
): string | null {
  if (command === null) return null;
  for (let index = keybindings.length - 1; index >= 0; index -= 1) {
    const binding = keybindings[index];
    if (!binding || binding.command !== command) continue;

    const parts: string[] = [];
    if (binding.shortcut.modKey) parts.push("mod");
    if (binding.shortcut.ctrlKey) parts.push("ctrl");
    if (binding.shortcut.metaKey) parts.push("meta");
    if (binding.shortcut.altKey) parts.push("alt");
    if (binding.shortcut.shiftKey) parts.push("shift");
    const keyToken =
      binding.shortcut.key === " "
        ? "space"
        : binding.shortcut.key === "escape"
          ? "esc"
          : binding.shortcut.key;
    parts.push(keyToken);
    return parts.join("+");
  }
  return null;
}
