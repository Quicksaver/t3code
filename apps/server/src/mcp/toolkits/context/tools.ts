import {
  ContextReadInput,
  ContextReadResult,
  MagiContextUnavailableError,
  MagiValidationError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as ContextArtifactBroker from "../../ContextArtifactBroker.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const ContextReadTool = Tool.make("context_read", {
  description:
    "Read one or more context artifacts granted to this conversation. Returns the complete persisted tool results in input order, without pagination, summarization, or truncation. The artifact manifests in the conversation identify relevant artifact ids and byte lengths.",
  parameters: ContextReadInput,
  success: ContextReadResult,
  failure: Schema.Union([MagiValidationError, MagiContextUnavailableError]),
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ContextArtifactBroker.ContextArtifactBroker,
  ],
})
  .annotate(Tool.Title, "Read context artifacts")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ContextArtifactToolkit = Toolkit.make(ContextReadTool);
