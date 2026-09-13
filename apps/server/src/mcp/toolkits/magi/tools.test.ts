import { expect, it } from "@effect/vitest";

import { MAGI_ARBITRATOR_PRE_TURN_PROTOCOL } from "../../../magi/MagiPrompts.ts";
import {
  MagiDeliberateTool,
  MagiGetTerminalProposalsTool,
  MagiRecoverRunContextTool,
  MagiRecoverTurnResultTool,
  MagiRecordArbitrationTool,
  MagiStartTool,
} from "./tools.ts";

it("delivers the pre-turn protocol before agent-started Magi turns", () => {
  expect(MagiStartTool.description).toContain(MAGI_ARBITRATOR_PRE_TURN_PROTOCOL);
  expect(MagiDeliberateTool.description).toContain(MAGI_ARBITRATOR_PRE_TURN_PROTOCOL);
});

it("keeps recovery tools exceptional and normal deliberation server-owned", () => {
  expect(MagiDeliberateTool.description).toContain("server carries forward");
  expect(MagiRecoverTurnResultTool.description).toContain("Recovery only");
  expect(MagiRecoverTurnResultTool.description).toContain(
    "Never use this during an intact normal flow",
  );
  expect(MagiRecoverRunContextTool.description).toContain("Recovery only");
  expect(MagiRecoverRunContextTool.description).toContain(
    "Never use this during an intact normal flow",
  );
});

it("keeps terminal history recovery on demand and arbitration updates incremental", () => {
  expect(MagiGetTerminalProposalsTool.description).toContain("Read terminal proposal records");
  expect(MagiGetTerminalProposalsTool.description).toContain("Page with nextOffset");
  expect(MagiRecordArbitrationTool.description).toContain("terminalProposalDigestUpdates");
  expect(MagiRecordArbitrationTool.description).toContain("merges them with the persisted");
});
