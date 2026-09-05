import EnsureProjectionThreadParentRelation from "./035_BackfillEmptyProjectionThreadRootIds.ts";

/**
 * Upstream can already have migrations 34-38 recorded before this branch is
 * installed. In that history the branch's lineage migrations never ran, so
 * converge the relation schema and root ids before later projection reads.
 */
export default EnsureProjectionThreadParentRelation;
