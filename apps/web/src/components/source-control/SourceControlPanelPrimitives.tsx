import { WorkingIndicator } from "../WorkingIndicator";
import type {
  VcsPanelCommitSummary,
  VcsPanelFileChange,
  VcsPanelStash,
  VcsRef,
} from "@t3tools/contracts";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  FolderGit2,
  GitBranch,
  GitCommit,
  GitCompare,
  Globe,
  House,
  LoaderCircle,
  RefreshCw,
  Tag,
  Target,
  Upload,
} from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { conversationItemStyles } from "../sidebar/conversationItemStyles";

import { VisualStudioCode } from "../Icons";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { ThreadHoverCard, ThreadHoverCardPopup } from "../ThreadHoverCard";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  type AttentionKind,
  type BranchSyncState,
  formatRelativeDate,
} from "./SourceControlPanel.logic";
import {
  SourceControlItemEnvironmentRows,
  type SourceControlItemEnvironment,
} from "./SourceControlItemEnvironments";
import {
  formatReadableDate,
  sumFiles,
  type WorkingTreeChangeSetView,
} from "./SourceControlPanelModel";

export function StatLabels({
  insertions,
  deletions,
}: {
  readonly insertions: number;
  readonly deletions: number;
}) {
  if (insertions === 0 && deletions === 0) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 font-mono text-xs tabular-nums">
      {insertions > 0 ? <span className="text-diff-addition-foreground">+{insertions}</span> : null}
      {deletions > 0 ? <span className="text-diff-deletion-foreground">-{deletions}</span> : null}
    </span>
  );
}

export function BranchSyncLabels({
  aheadCount,
  behindCount,
}: {
  readonly aheadCount: number;
  readonly behindCount: number;
}) {
  if (aheadCount === 0 && behindCount === 0) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-xs tabular-nums">
      {aheadCount > 0 ? <span className="text-success-foreground">↑{aheadCount}</span> : null}
      {behindCount > 0 ? <span className="text-warning-foreground">↓{behindCount}</span> : null}
    </span>
  );
}

export function branchSyncActionLabel(state: BranchSyncState): string {
  switch (state) {
    case "publish":
      return "Publish. Shift: force.";
    case "pull":
      return "Pull. Shift: reset. Option: fetch.";
    case "push":
      return "Push. Shift: force.";
    case "diverged":
      return "Sync diverged";
    case "fetch":
      return "Fetch";
  }
}

export function BranchSyncActionIcon({ state }: { readonly state: BranchSyncState }) {
  switch (state) {
    case "publish":
    case "push":
      return <Upload className="size-3.5" />;
    case "pull":
      return <Download className="size-3.5" />;
    case "diverged":
      return <GitCompare className="size-3.5" />;
    case "fetch":
      return <RefreshCw className="size-3.5" />;
  }
}

export const ATTENTION_RANK: Record<AttentionKind, number> = {
  conflicts: 0,
  diverged: 1,
  behind: 2,
  unpushed: 3,
  dirty: 4,
  stale: 5,
};

export function stashActivityTimestamp(stash: VcsPanelStash): number {
  if (!stash.createdAt) return 0;
  const time = Date.parse(stash.createdAt);
  return Number.isFinite(time) ? time : 0;
}

export function AttentionIcon({ kind }: { readonly kind: AttentionKind }) {
  switch (kind) {
    case "conflicts":
    case "diverged":
      return <AlertTriangle className="size-3.5 shrink-0 text-destructive-foreground" />;
    case "behind":
      return <Download className="size-3.5 shrink-0 text-warning-foreground" />;
    case "unpushed":
      return <Upload className="size-3.5 shrink-0 text-success-foreground" />;
    case "dirty":
      return <GitCommit className="size-3.5 shrink-0 text-warning-foreground" />;
    case "stale":
      return <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />;
  }
}

export function AuthorAvatar({
  commit,
  className,
}: {
  readonly commit: VcsPanelCommitSummary;
  readonly className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const fallbackText =
    commit.authorName
      ?.trim()
      .split(/\s+/u)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") ||
    commit.authorEmail?.trim()[0]?.toUpperCase() ||
    "?";
  const avatarClassName = cn(
    "inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-4xs font-medium text-muted-foreground object-cover",
    className,
  );
  if (!commit.authorAvatarUrl || failed) {
    return (
      <span className={avatarClassName} aria-label={commit.authorName ?? "Unknown author"}>
        {fallbackText}
      </span>
    );
  }
  return (
    <img
      alt={commit.authorName ? `${commit.authorName} avatar` : "Author avatar"}
      className={avatarClassName}
      referrerPolicy="no-referrer"
      src={commit.authorAvatarUrl}
      onError={() => setFailed(true)}
    />
  );
}

type DisplayHeadRef =
  | { readonly kind: "local"; readonly name: string; readonly synced: boolean }
  | { readonly kind: "remote"; readonly name: string };

function displayHeadRefs(
  headRefs: readonly string[],
  remoteNames: readonly string[] = [],
): DisplayHeadRef[] {
  const remoteNameSet = new Set(remoteNames);
  const remoteRefParts = (
    ref: string,
  ): { readonly remoteName: string; readonly branchName: string } | null => {
    const slashIndex = ref.indexOf("/");
    if (slashIndex <= 0) return null;
    const remoteName = ref.slice(0, slashIndex);
    if (!remoteNameSet.has(remoteName)) return null;
    const branchName = ref.slice(slashIndex + 1);
    if (branchName.length === 0 || branchName === "HEAD") return null;
    return { remoteName, branchName };
  };
  const localRefs = new Set(headRefs.filter((ref) => remoteRefParts(ref) === null));
  const remoteByBranch = new Map<string, string>();
  for (const ref of headRefs) {
    const parsed = remoteRefParts(ref);
    if (parsed) remoteByBranch.set(parsed.branchName, ref);
  }
  const refs: DisplayHeadRef[] = [...localRefs]
    .toSorted((left, right) => left.localeCompare(right))
    .map((name) => ({ kind: "local", name, synced: remoteByBranch.has(name) }));
  for (const branchName of [...remoteByBranch.keys()].toSorted((left, right) =>
    left.localeCompare(right),
  )) {
    if (!localRefs.has(branchName)) refs.push({ kind: "remote", name: branchName });
  }
  return refs;
}

export function SyncedIcon({ className }: { readonly className?: string }) {
  return <Target className={cn("size-3 shrink-0", className)} aria-label="Synced upstream" />;
}

const BRANCH_MARKERS = {
  current: { Icon: Check, label: "Current branch" },
  default: { Icon: House, label: "Default branch" },
  upstream: { Icon: Globe, label: "Upstream" },
  worktree: { Icon: FolderGit2, label: "Worktree" },
} as const;

/** An icon standing in for a branch label; the item's hover card explains it. */
export function BranchMarkerIcon({ kind }: { readonly kind: keyof typeof BRANCH_MARKERS }) {
  const { Icon, label } = BRANCH_MARKERS[kind];
  return <Icon aria-label={label} className="size-3.5 shrink-0 text-icon-muted" />;
}

export function CompactBadge({ children }: { readonly children: ReactNode }) {
  return (
    <Badge size="sm" variant="outline">
      {children}
    </Badge>
  );
}

export function RefLabels({
  commit,
  remoteNames,
}: {
  readonly commit: VcsPanelCommitSummary;
  readonly remoteNames?: readonly string[] | undefined;
}) {
  const headRefs = displayHeadRefs(commit.headRefs, remoteNames);
  if (headRefs.length === 0 && commit.tags.length === 0) return null;
  return (
    <span className="inline-flex min-w-0 shrink-0 items-center gap-1">
      {headRefs.map((ref) => (
        <CompactBadge key={`head:${ref.kind}:${ref.name}`}>
          <span className="inline-flex items-center gap-0.5">
            {ref.kind === "remote" || (ref.kind === "local" && ref.synced) ? <SyncedIcon /> : null}
            <span>{ref.name}</span>
          </span>
        </CompactBadge>
      ))}
      {commit.tags.map((tag) => (
        <CompactBadge key={`tag:${tag}`}>
          <span className="inline-flex items-center gap-0.5">
            <Tag className="size-3 shrink-0" />
            <span>{tag}</span>
          </span>
        </CompactBadge>
      ))}
    </span>
  );
}

export function CommitTooltip({
  commit,
  remoteNames,
}: {
  readonly commit: VcsPanelCommitSummary;
  readonly remoteNames?: readonly string[] | undefined;
}) {
  const relativeDate = formatRelativeDate(commit.authoredAt);
  const readableDate = formatReadableDate(commit.authoredAt);
  const stats = commit.fileStats ?? sumFiles(commit.files);
  return (
    <ThreadHoverCard title={commit.message} wrapTitle>
      <div className="flex min-w-0 items-center gap-2">
        <AuthorAvatar commit={commit} className="size-6" />
        <div className="min-w-0">
          <div className="truncate font-medium">{commit.authorName ?? "Unknown author"}</div>
          <div className="truncate font-mono">{commit.shortSha}</div>
        </div>
      </div>
      {relativeDate || readableDate ? (
        <div className="text-muted-foreground">
          {relativeDate ?? "Unknown time"}
          {readableDate ? ` (${readableDate})` : null}
        </div>
      ) : null}
      {commit.fileStats || !commit.filesDeferred ? (
        <StatLabels insertions={stats.insertions} deletions={stats.deletions} />
      ) : null}
      <RefLabels commit={commit} remoteNames={remoteNames} />
    </ThreadHoverCard>
  );
}

function fileTooltipAnchor(trigger: HTMLElement | null) {
  if (!trigger) return null;
  const panel = trigger.closest<HTMLElement>("[data-source-control-tooltip-boundary]");
  if (!panel) return trigger;
  return {
    contextElement: trigger,
    getBoundingClientRect: () => {
      const triggerRect = trigger.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      const left = panelRect.left + 8;
      return DOMRect.fromRect({
        x: left,
        y: triggerRect.top,
        width: Math.max(0, triggerRect.right - left),
        height: triggerRect.height,
      });
    },
  };
}

function TooltipMetadataRow({
  label,
  value,
}: {
  readonly label: ReactNode;
  readonly value: string;
}) {
  return (
    <div className="grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] items-start gap-x-1.5 text-muted-foreground">
      <span className="inline-flex h-4 items-center">{label}</span>
      <span className="min-w-0 break-all leading-4 text-foreground/75">{value}</span>
    </div>
  );
}

function FilePathTooltip({
  file,
  anchor,
}: {
  readonly file: VcsPanelFileChange;
  readonly anchor: () => ReturnType<typeof fileTooltipAnchor>;
}) {
  return (
    <ThreadHoverCardPopup sideOffset={8} anchor={anchor} side="left" align="start">
      <ThreadHoverCard title={file.path} wrapTitle>
        {file.originalPath && file.originalPath !== file.path ? (
          <TooltipMetadataRow label="Renamed from" value={file.originalPath} />
        ) : null}
        <StatLabels insertions={file.insertions} deletions={file.deletions} />
      </ThreadHoverCard>
    </ThreadHoverCardPopup>
  );
}

export function WorkingFileTooltipRow({
  children,
  file,
  onContextMenu,
  onToggle,
  selected,
  expanded,
}: {
  readonly children: ReactNode;
  readonly file: VcsPanelFileChange;
  readonly onContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => void;
  readonly onToggle: () => void;
  readonly selected: boolean;
  readonly expanded: boolean;
}) {
  const triggerRef = useRef<HTMLDivElement>(null);
  const tooltipAnchor = () => fileTooltipAnchor(triggerRef.current);
  return (
    <Tooltip preserveOnNestedTriggerHover>
      <TooltipTrigger
        render={
          <div
            ref={triggerRef}
            role="button"
            tabIndex={0}
            data-file-change-tooltip-anchor
            aria-expanded={expanded}
            data-selected={selected}
            className={cn(
              conversationItemStyles.surface,
              expanded
                ? conversationItemStyles.active
                : selected
                  ? conversationItemStyles.idle
                  : conversationItemStyles.receded,
              "group flex h-9 min-w-0 items-center gap-1.5 px-2.5",
            )}
            onClick={onToggle}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              onToggle();
            }}
            onContextMenu={onContextMenu}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <FilePathTooltip file={file} anchor={tooltipAnchor} />
    </Tooltip>
  );
}

export function fileStatusLetter(status: VcsPanelFileChange["status"]): string {
  switch (status) {
    case "added":
    case "untracked":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "copied":
      return "C";
    case "conflicted":
      return "U";
    case "modified":
      return "M";
  }
}

export function fileStatusColor(status: VcsPanelFileChange["status"]): string {
  switch (status) {
    case "added":
    case "untracked":
      return "text-[color:var(--diff-added-icon,var(--diff-addition-foreground))]";
    case "deleted":
      return "text-diff-deletion-foreground";
    case "conflicted":
      return "text-error-foreground";
    default:
      return "text-(--diff-modified-icon)";
  }
}

export function FileChangeTooltipRow({
  expanded,
  file,
  onFileContextMenu,
  onFileToggle,
  onOpenFile,
  onOpenInVsCode,
}: {
  readonly expanded: boolean;
  readonly file: VcsPanelFileChange;
  readonly onFileContextMenu?:
    | ((event: ReactMouseEvent<HTMLDivElement>, file: VcsPanelFileChange) => void)
    | undefined;
  readonly onFileToggle?: ((file: VcsPanelFileChange) => void) | undefined;
  readonly onOpenFile?: ((file: VcsPanelFileChange) => void) | undefined;
  readonly onOpenInVsCode?: ((file: VcsPanelFileChange) => void) | undefined;
}) {
  const triggerRef = useRef<HTMLDivElement>(null);
  const tooltipAnchor = () => fileTooltipAnchor(triggerRef.current);
  return (
    <Tooltip preserveOnNestedTriggerHover>
      <TooltipTrigger
        render={
          <div
            ref={triggerRef}
            role={onFileToggle ? "button" : undefined}
            tabIndex={onFileToggle ? 0 : undefined}
            data-file-change-tooltip-anchor
            aria-expanded={onFileToggle ? expanded : undefined}
            className={cn(
              conversationItemStyles.surface,
              expanded ? conversationItemStyles.active : conversationItemStyles.receded,
              "group flex h-9 min-w-0 items-center gap-1.5 px-2.5",
            )}
            onClick={onFileToggle ? () => onFileToggle(file) : undefined}
            onKeyDown={
              onFileToggle
                ? (event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    onFileToggle(file);
                  }
                : undefined
            }
            onContextMenu={
              onFileContextMenu ? (event) => onFileContextMenu(event, file) : undefined
            }
          />
        }
      >
        {onFileToggle ? (
          expanded ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          )
        ) : null}
        <span
          className={cn(
            "w-3 shrink-0 text-center text-3xs font-semibold uppercase",
            fileStatusColor(file.status),
          )}
        >
          {fileStatusLetter(file.status)}
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            expanded ? conversationItemStyles.title : conversationItemStyles.readTitle,
          )}
        >
          {file.path}
        </span>
        <StatLabels insertions={file.insertions} deletions={file.deletions} />
        {onOpenFile || onOpenInVsCode ? (
          <RowActions>
            {onOpenFile ? (
              <IconButton label="Open file" onClick={() => onOpenFile(file)}>
                <FileText className="size-3.5" />
              </IconButton>
            ) : null}
            {onOpenInVsCode ? (
              <IconButton label="Open in VS Code" onClick={() => onOpenInVsCode(file)}>
                <VisualStudioCode className="size-3.5" />
              </IconButton>
            ) : null}
          </RowActions>
        ) : null}
      </TooltipTrigger>
      <FilePathTooltip file={file} anchor={tooltipAnchor} />
    </Tooltip>
  );
}

export function BranchTooltip({
  branch,
  displayName,
  aheadCount,
  behindCount,
  environments = [],
}: {
  readonly branch: VcsRef;
  readonly displayName: string;
  readonly aheadCount: number;
  readonly behindCount: number;
  readonly environments?: readonly SourceControlItemEnvironment[] | undefined;
}) {
  const relativeDate = formatRelativeDate(branch.lastActivityAt);
  const readableDate = formatReadableDate(branch.lastActivityAt);
  return (
    <ThreadHoverCardPopup sideOffset={8} side="left" align="start">
      <ThreadHoverCard title={displayName} wrapTitle>
        {branch.name !== displayName ? (
          <TooltipMetadataRow label="Ref" value={branch.name} />
        ) : null}
        {branch.upstreamName ? (
          <TooltipMetadataRow
            label={<BranchMarkerIcon kind="upstream" />}
            value={branch.upstreamName}
          />
        ) : null}
        {branch.worktreePath ? (
          <TooltipMetadataRow
            label={<BranchMarkerIcon kind="worktree" />}
            value={branch.worktreePath}
          />
        ) : null}
        {branch.current || branch.isDefault || aheadCount > 0 || behindCount > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {branch.current ? <BranchMarkerIcon kind="current" /> : null}
            {branch.isDefault ? <BranchMarkerIcon kind="default" /> : null}
            <BranchSyncLabels aheadCount={aheadCount} behindCount={behindCount} />
          </div>
        ) : null}
        <SourceControlItemEnvironmentRows environments={environments} />
        {relativeDate || readableDate ? (
          <div>
            {relativeDate ?? "Unknown time"}
            {readableDate ? ` (${readableDate})` : null}
          </div>
        ) : null}
      </ThreadHoverCard>
    </ThreadHoverCardPopup>
  );
}

export function WorkingTreeTooltip({
  changeSet,
  environments = [],
}: {
  readonly changeSet: WorkingTreeChangeSetView;
  readonly environments?: readonly SourceControlItemEnvironment[] | undefined;
}) {
  const stats = sumFiles(changeSet.files);
  return (
    <ThreadHoverCardPopup sideOffset={8} side="left" align="start">
      <ThreadHoverCard title={changeSet.current ? "Working tree" : "Sibling working tree"}>
        <TooltipMetadataRow label="Branch" value={changeSet.branchName ?? "Detached HEAD"} />
        <TooltipMetadataRow
          label={<BranchMarkerIcon kind="worktree" />}
          value={changeSet.worktreePath ?? changeSet.cwd}
        />
        <div className="flex flex-wrap items-center gap-1.5">
          <span>{changeSet.files.length === 1 ? "1 file" : `${changeSet.files.length} files`}</span>
          <StatLabels insertions={stats.insertions} deletions={stats.deletions} />
        </div>
        <SourceControlItemEnvironmentRows environments={environments} />
      </ThreadHoverCard>
    </ThreadHoverCardPopup>
  );
}

export function StashTooltip({
  stash,
  branchName,
  environments = [],
}: {
  readonly stash: VcsPanelStash;
  readonly branchName: string | null;
  readonly environments?: readonly SourceControlItemEnvironment[] | undefined;
}) {
  const relativeDate = formatRelativeDate(stash.createdAt);
  const readableDate = formatReadableDate(stash.createdAt);
  return (
    <ThreadHoverCardPopup sideOffset={8} side="left" align="start">
      <ThreadHoverCard title={stash.message} wrapTitle>
        <div>
          Ref <span className="text-foreground/75">{stash.refName}</span>
        </div>
        {branchName ? <TooltipMetadataRow label="Branch" value={branchName} /> : null}
        <SourceControlItemEnvironmentRows environments={environments} />
        {relativeDate || readableDate ? (
          <div>
            {relativeDate ?? "Unknown time"}
            {readableDate ? ` (${readableDate})` : null}
          </div>
        ) : null}
      </ThreadHoverCard>
    </ThreadHoverCardPopup>
  );
}

export function IconButton({
  label,
  size = "icon-xs",
  children,
  disabled,
  destructive,
  loading,
  onClick,
}: {
  readonly label: string;
  readonly size?: "icon-xs" | "icon-sm";
  readonly children: ReactNode;
  readonly disabled?: boolean;
  readonly destructive?: boolean;
  readonly loading?: boolean;
  readonly onClick?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size={size}
            variant={destructive ? "ghost-destructive" : "ghost"}
            aria-label={label}
            aria-busy={loading || undefined}
            disabled={disabled || loading}
            onClick={onClick}
          >
            {loading ? <LoaderCircle className="size-3.5 animate-spin" /> : children}
          </Button>
        }
      />
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

export function RowActions({
  children,
  activityLabel,
}: {
  readonly children: ReactNode;
  readonly activityLabel?: string | null | undefined;
}) {
  if (activityLabel) {
    return (
      <div className="absolute right-1 top-1/2 z-10 -translate-y-1/2 rounded bg-sidebar">
        <WorkingIndicator label={activityLabel} />
      </div>
    );
  }
  return (
    <div
      className="pointer-events-none absolute right-1 top-1/2 z-10 flex -translate-y-1/2 items-center gap-0.5 rounded bg-sidebar opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {children}
    </div>
  );
}
