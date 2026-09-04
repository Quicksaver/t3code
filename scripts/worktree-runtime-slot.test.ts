// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - Tests exercise standalone filesystem coordination.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  acquireWithCancellationSignal,
  type AcquisitionSignal,
  main,
  RuntimeSlotManager,
} from "./worktree-runtime-slot.ts";

const fixtureDirectories = new Set<string>();

const delay = async (durationMs: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, durationMs));
};

const makeSignal = () => {
  let resolve!: (signal: AcquisitionSignal) => void;
  const promise = new Promise<AcquisitionSignal>((resume) => {
    resolve = resume;
  });
  return { promise, resolve };
};

const makeManager = () => {
  const directoryPath = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-runtime-slot-"));
  fixtureDirectories.add(directoryPath);
  const messages: string[] = [];
  const stateFilePath = NodePath.join(directoryPath, "slots.json");
  return {
    directoryPath,
    manager: new RuntimeSlotManager({
      lockRetryMs: 2,
      lockStaleAfterMs: 20,
      logger: { log: (message) => messages.push(message) },
      pollIntervalMs: 5,
      stateFilePath,
    }),
    messages,
    stateFilePath,
  };
};

describe("worktree-runtime-slot", () => {
  afterEach(async () => {
    await Promise.all(
      [...fixtureDirectories].map((directoryPath) =>
        NodeFSP.rm(directoryPath, { recursive: true, force: true }),
      ),
    );
    fixtureDirectories.clear();
  });

  it("requires request-scoped command-line acquisition and release", async () => {
    await expect(main(["acquire", "desktop", "--worktree", "/worktrees/unscoped"])).rejects.toThrow(
      "Expected --request-id <unique-id>.",
    );
    await expect(main(["release", "desktop", "--worktree", "/worktrees/unscoped"])).rejects.toThrow(
      "Expected --request-id <unique-id>.",
    );
  });

  it("cancels a request-scoped acquisition when interrupted while waiting", async () => {
    const { manager } = makeManager();
    await manager.acquire("desktop", "/worktrees/holder", "holder-request");
    const signal = makeSignal();
    const interrupted = acquireWithCancellationSignal(
      manager,
      "desktop",
      "/worktrees/candidate",
      "candidate-request",
      signal.promise,
      20,
    );

    await delay(10);
    signal.resolve("SIGINT");

    await expect(interrupted).resolves.toBe("SIGINT");
    expect(await manager.status()).toMatchObject({
      desktop: [{ requestId: "holder-request", worktree: "/worktrees/holder" }],
      requests: {
        "holder-request": { worktree: "/worktrees/holder" },
      },
    });
  });

  it("releases a holder interrupted immediately after acquisition", async () => {
    const { manager } = makeManager();
    const signal = makeSignal();
    const interrupted = acquireWithCancellationSignal(
      manager,
      "desktop",
      "/worktrees/candidate",
      "candidate-request",
      signal.promise,
      50,
    );

    await delay(5);
    signal.resolve("SIGTERM");

    await expect(interrupted).resolves.toBe("SIGTERM");
    expect(await manager.status()).toMatchObject({ desktop: [], requests: {} });
  });

  it("acquires two mobile holders and one independent desktop holder", async () => {
    const { manager } = makeManager();

    await Promise.all([
      manager.acquire("mobile", "/worktrees/mobile-one", "mobile-one-request"),
      manager.acquire("mobile", "/worktrees/mobile-two", "mobile-two-request"),
      manager.acquire("desktop", "/worktrees/desktop", "desktop-request"),
    ]);

    const status = await manager.status();
    expect(status.desktop).toEqual([expect.objectContaining({ worktree: "/worktrees/desktop" })]);
    expect(status.mobile).toHaveLength(2);
    expect(status.mobile).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ worktree: "/worktrees/mobile-one" }),
        expect.objectContaining({ worktree: "/worktrees/mobile-two" }),
      ]),
    );
    expect(status).toMatchObject({
      requests: {
        "desktop-request": { worktree: "/worktrees/desktop" },
        "mobile-one-request": { worktree: "/worktrees/mobile-one" },
        "mobile-two-request": { worktree: "/worktrees/mobile-two" },
      },
      version: 4,
    });
  });

  it("waits only after mobile reaches capacity", async () => {
    const { manager, messages } = makeManager();
    await manager.acquire("mobile", "/worktrees/first", "first-request");
    await manager.acquire("mobile", "/worktrees/second", "second-request");
    let thirdAcquired = false;
    const thirdAcquire = manager.acquire("mobile", "/worktrees/third", "third-request").then(() => {
      thirdAcquired = true;
    });

    await delay(20);
    expect(thirdAcquired).toBe(false);
    expect(
      messages.some(
        (message) =>
          message.startsWith("Waiting for mobile capacity held by ") &&
          message.includes("/worktrees/first") &&
          message.includes("/worktrees/second"),
      ),
    ).toBe(true);

    await manager.release("mobile", "/worktrees/first", "first-request");
    await thirdAcquire;

    expect(thirdAcquired).toBe(true);
    expect((await manager.status()).mobile).toEqual([
      expect.objectContaining({ worktree: "/worktrees/second" }),
      expect.objectContaining({ worktree: "/worktrees/third" }),
    ]);
  });

  it("does not release capacity held by other worktrees", async () => {
    const { manager } = makeManager();
    await manager.acquire("mobile", "/worktrees/holder-one", "holder-one-request");
    await manager.acquire("mobile", "/worktrees/holder-two", "holder-two-request");

    await expect(manager.release("mobile", "/worktrees/other", "other-request")).rejects.toThrow(
      "capacity is held by /worktrees/holder-one, /worktrees/holder-two",
    );
    expect((await manager.status()).mobile).toHaveLength(2);
  });

  it("cancels a request while it waits without later taking released capacity", async () => {
    const { manager, messages } = makeManager();
    await manager.acquire("mobile", "/worktrees/holder-one", "holder-one-request");
    await manager.acquire("mobile", "/worktrees/holder-two", "holder-two-request");
    const waiting = manager.acquire("mobile", "/worktrees/candidate", "representative-1");

    await delay(20);
    expect(await manager.cancel("mobile", "/worktrees/candidate", "representative-1")).toBe(false);
    await expect(waiting).resolves.toBe("cancelled");
    await manager.release("mobile", "/worktrees/holder-one", "holder-one-request");
    await delay(10);

    expect((await manager.status()).mobile).toHaveLength(1);
    expect((await manager.status()).requests).toMatchObject({
      "holder-two-request": { worktree: "/worktrees/holder-two" },
    });
    expect(messages).toContain(
      "Cancelled mobile runtime-slot request representative-1 for /worktrees/candidate.",
    );
  });

  it("atomically releases only the matching request-scoped holder", async () => {
    const { manager } = makeManager();
    await manager.acquire("mobile", "/worktrees/other", "representative-other");
    await manager.acquire("mobile", "/worktrees/candidate", "representative-2");

    expect(await manager.cancel("mobile", "/worktrees/candidate", "representative-2")).toBe(true);
    expect(await manager.status()).toMatchObject({
      mobile: [{ requestId: "representative-other", worktree: "/worktrees/other" }],
      requests: {
        "representative-other": { worktree: "/worktrees/other" },
      },
    });
  });

  it("does not cancel a different request held by the same worktree", async () => {
    const { manager } = makeManager();
    await manager.acquire("mobile", "/worktrees/candidate", "representative-winner");

    expect(await manager.cancel("mobile", "/worktrees/candidate", "representative-loser")).toBe(
      false,
    );
    expect((await manager.status()).mobile[0]).toMatchObject({
      requestId: "representative-winner",
      worktree: "/worktrees/candidate",
    });
    await expect(
      manager.release("mobile", "/worktrees/candidate", "representative-loser"),
    ).rejects.toThrow("it is held under request representative-winner");
  });

  it("releases the winning request and removes its request record", async () => {
    const { manager } = makeManager();
    await manager.acquire("mobile", "/worktrees/winner", "representative-winner");

    expect(await manager.release("mobile", "/worktrees/winner", "representative-winner")).toBe(
      true,
    );
    expect(await manager.status()).toMatchObject({ mobile: [], requests: {} });
  });

  it("makes repeated acquisition by the holder idempotent", async () => {
    const { manager, messages } = makeManager();

    await manager.acquire("desktop", "/worktrees/holder", "holder-request");
    await manager.acquire("desktop", "/worktrees/holder", "holder-request");

    expect((await manager.status()).desktop[0]?.worktree).toBe("/worktrees/holder");
    expect(messages).toContain(
      "/worktrees/holder already holds the desktop runtime slot under request holder-request.",
    );
  });

  it("cleans up only holders and requests owned by the finished worktree", async () => {
    const { manager } = makeManager();
    await manager.acquire("desktop", "/worktrees/finished", "finished-desktop-request");
    await manager.acquire("mobile", "/worktrees/finished", "finished-mobile-request");
    await manager.acquire("mobile", "/worktrees/running", "running-mobile-request");

    expect(await manager.cleanup("/worktrees/finished")).toEqual(["mobile", "desktop"]);
    expect(await manager.status()).toMatchObject({
      desktop: [],
      mobile: [{ worktree: "/worktrees/running" }],
      requests: {
        "running-mobile-request": { worktree: "/worktrees/running" },
      },
      version: 4,
    });
  });

  it("upgrades legacy single-holder state and drops web state", async () => {
    const { manager, stateFilePath } = makeManager();
    await NodeFSP.writeFile(
      stateFilePath,
      `${JSON.stringify({
        version: 3,
        web: { acquiredAt: "now", worktree: "/worktrees/web" },
        mobile: { acquiredAt: "now", worktree: "/worktrees/mobile" },
        desktop: null,
        requests: {
          "web-request": {
            cancelledAt: null,
            requestedAt: "now",
            resource: "web",
            worktree: "/worktrees/web",
          },
        },
      })}\n`,
    );

    expect(await manager.status()).toEqual({
      desktop: [],
      mobile: [{ acquiredAt: "now", worktree: "/worktrees/mobile" }],
      requests: {},
      version: 4,
    });
  });

  it("reclaims an abandoned short-lived state mutex", async () => {
    const { directoryPath, manager, stateFilePath } = makeManager();
    const lockPath = `${stateFilePath}.lock`;
    await NodeFSP.mkdir(lockPath);
    await NodeFSP.writeFile(NodePath.join(lockPath, "owner"), "abandoned");
    const staleAt = new Date(Date.now() - 1_000);
    await NodeFSP.utimes(lockPath, staleAt, staleAt);

    await manager.acquire("desktop", "/worktrees/recovered", "recovered-request");

    expect((await manager.status()).desktop[0]?.worktree).toBe("/worktrees/recovered");
    await expect(NodeFSP.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(NodeFSP.stat(`${lockPath}.reclaim`)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(NodeFS.existsSync(directoryPath)).toBe(true);
  });
});
