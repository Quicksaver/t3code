import EnsureProjectionThreadParentRelation from "./035_BackfillEmptyProjectionThreadRootIds.ts";

/**
 * Upstream databases can already have the project environment and favicon
 * migrations recorded at IDs 39 and 40. Repeat the idempotent lineage
 * convergence above that boundary so those databases gain the branch schema.
 */
export default EnsureProjectionThreadParentRelation;
