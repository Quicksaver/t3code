import { expect, it } from "@effect/vitest";
import { Tool } from "effect/ai";

import { ContextArtifactToolkit } from "../context/tools.ts";
import { MagiStartTool, MagiToolkit } from "./tools.ts";

// MCP clients reject a tool whose input schema is not an object, which would drop the
// whole t3-code server for that provider session.
it.each([...Object.values(MagiToolkit.tools), ...Object.values(ContextArtifactToolkit.tools)])(
  "advertises an object input schema for $name",
  (tool) => {
    expect(Tool.getJsonSchema(tool)).toMatchObject({ type: "object" });
  },
);

it("requires user-supplied configuration in the advertised start schema", () => {
  expect(Tool.getJsonSchema(MagiStartTool)).toMatchObject({
    required: expect.arrayContaining(["config", "objective", "contextActivityIds"]),
    properties: {
      config: {
        required: expect.arrayContaining([
          "participants",
          "consensusThresholdPercent",
          "magiTurnLimit",
        ]),
        properties: { participants: expect.not.objectContaining({ maxItems: expect.anything() }) },
      },
    },
  });
});

it("advertises only model, identity and voting weight per participant", () => {
  const schema = Tool.getJsonSchema(MagiStartTool) as {
    properties: {
      config: {
        properties: { participants: { items: { properties: object; required: string[] } } };
      };
    };
  };
  const participant = schema.properties.config.properties.participants.items;
  expect(Object.keys(participant.properties).sort()).toEqual([
    "modelSelection",
    "participantId",
    "weight",
  ]);
  expect(participant.required).not.toContain("weight");
});
