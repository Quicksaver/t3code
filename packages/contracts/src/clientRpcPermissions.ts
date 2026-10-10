import * as Schema from "effect/Schema";
import { GitPreparePullRequestThreadInput } from "./git.ts";
import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  type AuthEnvironmentScope,
} from "./auth.ts";
import { WS_METHODS } from "./rpc.ts";

/** Incremental client enforcement; the server still authorizes every request. */
export const CLIENT_GUARDED_RPC_SCOPES = {
  [WS_METHODS.serverRunStorageCleanup]: AuthSettingsWriteScope,
  [WS_METHODS.pullRequestsRunAction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdate]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdateComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSubmitReview]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsReplyToThread]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetThreadResolution]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetReaction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetFilesViewed]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsRequestReviewers]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetLabels]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlCloneRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlPublishRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneStart]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneCancel]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneRetry]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPull]: AuthSourceControlWriteScope,
  [WS_METHODS.gitRunStackedAction]: AuthSourceControlWriteScope,
  [WS_METHODS.gitPreparePullRequestThread]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsRemoveWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsSwitchRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsInit]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPanelCommitStaged]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPanelStageFiles]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPanelUnstageFiles]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPanelDiscardFiles]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPanelPullBranch]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPanelPushBranch]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPanelDeleteBranch]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPanelUndoLatestCommit]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPanelRevertCommit]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPanelCheckoutCommit]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPanelCreateBranchFromCommit]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPanelMergeBranchIntoCurrent]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPanelRebaseCurrentOnto]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPanelFetchBranch]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPanelFetchRemote]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPanelFetchAllRemotes]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPanelAddRemote]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPanelRemoveRemote]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPanelCreateStash]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPanelApplyStash]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPanelPopStash]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPanelDropStash]: AuthSourceControlWriteScope,

  [WS_METHODS.scheduledTasksUpsert]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksSetEnabled]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRunNow]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRotateWebhookToken]: AuthOrchestrationOperateScope,
} as const;
export type ClientGuardedRpcTag = keyof typeof CLIENT_GUARDED_RPC_SCOPES;

const decodePrepareThread = Schema.decodeUnknownSync(GitPreparePullRequestThreadInput);

export function clientRpcRequiredScopes(
  method: string,
  input: unknown,
): readonly AuthEnvironmentScope[] {
  if (method === WS_METHODS.gitPreparePullRequestThread && input !== undefined) {
    const payload = decodePrepareThread(input);
    if (payload.mode === "worktree" && payload.threadId !== undefined)
      return [AuthSourceControlWriteScope, AuthOrchestrationOperateScope];
  }
  return Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, method)
    ? [CLIENT_GUARDED_RPC_SCOPES[method as ClientGuardedRpcTag]]
    : [];
}
