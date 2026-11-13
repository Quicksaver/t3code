/**
 * Re-runs the idempotent cold-archive migration for databases that recorded
 * upstream's title-regeneration migration under ID 35 before switching to this
 * fork. It remains safe after the normal fork migration sequence.
 */
export { default } from "./035_ThreadColdArchive.ts";
