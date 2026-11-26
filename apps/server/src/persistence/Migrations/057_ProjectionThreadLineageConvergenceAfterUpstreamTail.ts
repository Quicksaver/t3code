import EnsureProjectionThreadParentRelation from "./035_BackfillEmptyProjectionThreadRootIds.ts";

/**
 * Databases can already have migrations through ID 45 recorded without the
 * subagent lineage schema. Repeat the idempotent convergence above the combined
 * migration tail so those databases gain the relation columns and root ids.
 */
export default EnsureProjectionThreadParentRelation;
