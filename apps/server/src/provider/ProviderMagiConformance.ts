import type { ProviderMagiCapabilities } from "@t3tools/contracts";

import {
  ACP_MAGI_CAPABILITIES,
  CLAUDE_MAGI_CAPABILITIES,
  CODEX_MAGI_CAPABILITIES,
  MAGI_PARTICIPANT_PRE_PROMPT,
  OPENCODE_MAGI_CAPABILITIES,
} from "./ProviderMagiProfile.ts";

export interface ProviderMagiConformanceCase {
  readonly driver: "codex" | "claudeAgent" | "cursor" | "grok" | "opencode";
  readonly capabilities: ProviderMagiCapabilities;
}

export const BUILT_IN_MAGI_CONFORMANCE_CASES: ReadonlyArray<ProviderMagiConformanceCase> = [
  { driver: "codex", capabilities: CODEX_MAGI_CAPABILITIES },
  { driver: "claudeAgent", capabilities: CLAUDE_MAGI_CAPABILITIES },
  { driver: "cursor", capabilities: ACP_MAGI_CAPABILITIES },
  { driver: "grok", capabilities: ACP_MAGI_CAPABILITIES },
  { driver: "opencode", capabilities: OPENCODE_MAGI_CAPABILITIES },
];

/** Shared adapter acceptance checks. Driver tests can add transport-specific
 * assertions while preserving one provider-neutral Magi baseline. */
export function providerMagiConformanceFailures(
  subject: ProviderMagiConformanceCase,
): ReadonlyArray<string> {
  const failures: string[] = [];
  if (subject.capabilities.controlTools === "unsupported") failures.push("control-tools");
  if (subject.capabilities.webSearch !== "native") failures.push("native-web-evidence");
  if (!MAGI_PARTICIPANT_PRE_PROMPT.includes("Participant subagents are unavailable")) {
    failures.push("participant-delegation-disabled");
  }
  return failures;
}

export function builtInMagiAdaptersConform(): boolean {
  return BUILT_IN_MAGI_CONFORMANCE_CASES.every(
    (subject) => providerMagiConformanceFailures(subject).length === 0,
  );
}
