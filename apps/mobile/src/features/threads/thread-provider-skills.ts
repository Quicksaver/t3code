import { hasInlineSkillToken } from "@t3tools/shared/skillInlineTokens";

interface ThreadProviderSkillFeedEntry {
  readonly type: string;
  readonly message?: {
    readonly role: string;
    readonly text: string;
  };
}

export function shouldLoadThreadProviderWorkspaceSkills(input: {
  readonly composerSkillMenuActive: boolean;
  readonly draftMessage: string;
  readonly feed: ReadonlyArray<ThreadProviderSkillFeedEntry>;
}): boolean {
  if (input.composerSkillMenuActive) {
    return true;
  }

  if (hasInlineSkillToken(input.draftMessage)) {
    return true;
  }

  return input.feed.some(
    (entry) =>
      entry.type === "message" &&
      entry.message?.role === "user" &&
      hasInlineSkillToken(entry.message.text),
  );
}
