import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
  resolveFederatedSourceControlTargets,
  type SourceControlEnvironmentCandidate,
} from "./SourceControlPanel.logic";
import {
  SourceControlEnvironmentChain,
  type SourceControlEnvironmentPanelProps,
} from "./SourceControlEnvironmentPanel";

interface SourceControlPanelProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly worktreePath: string | null;
  readonly environments: readonly SourceControlEnvironmentCandidate[];
  readonly onThreadRefChange?: SourceControlEnvironmentPanelProps["onThreadRefChange"];
}

export function SourceControlPanel({
  cwd,
  environmentId,
  environments,
  onThreadRefChange,
  threadId,
  worktreePath,
}: SourceControlPanelProps) {
  const targets = (() =>
    resolveFederatedSourceControlTargets({
      activeEnvironmentId: environmentId,
      activeCwd: cwd,
      activeWorktreePath: worktreePath,
      candidates: environments,
    }))();
  const activeThreadRef = (() => ({ environmentId, threadId }))();

  if (targets.length === 0) return null;

  return (
    <div data-history-swipe="disabled" className="flex min-h-0 flex-1 flex-col">
      <SourceControlEnvironmentChain
        targets={targets}
        links={[]}
        threadId={threadId}
        activeThreadRef={activeThreadRef}
        {...(onThreadRefChange ? { onThreadRefChange } : {})}
      />
    </div>
  );
}
