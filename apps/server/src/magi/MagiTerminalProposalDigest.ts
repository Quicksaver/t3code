import {
  MagiProposalId,
  type MagiProposal,
  type MagiTerminalProposalDigestEntry,
} from "@t3tools/contracts";

export const MAGI_TERMINAL_PROPOSAL_DIGEST_MAX_CHARS = 20_000;
export const MAGI_TERMINAL_PROPOSAL_PAGE_MAX_CHARS = 30_000;

export const isMagiTerminalProposalDigestWithinLimit = (renderedDigest: string): boolean =>
  renderedDigest.length <= MAGI_TERMINAL_PROPOSAL_DIGEST_MAX_CHARS;

export const terminalMagiProposals = (
  proposals: ReadonlyArray<MagiProposal>,
): ReadonlyArray<MagiProposal> =>
  proposals.filter(
    (proposal) => proposal.decision !== "open" && proposal.decision !== "reconsidering",
  );

const proposalIdBody = (proposalId: string): string =>
  proposalId.startsWith("proposal_") ? proposalId.slice("proposal_".length) : proposalId;

export const magiTerminalProposalReference = (
  proposalId: string,
  proposalIds: ReadonlyArray<string>,
): string => {
  const body = proposalIdBody(proposalId);
  const bodies = proposalIds.map(proposalIdBody);
  let length = Math.min(8, body.length);
  while (
    length < body.length &&
    bodies.filter((candidate) => candidate.startsWith(body.slice(0, length))).length > 1
  ) {
    length += 1;
  }
  return `~${body.slice(0, length)}`;
};

export const resolveMagiProposalReference = (
  proposals: ReadonlyArray<MagiProposal>,
  reference: string | null | undefined,
): MagiProposalId | null => {
  if (reference === null || reference === undefined) return null;
  const exact = proposals.find((proposal) => proposal.proposalId === reference);
  if (exact) return exact.proposalId;
  if (!reference.startsWith("~") || reference.length === 1) return null;
  const prefix = reference.slice(1);
  const matches = proposals.filter((proposal) =>
    proposalIdBody(proposal.proposalId).startsWith(prefix),
  );
  return matches.length === 1 ? matches[0]!.proposalId : null;
};

export const validateMagiTerminalProposalDigestCoverage = (input: {
  readonly terminalProposals: ReadonlyArray<MagiProposal>;
  readonly digest: ReadonlyArray<MagiTerminalProposalDigestEntry>;
}): ReadonlyArray<string> => {
  const terminalIds = new Set<string>(input.terminalProposals.map((item) => item.proposalId));
  const counts = new Map<string, number>();
  for (const entry of input.digest) {
    counts.set(entry.proposalId, (counts.get(entry.proposalId) ?? 0) + 1);
  }

  const duplicateIds = [...counts].filter(([, count]) => count > 1).map(([id]) => id);
  const unknownIds = [...counts.keys()].filter((id) => !terminalIds.has(id));
  const missingIds = [...terminalIds].filter((id) => !counts.has(id));
  const issues: Array<string> = [];
  if (missingIds.length > 0) issues.push(`missing: ${missingIds.join(", ")}`);
  if (duplicateIds.length > 0) issues.push(`duplicated: ${duplicateIds.join(", ")}`);
  if (unknownIds.length > 0) issues.push(`not terminal or unknown: ${unknownIds.join(", ")}`);
  return issues;
};

export const mergeMagiTerminalProposalDigest = (input: {
  readonly terminalProposals: ReadonlyArray<MagiProposal>;
  readonly persistedDigest: ReadonlyArray<MagiTerminalProposalDigestEntry>;
  readonly updates: ReadonlyArray<MagiTerminalProposalDigestEntry>;
}): {
  readonly digest: ReadonlyArray<MagiTerminalProposalDigestEntry>;
  readonly issues: ReadonlyArray<string>;
} => {
  const updateCounts = new Map<string, number>();
  for (const update of input.updates) {
    updateCounts.set(update.proposalId, (updateCounts.get(update.proposalId) ?? 0) + 1);
  }
  const duplicateUpdateIds = [...updateCounts]
    .filter(([, count]) => count > 1)
    .map(([proposalId]) => proposalId);
  if (duplicateUpdateIds.length > 0) {
    return {
      digest: input.persistedDigest,
      issues: [`duplicated updates: ${duplicateUpdateIds.join(", ")}`],
    };
  }

  const digestById = new Map(
    input.persistedDigest.map((entry) => [entry.proposalId, entry] as const),
  );
  for (const update of input.updates) digestById.set(update.proposalId, update);
  const mergedEntries = [...digestById.values()];
  const digest = input.terminalProposals.flatMap((proposal) => {
    const entry = digestById.get(proposal.proposalId);
    return entry === undefined ? [] : [entry];
  });
  return {
    digest,
    issues: validateMagiTerminalProposalDigestCoverage({
      terminalProposals: input.terminalProposals,
      digest: mergedEntries,
    }),
  };
};

export const pageMagiTerminalProposals = (input: {
  readonly terminalProposals: ReadonlyArray<MagiProposal>;
  readonly persistedDigest: ReadonlyArray<MagiTerminalProposalDigestEntry>;
  readonly scope: "missing-digest" | "all-terminal";
  readonly offset: number;
  readonly limit: number;
}): {
  readonly missingDigestCount: number;
  readonly proposals: ReadonlyArray<MagiProposal>;
  readonly nextOffset: number | null;
} => {
  const persistedIds = new Set(input.persistedDigest.map((entry) => entry.proposalId));
  const missingProposals = input.terminalProposals.filter(
    (proposal) => !persistedIds.has(proposal.proposalId),
  );
  const selectedProposals =
    input.scope === "missing-digest" ? missingProposals : input.terminalProposals;
  const proposals: Array<MagiProposal> = [];
  let pageCharacters = 0;
  for (const proposal of selectedProposals.slice(input.offset)) {
    if (proposals.length >= input.limit) break;
    const proposalCharacters = JSON.stringify(proposal).length;
    if (
      proposals.length > 0 &&
      pageCharacters + proposalCharacters > MAGI_TERMINAL_PROPOSAL_PAGE_MAX_CHARS
    ) {
      break;
    }
    proposals.push(proposal);
    pageCharacters += proposalCharacters;
  }
  return {
    missingDigestCount: missingProposals.length,
    proposals,
    nextOffset:
      input.offset + proposals.length < selectedProposals.length
        ? input.offset + proposals.length
        : null,
  };
};
