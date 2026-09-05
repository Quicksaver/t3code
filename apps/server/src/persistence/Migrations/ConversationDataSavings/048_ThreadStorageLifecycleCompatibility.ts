/**
 * Re-run the lifecycle compatibility migration after the upstream migrations
 * whose ids overlap this branch through migration 047.
 *
 * Upstream databases can have those ids recorded without this branch's
 * cold-storage schema. Keeping this check above them ensures the lifecycle
 * tables are created when such a database joins the branch.
 */
export { default } from "./044_ThreadStorageLifecycleCompatibility.ts";
