import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { beforeEach, vi } from "vite-plus/test";

const openDatabaseAsync = vi.hoisted(() => vi.fn());

vi.mock("expo-sqlite", () => ({ openDatabaseAsync }));

import * as MobileDatabase from "./mobile-database";

describe("mobile database cache migration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.effect("clears persisted thread details when upgrading from schema version 1", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const transactionExecAsync = vi.fn(() => Promise.resolve());
        const transactionRunAsync = vi.fn(() => Promise.resolve());
        const database = {
          closeAsync: vi.fn(() => Promise.resolve()),
          execAsync: vi.fn(() => Promise.resolve()),
          getFirstAsync: vi.fn(() => Promise.resolve({ user_version: 1 })),
          withExclusiveTransactionAsync: vi.fn((run: (transaction: unknown) => Promise<void>) =>
            run({ execAsync: transactionExecAsync, runAsync: transactionRunAsync }),
          ),
        };
        openDatabaseAsync.mockResolvedValueOnce(database);

        yield* MobileDatabase.make;

        expect(transactionRunAsync).toHaveBeenCalledOnce();
        expect(transactionRunAsync).toHaveBeenCalledWith(
          "DELETE FROM client_cache WHERE kind = ?",
          "thread",
        );
        expect(transactionExecAsync).toHaveBeenCalledWith("PRAGMA user_version = 2;");
      }),
    ),
  );
});

describe("offline pull request cache", () => {
  const environmentId = "cached-environment" as import("@t3tools/contracts").EnvironmentId;
  const otherEnvironment = "other-environment" as import("@t3tools/contracts").EnvironmentId;

  async function sqliteDatabase() {
    const { DatabaseSync } = await import("node:sqlite");
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA user_version = 1");
    const database = {
      execAsync: async (sql: string) => {
        sqlite.exec(sql);
      },
      runAsync: async (sql: string, ...args: Array<string | number>) =>
        sqlite.prepare(sql).run(...args),
      getFirstAsync: async (sql: string, ...args: Array<string | number>) =>
        sqlite.prepare(sql).get(...args),
      getAllAsync: async (sql: string, ...args: Array<string | number>) =>
        sqlite.prepare(sql).all(...args),
      withExclusiveTransactionAsync: async (run: (transaction: unknown) => Promise<void>) => {
        await run(database);
      },
      closeAsync: async () => {
        sqlite.close();
      },
    };
    openDatabaseAsync.mockResolvedValueOnce(database);
    return sqlite;
  }

  it.effect("restores saved records and clears them with the environment", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.promise(sqliteDatabase);
        const database = yield* MobileDatabase.make;
        yield* database.saveCache(environmentId, "pull-request", "v1:list", 1, '{"entries":[]}');
        yield* database.saveCache(otherEnvironment, "pull-request", "v1:list", 1, "other");
        expect(yield* database.loadCache(environmentId, "pull-request", "v1:list")).toEqual(
          Option.some('{"entries":[]}'),
        );
        yield* database.clearEnvironmentCache(environmentId);
        expect((yield* database.loadCache(environmentId, "pull-request", "v1:list"))._tag).toBe(
          "None",
        );
        expect((yield* database.loadCache(otherEnvironment, "pull-request", "v1:list"))._tag).toBe(
          "Some",
        );
      }),
    ),
  );
});
