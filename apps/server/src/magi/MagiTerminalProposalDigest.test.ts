import { describe, expect, it } from "@effect/vitest";
import { MagiParticipantId, MagiProposalId, type MagiProposal } from "@t3tools/contracts";

import {
  isMagiTerminalProposalDigestWithinLimit,
  MAGI_TERMINAL_PROPOSAL_DIGEST_MAX_CHARS,
  MAGI_TERMINAL_PROPOSAL_PAGE_MAX_CHARS,
  magiTerminalProposalReference,
  mergeMagiTerminalProposalDigest,
  pageMagiTerminalProposals,
  resolveMagiProposalReference,
  validateMagiTerminalProposalDigestCoverage,
} from "./MagiTerminalProposalDigest.ts";

const terminalProposal = (id: string): MagiProposal => ({
  proposalId: MagiProposalId.make(id),
  proposal: {
    kind: "optional",
    change: `Original proposal ${id}`,
    rationale: "Original rationale.",
    expectedVoteEffect: "Original expected effect.",
    atomicSetKey: null,
  },
  originParticipantIds: [MagiParticipantId.make("participant-one")],
  firstMagiTurn: 1,
  decision: "rejected",
  decisionBasis: "panel-threshold",
  evaluationRounds: 1,
  decisionMagiTurn: 2,
  approvalWeight: 0,
  rejectionWeight: 3,
  integration: "not-applicable",
});

describe("Magi terminal proposal digest", () => {
  it("requires exact coverage without constraining individual summary length", () => {
    const proposals = [terminalProposal("proposal_alpha"), terminalProposal("proposal_beta")];
    const longSummary = "detail ".repeat(3_000).trim();

    expect(
      validateMagiTerminalProposalDigestCoverage({
        terminalProposals: proposals,
        digest: [
          { proposalId: proposals[0]!.proposalId, summary: longSummary },
          { proposalId: proposals[1]!.proposalId, summary: "Faithful beta summary." },
        ],
      }),
    ).toEqual([]);
    expect(longSummary.length).toBeGreaterThan(16_000);
  });

  it("reports missing, duplicate, and nonterminal or unknown ids", () => {
    const [alpha, beta] = [terminalProposal("proposal_alpha"), terminalProposal("proposal_beta")];
    const issues = validateMagiTerminalProposalDigestCoverage({
      terminalProposals: [alpha!, beta!],
      digest: [
        { proposalId: alpha!.proposalId, summary: "Alpha." },
        { proposalId: alpha!.proposalId, summary: "Alpha again." },
        { proposalId: MagiProposalId.make("proposal_open"), summary: "Not terminal." },
      ],
    });

    expect(issues.join(" ")).toContain("missing: proposal_beta");
    expect(issues.join(" ")).toContain("duplicated: proposal_alpha");
    expect(issues.join(" ")).toContain("not terminal or unknown: proposal_open");
  });

  it("creates and resolves the shortest unambiguous participant reference", () => {
    const proposals = [
      terminalProposal("proposal_abcdefgh1"),
      terminalProposal("proposal_abcdefgh2"),
    ];
    const reference = magiTerminalProposalReference(
      proposals[0]!.proposalId,
      proposals.map((item) => item.proposalId),
    );

    expect(reference).toBe("~abcdefgh1");
    expect(resolveMagiProposalReference(proposals, reference)).toBe(proposals[0]!.proposalId);
    expect(resolveMagiProposalReference(proposals, "~abcdefgh")).toBeNull();
  });

  it("accepts the aggregate boundary exactly and rejects one character beyond it", () => {
    expect(isMagiTerminalProposalDigestWithinLimit("x".repeat(20_000))).toBe(true);
    expect(isMagiTerminalProposalDigestWithinLimit("x".repeat(20_001))).toBe(false);
    expect(MAGI_TERMINAL_PROPOSAL_DIGEST_MAX_CHARS).toBe(20_000);
  });

  it("merges only new and revised arbitrator entries into the persisted digest", () => {
    const alpha = terminalProposal("proposal_alpha");
    const beta = terminalProposal("proposal_beta");
    const result = mergeMagiTerminalProposalDigest({
      terminalProposals: [alpha, beta],
      persistedDigest: [{ proposalId: alpha.proposalId, summary: "Earlier alpha summary." }],
      updates: [
        { proposalId: alpha.proposalId, summary: "Revised alpha summary." },
        { proposalId: beta.proposalId, summary: "New beta summary." },
      ],
    });

    expect(result.issues).toEqual([]);
    expect(result.digest).toEqual([
      { proposalId: alpha.proposalId, summary: "Revised alpha summary." },
      { proposalId: beta.proposalId, summary: "New beta summary." },
    ]);
  });

  it("rejects missing, duplicate, and active digest updates after merging", () => {
    const alpha = terminalProposal("proposal_alpha");
    const beta = terminalProposal("proposal_beta");
    const duplicate = mergeMagiTerminalProposalDigest({
      terminalProposals: [alpha],
      persistedDigest: [],
      updates: [
        { proposalId: alpha.proposalId, summary: "Alpha one." },
        { proposalId: alpha.proposalId, summary: "Alpha two." },
      ],
    });
    const missingAndActive = mergeMagiTerminalProposalDigest({
      terminalProposals: [alpha, beta],
      persistedDigest: [],
      updates: [{ proposalId: MagiProposalId.make("proposal_active"), summary: "Still active." }],
    });

    expect(duplicate.issues).toEqual(["duplicated updates: proposal_alpha"]);
    expect(missingAndActive.issues.join(" ")).toContain("missing: proposal_alpha, proposal_beta");
    expect(missingAndActive.issues.join(" ")).toContain("not terminal or unknown: proposal_active");
  });

  it("pages missing or all terminal proposals without returning the digest", () => {
    const proposals = [
      terminalProposal("proposal_alpha"),
      terminalProposal("proposal_beta"),
      terminalProposal("proposal_gamma"),
    ];
    const persistedDigest = [{ proposalId: proposals[0]!.proposalId, summary: "Alpha." }];
    const missingPage = pageMagiTerminalProposals({
      terminalProposals: proposals,
      persistedDigest,
      scope: "missing-digest",
      offset: 0,
      limit: 1,
    });
    const allPage = pageMagiTerminalProposals({
      terminalProposals: proposals,
      persistedDigest,
      scope: "all-terminal",
      offset: 1,
      limit: 2,
    });

    expect(missingPage.missingDigestCount).toBe(2);
    expect(missingPage.proposals.map((item) => item.proposalId)).toEqual([
      proposals[1]!.proposalId,
    ]);
    expect(missingPage.nextOffset).toBe(1);
    expect(allPage.proposals.map((item) => item.proposalId)).toEqual([
      proposals[1]!.proposalId,
      proposals[2]!.proposalId,
    ]);
    expect(allPage.nextOffset).toBeNull();
  });

  it("ends a recovery page before its aggregate source budget without truncating records", () => {
    const proposals = [terminalProposal("proposal_alpha"), terminalProposal("proposal_beta")].map(
      (proposal) => ({
        ...proposal,
        proposal: { ...proposal.proposal, change: "x".repeat(20_000) },
      }),
    );
    const page = pageMagiTerminalProposals({
      terminalProposals: proposals,
      persistedDigest: [],
      scope: "missing-digest",
      offset: 0,
      limit: 20,
    });

    expect(MAGI_TERMINAL_PROPOSAL_PAGE_MAX_CHARS).toBe(30_000);
    expect(page.proposals).toHaveLength(1);
    expect(page.proposals[0]!.proposal.change).toHaveLength(20_000);
    expect(page.nextOffset).toBe(1);
  });
});
