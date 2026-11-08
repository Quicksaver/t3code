import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as OriginCli from "./OriginCli.ts";
import * as OriginSourceControlProvider from "./OriginSourceControlProvider.ts";

it.effect("lists repository changes without a head and retains selected source branches", () => {
  const queries: URLSearchParams[] = [];
  const cli = Layer.mock(OriginCli.OriginCli)({
    resolveRepository: () => Effect.succeed("acme/web"),
    api: (input, schema) => {
      const url = new URL(input.path, "https://api.cursor.com");
      assert.strictEqual(url.pathname, "/v1/origin/repos/acme/web/pulls");
      queries.push(url.searchParams);
      return Schema.decodeEffect(schema)({ pullRequests: [] }).pipe(Effect.orDie);
    },
  });
  return Effect.gen(function* () {
    const provider = yield* OriginSourceControlProvider.make;
    yield* provider.listChangeRequests({ cwd: "/repo", state: "open" });
    yield* provider.listChangeRequests({
      cwd: "/repo",
      state: "open",
      headSelector: "owner:feature/panel",
    });
    yield* provider.listChangeRequests({
      cwd: "/repo",
      state: "open",
      source: { refName: "feature/source" },
    });
    assert.deepStrictEqual(
      queries.map((query) => query.get("head")),
      [null, "feature/panel", "feature/source"],
    );
    assert.isTrue(queries.every((query) => query.get("state") === "open"));
  }).pipe(
    Effect.provide([cli, TestSourceControlHost.layer()]),
    Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({})),
  );
});
