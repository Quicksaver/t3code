/**
 * The production migration lineage for the conversation-data-savings branch.
 *
 * Upstream migration sources and their native manifest remain in `Migrations`.
 * This module is the branch-owned seam that preserves deployed branch IDs while
 * remapping later upstream migrations into the next available IDs.
 */

import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";

import { migrationEntries as upstreamMigrationEntries } from "./Migrations.ts";
import ThreadColdArchive from "./Migrations/ConversationDataSavings/035_ThreadColdArchive.ts";
import DeletedThreadCleanupQueue from "./Migrations/ConversationDataSavings/036_DeletedThreadCleanupQueue.ts";
import ThreadColdArchiveCompatibility from "./Migrations/ConversationDataSavings/038_ThreadColdArchiveCompatibility.ts";
import ThreadStorageLifecycleCompatibility from "./Migrations/ConversationDataSavings/044_ThreadStorageLifecycleCompatibility.ts";
import ThreadStorageLifecycleCurrentUpstreamCompatibility from "./Migrations/ConversationDataSavings/048_ThreadStorageLifecycleCompatibility.ts";

type UpstreamMigrationEntry = (typeof upstreamMigrationEntries)[number];
const LAST_MAPPED_UPSTREAM_MIGRATION_ID = 47;

const latestUpstreamMigrationId = upstreamMigrationEntries.at(-1)?.[0];
if (latestUpstreamMigrationId !== LAST_MAPPED_UPSTREAM_MIGRATION_ID) {
  throw new Error(
    `Conversation-data-savings migration lineage maps upstream through ${LAST_MAPPED_UPSTREAM_MIGRATION_ID}, but the upstream manifest ends at ${latestUpstreamMigrationId ?? "no migration"}`,
  );
}

function remapUpstreamMigration(
  branchId: number,
  upstreamId: number,
): readonly [number, UpstreamMigrationEntry[1], UpstreamMigrationEntry[2]] {
  const entry = upstreamMigrationEntries.find(([id]) => id === upstreamId);
  if (entry === undefined) {
    throw new Error(`Missing upstream migration ${upstreamId}`);
  }
  return [branchId, entry[1], entry[2]];
}

export const migrationEntries = [
  ...upstreamMigrationEntries.filter(([id]) => id <= 34),
  [35, "ThreadColdArchive", ThreadColdArchive],
  [36, "DeletedThreadCleanupQueue", DeletedThreadCleanupQueue],
  remapUpstreamMigration(37, 35),
  [38, "ThreadColdArchiveCompatibility", ThreadColdArchiveCompatibility],
  remapUpstreamMigration(39, 36),
  remapUpstreamMigration(40, 37),
  remapUpstreamMigration(41, 38),
  remapUpstreamMigration(42, 39),
  remapUpstreamMigration(43, 40),
  [44, "ThreadStorageLifecycleCompatibility", ThreadStorageLifecycleCompatibility],
  remapUpstreamMigration(45, 41),
  remapUpstreamMigration(46, 42),
  remapUpstreamMigration(47, 43),
  [48, "ThreadStorageLifecycleCompatibility", ThreadStorageLifecycleCurrentUpstreamCompatibility],
  remapUpstreamMigration(49, 44),
  remapUpstreamMigration(50, 45),
  remapUpstreamMigration(51, 46),
  remapUpstreamMigration(52, 47),
] as const;

export const migrationManifest = migrationEntries.map(([id, name]) => [id, name] as const);

export const makeMigrationLoader = (throughId?: number) =>
  Migrator.fromRecord(
    Object.fromEntries(
      migrationEntries
        .filter(([id]) => throughId === undefined || id <= throughId)
        .map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );

const run = Migrator.make({});

export interface RunMigrationsOptions {
  readonly toMigrationInclusive?: number | undefined;
}

export const runMigrations = Effect.fn("runMigrations")(function* ({
  toMigrationInclusive,
}: RunMigrationsOptions = {}) {
  const executedMigrations = yield* run({ loader: makeMigrationLoader(toMigrationInclusive) });
  const migrations = executedMigrations.map(([id, name]) => `${id}_${name}`);
  yield* migrations.length === 0
    ? Effect.logDebug("Database schema is current")
    : Effect.log("Migrations ran successfully").pipe(Effect.annotateLogs({ migrations }));
  return executedMigrations;
});
