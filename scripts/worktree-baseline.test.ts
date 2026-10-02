// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Tests exercise standalone filesystem coordination.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  buildBaselineFingerprint,
  buildPnpmInvocation,
  ensureSingleFlightCache,
  extractFailureSignatures,
  resolveBaselineTest,
} from "./worktree-baseline.ts";

const fixtureDirectories = new Set<string>();

const makeCachePath = (): string => {
  const directoryPath = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-baseline-"));
  fixtureDirectories.add(directoryPath);
  return NodePath.join(directoryPath, "manifest.json");
};

const makeGate = () => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, promise };
};

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Condition was not reached.");
};

const isPayload = (value: unknown): value is { readonly result: string } =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Record<string, unknown>).result === "string";

describe("worktree-baseline", () => {
  afterEach(async () => {
    await Promise.all(
      [...fixtureDirectories].map((directoryPath) =>
        NodeFSP.rm(directoryPath, { recursive: true, force: true }),
      ),
    );
    fixtureDirectories.clear();
  });

  it("coalesces simultaneous cache misses into one producer", async () => {
    const cacheFilePath = makeCachePath();
    const gate = makeGate();
    let producerCalls = 0;
    const create = async () => {
      producerCalls += 1;
      await gate.promise;
      return { result: "baseline" } as const;
    };

    const first = ensureSingleFlightCache({
      cacheFilePath,
      create,
      isCachedValue: isPayload,
      pollIntervalMs: 2,
    });
    const second = ensureSingleFlightCache({
      cacheFilePath,
      create,
      isCachedValue: isPayload,
      pollIntervalMs: 2,
    });

    await waitFor(() => producerCalls === 1);
    gate.open();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { result: "baseline" },
      { result: "baseline" },
    ]);
    expect(producerCalls).toBe(1);
  });

  it("uses the host-native pnpm launcher", () => {
    expect(buildPnpmInvocation("win32", ["run", "typecheck"], "cmd.exe")).toEqual({
      args: ["/d", "/s", "/c", "pnpm.cmd", "run", "typecheck"],
      command: "cmd.exe",
    });
    expect(buildPnpmInvocation("darwin", ["run", "typecheck"])).toEqual({
      args: ["run", "typecheck"],
      command: "pnpm",
    });
  });

  it("waits for a live producer without creating a reclamation lock", async () => {
    const cacheFilePath = makeCachePath();
    const gate = makeGate();
    const reclaimPath = `${cacheFilePath}.lock.reclaim`;
    const reclamationChecks: boolean[] = [];
    let producerStarted = false;
    let waiterStarted = false;
    const producer = ensureSingleFlightCache({
      cacheFilePath,
      isCachedValue: isPayload,
      create: async () => {
        producerStarted = true;
        await gate.promise;
        return { result: "baseline" };
      },
    });
    const pending = [producer];
    try {
      await waitFor(() => producerStarted);
      const waiter = ensureSingleFlightCache({
        cacheFilePath,
        isCachedValue: isPayload,
        pollIntervalMs: 2,
        processExists: () => {
          reclamationChecks.push(NodeFS.existsSync(reclaimPath));
          return true;
        },
        logger: {
          log: () => {
            waiterStarted = true;
          },
        },
        create: async () => {
          throw new Error("The live producer still owns the cache.");
        },
      });
      pending.push(waiter);
      await waitFor(() => waiterStarted);
      expect(reclamationChecks.length).toBeGreaterThan(0);
      expect(reclamationChecks).not.toContain(true);
    } finally {
      gate.open();
      await Promise.all(pending);
    }
  });

  it("runs a selected test in its owning package and rejects paths outside the checkout", async () => {
    const root = NodePath.dirname(makeCachePath());
    const packageDirectory = NodePath.join(root, "scripts");
    await NodeFSP.mkdir(packageDirectory);
    await NodeFSP.writeFile(NodePath.join(root, "package.json"), "{}");
    await NodeFSP.writeFile(NodePath.join(packageDirectory, "package.json"), "{}");
    await NodeFSP.writeFile(NodePath.join(packageDirectory, "artifact.test.ts"), "");

    expect(resolveBaselineTest(root, "scripts\\artifact.test.ts")).toEqual({
      testFile: "scripts/artifact.test.ts",
      args: ["--dir", "scripts", "exec", "vp", "test", "run", "artifact.test.ts"],
    });
    for (const path of ["../artifact.test.ts", "/artifact.test.ts", "--passWithNoTests", ""]) {
      expect(() => resolveBaselineTest(root, path)).toThrow("repository-relative test file");
    }
  });

  it("separates full control evidence from each targeted test cache", () => {
    const full = buildBaselineFingerprint("HEAD");
    const artifact = buildBaselineFingerprint("HEAD", "scripts/artifact.test.ts");
    const runtime = buildBaselineFingerprint("HEAD", "packages/shared/src/nodeRuntime.test.ts");
    expect(new Set([full.fingerprint, artifact.fingerprint, runtime.fingerprint]).size).toBe(3);
    expect(buildBaselineFingerprint("HEAD", "scripts/artifact.test.ts")).toEqual(artifact);
  });

  it("serializes different test selections sharing a control checkout", async () => {
    const firstPath = makeCachePath();
    const secondPath = makeCachePath();
    const lockPath = `${firstPath}.lock`;
    const gate = makeGate();
    let firstStarted = false;
    let secondWaiting = false;
    let secondStarted = false;
    const first = ensureSingleFlightCache({
      cacheFilePath: firstPath,
      lockPath,
      isCachedValue: isPayload,
      create: async () => {
        firstStarted = true;
        await gate.promise;
        return { result: "first failed" };
      },
    });
    await waitFor(() => firstStarted);
    const second = ensureSingleFlightCache({
      cacheFilePath: secondPath,
      lockPath,
      isCachedValue: isPayload,
      pollIntervalMs: 2,
      logger: {
        log: () => {
          secondWaiting = true;
        },
      },
      create: async () => {
        secondStarted = true;
        return { result: "second passed" };
      },
    });
    await waitFor(() => secondWaiting);
    expect(secondStarted).toBe(false);
    gate.open();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { result: "first failed" },
      { result: "second passed" },
    ]);
    expect(JSON.parse(await NodeFSP.readFile(firstPath, "utf8"))).toEqual({
      result: "first failed",
    });
  });

  it("returns an existing cache without invoking the producer", async () => {
    const cacheFilePath = makeCachePath();
    await NodeFSP.writeFile(cacheFilePath, '{"result":"cached"}\n');
    let producerCalls = 0;

    await expect(
      ensureSingleFlightCache({
        cacheFilePath,
        create: async () => {
          producerCalls += 1;
          return { result: "new" };
        },
        isCachedValue: isPayload,
      }),
    ).resolves.toEqual({ result: "cached" });
    expect(producerCalls).toBe(0);
  });

  it("does not cache a failed producer", async () => {
    const cacheFilePath = makeCachePath();

    await expect(
      ensureSingleFlightCache({
        cacheFilePath,
        create: async () => {
          throw new Error("incomplete baseline");
        },
        isCachedValue: isPayload,
      }),
    ).rejects.toThrow("incomplete baseline");
    await expect(NodeFSP.stat(cacheFilePath)).rejects.toMatchObject({ code: "ENOENT" });

    await expect(
      ensureSingleFlightCache({
        cacheFilePath,
        create: async () => ({ result: "retry" }),
        isCachedValue: isPayload,
      }),
    ).resolves.toEqual({ result: "retry" });
  });

  it("reclaims a lock whose producer no longer exists", async () => {
    const cacheFilePath = makeCachePath();
    const lockPath = `${cacheFilePath}.lock`;
    await NodeFSP.mkdir(lockPath);
    await NodeFSP.writeFile(
      NodePath.join(lockPath, "owner.json"),
      '{"createdAt":"2026-01-01T00:00:00.000Z","pid":999999}\n',
    );

    await expect(
      ensureSingleFlightCache({
        cacheFilePath,
        create: async () => ({ result: "recovered" }),
        isCachedValue: isPayload,
        pollIntervalMs: 2,
        processExists: () => false,
      }),
    ).resolves.toEqual({ result: "recovered" });
    await expect(NodeFSP.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("extracts stable failure lines without ANSI escapes", () => {
    expect(
      extractFailureSignatures(
        "\u001b[31m FAIL \u001b[39m src/example.test.ts > fails\nAssertionError: expected 1 to be 2\n Test Files 1 failed\n",
      ),
    ).toEqual([
      "FAIL src/example.test.ts > fails",
      "AssertionError: expected 1 to be 2",
      "Test Files 1 failed",
    ]);
  });
});
