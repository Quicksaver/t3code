import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { serverEnvironment } from "~/state/server";

import { useOpenPrLink } from "~/lib/openPullRequestLink";

import { PublishRepositoryDialog } from "../GitActionsControl";
import type {
  FederatedSourceControlTarget,
  SourceControlPeerSyncTarget,
} from "./SourceControlPanel.logic";
import { sourceControlPanelStateCacheKey } from "./SourceControlPanelCache";
import {
  SourceControlPanelDialogs,
  SourceControlPanelView,
  type SourceControlEnvironmentLink,
} from "./SourceControlPanelView";
import { useSourceControlPanelController } from "./useSourceControlPanelController";

type ThreadRefChange = (input: {
  readonly branch: string | null;
  readonly worktreePath: string | null;
}) => Promise<void> | void;

export interface SourceControlEnvironmentPanelProps {
  readonly environmentId: FederatedSourceControlTarget["environmentId"];
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly worktreePath: string | null;
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly peerSyncTargets: readonly SourceControlPeerSyncTarget[];
  readonly onThreadRefChange?: ThreadRefChange;
}

interface SourceControlEnvironmentChainProps {
  readonly targets: readonly FederatedSourceControlTarget[];
  readonly links: readonly SourceControlEnvironmentLink[];
  readonly threadId: ThreadId;
  readonly activeThreadRef: ScopedThreadRef;
  readonly onThreadRefChange?: ThreadRefChange;
}

/**
 * Mounts one panel controller per environment, nesting each in the previous one so the merged
 * list receives every controller without copying state upward. A target change remounts only the
 * environments after it.
 */
export function SourceControlEnvironmentChain(props: SourceControlEnvironmentChainProps) {
  const target = props.targets[props.links.length];
  if (!target) return <SourceControlPanelView links={props.links} />;
  return (
    <SourceControlEnvironmentLinkPanel
      key={sourceControlPanelStateCacheKey({
        environmentId: target.environmentId,
        threadId: props.threadId,
        cwd: target.cwd,
        worktreePath: target.worktreePath,
      })}
      target={target}
      {...props}
    />
  );
}

function SourceControlEnvironmentLinkPanel({
  target,
  ...chain
}: SourceControlEnvironmentChainProps & { readonly target: FederatedSourceControlTarget }) {
  const [publishRepositoryCwd, setPublishRepositoryCwd] = useState<string | null>(null);
  const activeThreadRef = target.active ? chain.activeThreadRef : null;
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(target.environmentId));
  const controller = useSourceControlPanelController(
    {
      environmentId: target.environmentId,
      threadId: chain.threadId,
      cwd: target.cwd,
      worktreePath: target.worktreePath,
      activeThreadRef,
      peerSyncTargets: chain.targets.map(({ environmentId, cwd }) => ({ environmentId, cwd })),
      ...(target.active && chain.onThreadRefChange
        ? { onThreadRefChange: chain.onThreadRefChange }
        : {}),
    },
    setPublishRepositoryCwd,
  );
  const openPrLink = useOpenPrLink(activeThreadRef ?? undefined, target.environmentId);
  return (
    <>
      <SourceControlPanelDialogs controller={controller} />
      <PublishRepositoryDialog
        open={publishRepositoryCwd !== null}
        onOpenChange={(open) => {
          if (!open) setPublishRepositoryCwd(null);
        }}
        environmentId={target.environmentId}
        threadRef={activeThreadRef}
        gitCwd={publishRepositoryCwd ?? target.cwd}
        offeredProviders={serverConfig?.settings.offeredSourceControlProviders}
      />
      <SourceControlEnvironmentChain
        {...chain}
        links={[...chain.links, { target, controller, openPrLink }]}
      />
    </>
  );
}
