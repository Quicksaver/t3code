import { expect, it } from "@effect/vitest";
import { Tool } from "effect/ai";

import { ContextArtifactToolkit } from "../context/tools.ts";
import { MagiToolkit } from "./tools.ts";

// MCP clients reject a tool whose input schema is not an object, which would drop the
// whole t3-code server for that provider session.
it.each([...Object.values(MagiToolkit.tools), ...Object.values(ContextArtifactToolkit.tools)])(
  "advertises an object input schema for $name",
  (tool) => {
    expect(Tool.getJsonSchema(tool)).toMatchObject({ type: "object" });
  },
);
