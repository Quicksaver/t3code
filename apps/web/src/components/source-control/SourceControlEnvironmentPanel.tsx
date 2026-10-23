import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useState } from "react";

import { PublishRepositoryDialog } from "../GitActionsControl";
import { SourceControlPanelView } from "./SourceControlPanelView";
import { useSourceControlPanelController } from "./useSourceControlPanelController";
import type { SourceControlPeerSyncTarget } from "./SourceControlPanel.logic";

export interface SourceControlEnvironmentPanelProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly worktreePath: string | null;
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly peerSyncTargets: readonly SourceControlPeerSyncTarget[];
  readonly onThreadRefChange?: (input: {
    readonly branch: string | null;
    readonly worktreePath: string | null;
  }) => Promise<void> | void;
}

export function SourceControlEnvironmentPanel(props: SourceControlEnvironmentPanelProps) {
  const [publishRepositoryCwd, setPublishRepositoryCwd] = useState<string | null>(null);

  return (
    <>
      <SourceControlPanelView
        controller={useSourceControlPanelController(props, setPublishRepositoryCwd)}
      />
      <PublishRepositoryDialog
        open={publishRepositoryCwd !== null}
        onOpenChange={(open) => {
          if (!open) setPublishRepositoryCwd(null);
        }}
        environmentId={props.environmentId}
        threadRef={props.activeThreadRef}
        gitCwd={publishRepositoryCwd ?? props.cwd}
      />
    </>
  );
}
