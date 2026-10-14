import { ContextReadInput, ContextReadResult, MagiValidationError } from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import { MagiService } from "../../../magi/MagiService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const ContextReadTool = Tool.make("context_read", {
  description:
    "Read one or more Magi context artifacts addressed to this conversation. Returns the complete persisted tool results in input order, without pagination, summarization, or truncation. The artifact manifests in the conversation identify relevant artifact ids and byte lengths.",
  parameters: ContextReadInput,
  success: ContextReadResult,
  failure: MagiValidationError,
  failureMode: "return",
  dependencies: [McpInvocationContext.McpInvocationContext, MagiService],
})
  .annotate(Tool.Title, "Read context artifacts")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ContextArtifactToolkit = Toolkit.make(ContextReadTool);
