import {
  type EnvironmentId,
  type ScopedThreadRef,
  type ToolActivityIcon,
} from "@t3tools/contracts";
import {
  resolveWorkEntryToolPresentation,
  resolveViewedImageAsset,
  workEntryViewedImagePath,
} from "@t3tools/client-runtime/work-log/presentation";
import type { AgentPanelModel } from "@t3tools/client-runtime/state/subagentRuntime";
import { formatSubagentTokenCount } from "@t3tools/client-runtime/state/subagentRuntime";
import { toolActivityFaviconUrl } from "@t3tools/shared/favicon";
import { getProjectFaviconCacheKey } from "@t3tools/shared/projectFavicon";
import {
  createContext,
  memo,
  use,
  useId,
  useState,
  type ContextType,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  BotIcon,
  BrainIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  EyeIcon,
  GlobeIcon,
  HammerIcon,
  MessageCircleIcon,
  SearchIcon,
  SquarePenIcon,
  TerminalIcon,
  WrenchIcon,
  XIcon,
  ZapIcon,
} from "lucide-react";
import {
  workEntryDisplayIndicatesToolFailure,
  workEntrySignalsSevereFailure,
  workLogEntryIsToolLike,
} from "../../session-logic";
import { useAssetUrlState } from "../../assets/assetUrls";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import { ChatMarkdownAssetImage } from "../ChatMarkdown";
import { T3Wordmark } from "../T3Wordmark";
import { cn } from "~/lib/utils";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import {
  liveWorkEntryLabel,
  toolGroupAction,
  workEntryDisplayLabel,
  type MessagesTimelineRow,
} from "./MessagesTimeline.logic";
import { deriveAgentSpawnSummary } from "./agentSpawnSummary";

type TimelineRow = MessagesTimelineRow;
type TimelineWorkEntry = Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"][number];

const WorkGroupViewCtx = createContext<{
  state: { expandedEntries: Set<string> };
  onToggleEntry: () => void;
} | null>(null);

export function WorkGroupViewProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: NonNullable<ContextType<typeof WorkGroupViewCtx>>;
}) {
  return <WorkGroupViewCtx value={value}>{children}</WorkGroupViewCtx>;
}

interface WorkActivityRowsContextValue {
  activeThreadEnvironmentId: EnvironmentId;
  agentPanelModel: AgentPanelModel;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onOpenAgents: () => void;
  onToggleWorkGroup: (groupId: string, anchorKey: string) => void;
  resolvedTheme: "light" | "dark";
  threadRef: ScopedThreadRef | null;
  workspaceRoot: string | undefined;
}

const WorkActivityRowsCtx = createContext<WorkActivityRowsContextValue>(null!);

export function WorkActivityRowsProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: WorkActivityRowsContextValue;
}) {
  return <WorkActivityRowsCtx value={value}>{children}</WorkActivityRowsCtx>;
}

export function ActivityShimmerOverlay({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden
      className="live-activity-focus pointer-events-none absolute inset-y-0 select-none"
    >
      <span className="live-activity-focus-counter block">
        <span className="live-activity-focus-aligned block text-foreground">{children}</span>
      </span>
    </span>
  );
}

const failedToolIconClassName = "text-tool-error-icon/40";

/** Image icons and the gradient computer-use mark cannot take a currentColor
 *  tint, so failed rows using them get a trailing x instead. */
function toolIconAcceptsTint(
  iconName: WorkEntryIconName,
  toolIcon: ToolActivityIcon | undefined,
): boolean {
  return toolIcon === undefined && iconName !== "computer";
}

export function LiveActivityRow({
  label,
  iconName,
  toolIcon,
  failed = false,
}: {
  label: string;
  iconName?: WorkEntryIconName;
  toolIcon?: ToolActivityIcon | undefined;
  failed?: boolean;
}) {
  return (
    <div className="relative min-h-6 w-fit max-w-full min-w-0 overflow-hidden rounded-md text-sm leading-relaxed">
      <LiveActivityContent
        label={label}
        iconName={iconName}
        toolIcon={toolIcon}
        failed={failed}
        announceFailure={failed}
      />
      <ActivityShimmerOverlay>
        <LiveActivityContent
          label={label}
          iconName={iconName}
          toolIcon={toolIcon}
          failed={failed}
          highlighted
        />
      </ActivityShimmerOverlay>
    </div>
  );
}

function LiveActivityContent({
  label,
  iconName,
  toolIcon,
  failed = false,
  announceFailure = false,
  highlighted = false,
}: {
  label: string;
  iconName: WorkEntryIconName | undefined;
  toolIcon?: ToolActivityIcon | undefined;
  failed?: boolean;
  announceFailure?: boolean;
  highlighted?: boolean;
}) {
  const showTrailingFailureMark =
    failed && iconName !== undefined && !toolIconAcceptsTint(iconName, toolIcon);

  return (
    <span
      className={cn(
        "flex min-h-6 min-w-0 items-center gap-1.5 py-0.5",
        iconName ? "px-0.5" : "px-1",
        highlighted ? "text-foreground" : "text-secondary-label",
      )}
    >
      {iconName ? (
        <span
          className={cn(
            "flex size-6 shrink-0 items-center justify-center",
            highlighted ? "text-foreground" : failed ? failedToolIconClassName : "text-icon-muted",
          )}
          role={announceFailure ? "img" : undefined}
          aria-label={announceFailure ? "Tool call failed" : undefined}
        >
          <ToolActivityIconView
            icon={toolIcon}
            fallbackName={iconName}
            className="block size-4 shrink-0 stroke-[1.8]"
            muted={!highlighted}
          />
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {showTrailingFailureMark ? (
        <XIcon
          aria-hidden
          className={cn("size-3 shrink-0", !highlighted && failedToolIconClassName)}
        />
      ) : null}
    </span>
  );
}

export function LiveWorkEntryTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "work-live" }>;
}) {
  const ctx = use(WorkActivityRowsCtx);
  const label = liveWorkEntryLabel(row.entry, ctx.workspaceRoot, row.active);
  const failed = workEntryDisplayIndicatesToolFailure(row.entry);

  return (
    <button
      type="button"
      className="group/live-work flex min-h-6 w-full max-w-full cursor-pointer items-center rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      aria-label={failed ? `${label}, tool call failed` : undefined}
      aria-expanded={row.expanded}
      onClick={() => ctx.onToggleWorkGroup(row.groupId, row.id)}
    >
      {row.active ? (
        <LiveActivityRow
          label={label}
          iconName={workEntryIconName(row.entry)}
          toolIcon={row.entry.toolIcon ?? row.entry.toolSource?.icon}
          failed={failed}
        />
      ) : (
        <div className="min-h-6 w-fit max-w-full min-w-0 overflow-hidden rounded-md text-sm leading-relaxed">
          <LiveActivityContent
            label={label}
            iconName={workEntryIconName(row.entry)}
            toolIcon={row.entry.toolIcon ?? row.entry.toolSource?.icon}
            failed={failed}
            announceFailure={failed}
          />
        </div>
      )}
    </button>
  );
}

function toolGroupSummaryIconName(
  kind: Extract<TimelineRow, { kind: "work-toggle" }>["summaryKind"],
): WorkEntryIconName {
  switch (kind) {
    case "read":
      return "eye";
    case "edit":
      return "square-pen";
    case "command":
      return "terminal";
    case "browser":
      return "browser";
    case "search":
      return "globe";
    case "code-search":
      return "search";
    case "other":
      return "wrench";
    case "dynamic-tool":
      return "hammer";
    case "agent-tool":
      return "bot";
    case "tone-tool":
      return "zap";
    case "update":
    case "mixed":
      return "hammer";
  }
}

export function WorkGroupToggleTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "work-toggle" }>;
}) {
  const ctx = use(WorkActivityRowsCtx);
  return (
    <button
      type="button"
      className="group/tool-group flex min-h-6 w-full cursor-pointer items-center gap-1.5 rounded-md px-0.5 py-0.5 text-left text-sm leading-relaxed transition-colors duration-150 hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      aria-label={row.hasFailure ? `${row.summary}, tool call failed` : undefined}
      aria-expanded={row.expanded}
      onClick={() => ctx.onToggleWorkGroup(row.groupId, row.id)}
    >
      <span className="flex size-6 shrink-0 items-center justify-center text-icon-muted">
        <ToolActivityIconView
          icon={row.toolIcon}
          fallbackName={
            row.summaryToolIcon ?? row.toolSurface ?? toolGroupSummaryIconName(row.summaryKind)
          }
          className="size-4 shrink-0 stroke-[1.8]"
          muted
        />
      </span>
      <span className="min-w-0 flex-1 truncate text-secondary-label">{row.summary}</span>
    </button>
  );
}

type WorkEntryIconName =
  | "bot"
  | "brain"
  | "browser"
  | "check"
  | "circle-alert"
  | "computer"
  | "eye"
  | "globe"
  | "hammer"
  | "message-circle"
  | "search"
  | "square-pen"
  | "terminal"
  | "t3-code"
  | "wrench"
  | "x"
  | "zap";

function BrowserAppIcon({ className }: { className: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M8.5 19H7.2C4.4 19 3 17.5 3 14.6V7.4C3 4.5 4.5 3 7.4 3h8.2C18.5 3 20 4.5 20 7.4v2.4" />
      <circle cx="7.4" cy="7.2" r="0.75" fill="currentColor" stroke="none" />
      <path d="M11.2 7.2h4.3" />
      <path d="m12.4 11.4 7.5 2.6-3.4 1.6-1.5 3.6z" fill="currentColor" stroke="none" />
    </svg>
  );
}

function ComputerUseAppIcon({ className }: { className: string }) {
  const gradientId = `${useId().replaceAll(":", "")}-computer-use-app-gradient`;
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <defs>
        <linearGradient id={gradientId} x1="2" y1="2" x2="22" y2="22">
          <stop offset="0" stopColor="#00dff0" />
          <stop offset="0.42" stopColor="#3b9cff" />
          <stop offset="0.72" stopColor="#b044f5" />
          <stop offset="1" stopColor="#ff78b6" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="22" height="22" rx="5" fill={`url(#${gradientId})`} />
      <path
        d="m7.2 6.2 10.5 4.1-4.2 2.1-2 4.7z"
        fill="white"
        stroke="#315cff"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ToolActivityIconView(props: {
  icon: ToolActivityIcon | undefined;
  fallbackName: WorkEntryIconName;
  className: string;
  muted: boolean;
}) {
  const { resolvedTheme } = use(WorkActivityRowsCtx);
  const fallbackClassName = cn(props.className, props.muted && "opacity-70 light:brightness-[.6]");
  if (!props.icon) {
    return <WorkEntryIcon name={props.fallbackName} className={fallbackClassName} />;
  }
  if (props.icon._tag === "website") {
    const src = toolActivityFaviconUrl(props.icon, resolvedTheme, 32);
    return src ? (
      <ToolActivityImageIcon
        key={src}
        cacheKey={src}
        src={src}
        fallbackName={props.fallbackName}
        className={props.className}
        muted={props.muted}
      />
    ) : (
      <WorkEntryIcon name={props.fallbackName} className={fallbackClassName} />
    );
  }
  if (props.icon._tag === "themed-logo") {
    const src =
      resolvedTheme === "dark"
        ? (props.icon.logoUrlDark ?? props.icon.logoUrl)
        : props.icon.logoUrl;
    return (
      <ToolActivityImageIcon
        key={src}
        cacheKey={src}
        src={src}
        fallbackName={props.fallbackName}
        className={props.className}
        muted={props.muted}
      />
    );
  }
  return (
    <NativeAppToolActivityIcon
      app={props.icon.app}
      fallbackName={props.fallbackName}
      className={props.className}
      muted={props.muted}
    />
  );
}

function NativeAppToolActivityIcon(props: {
  app: Extract<ToolActivityIcon, { readonly _tag: "native-app" }>["app"];
  fallbackName: WorkEntryIconName;
  className: string;
  muted: boolean;
}) {
  const { activeThreadEnvironmentId } = use(WorkActivityRowsCtx);
  const asset = useAssetUrlState(activeThreadEnvironmentId, {
    _tag: "native-app-icon",
    app: props.app,
  });
  if (asset._tag !== "Success") {
    return (
      <WorkEntryIcon
        name={props.fallbackName}
        className={cn(props.className, props.muted && "opacity-70 light:brightness-[.6]")}
      />
    );
  }
  const cacheKey = getProjectFaviconCacheKey(
    activeThreadEnvironmentId,
    JSON.stringify(props.app),
    asset.url,
  );
  return (
    <ToolActivityImageIcon
      key={cacheKey}
      cacheKey={cacheKey}
      src={asset.url}
      fallbackName={props.fallbackName}
      className={props.className}
      muted={props.muted}
    />
  );
}

const loadedToolActivityIconSrcs = new Map<string, string>();

function ToolActivityImageIcon(props: {
  cacheKey: string;
  src: string;
  fallbackName: WorkEntryIconName;
  className: string;
  muted: boolean;
}) {
  const [displayedSrc, setDisplayedSrc] = useState<string | null>(
    () => loadedToolActivityIconSrcs.get(props.cacheKey) ?? null,
  );
  const isLoading = displayedSrc !== props.src;
  const handleLoadError = (failedSrc: string) => {
    if (loadedToolActivityIconSrcs.get(props.cacheKey) === failedSrc) {
      loadedToolActivityIconSrcs.delete(props.cacheKey);
    }
    setDisplayedSrc((currentSrc) => (currentSrc === failedSrc ? null : currentSrc));
  };
  return (
    <>
      {displayedSrc === null ? (
        <WorkEntryIcon
          name={props.fallbackName}
          className={cn(props.className, props.muted && "opacity-70 light:brightness-[.6]")}
        />
      ) : null}
      {displayedSrc ? (
        <span
          className={cn(
            props.className,
            "inline-block overflow-hidden rounded-[3px] bg-background",
            props.muted && "opacity-70",
          )}
        >
          <img
            src={displayedSrc}
            alt=""
            aria-hidden
            decoding="async"
            referrerPolicy="no-referrer"
            className={cn("block size-full object-contain", props.muted && "light:brightness-[.6]")}
            onError={() => handleLoadError(displayedSrc)}
          />
        </span>
      ) : null}
      {isLoading ? (
        <img
          src={props.src}
          alt=""
          aria-hidden
          decoding="async"
          referrerPolicy="no-referrer"
          className="hidden"
          onLoad={() => {
            loadedToolActivityIconSrcs.set(props.cacheKey, props.src);
            setDisplayedSrc(props.src);
          }}
          onError={() => handleLoadError(props.src)}
        />
      ) : null}
    </>
  );
}

function WorkEntryIcon({ name, className }: { name: WorkEntryIconName; className: string }) {
  switch (name) {
    case "bot":
      return <BotIcon className={className} aria-hidden />;
    case "brain":
      return <BrainIcon className={className} aria-hidden />;
    case "browser":
      return <BrowserAppIcon className={className} />;
    case "computer":
      return <ComputerUseAppIcon className={className} />;
    case "t3-code":
      return <T3Wordmark className={className} aria-hidden />;
    case "check":
      return <CheckIcon className={className} aria-hidden />;
    case "circle-alert":
      return <CircleAlertIcon className={className} aria-hidden />;
    case "eye":
      return <EyeIcon className={className} aria-hidden />;
    case "globe":
      return <GlobeIcon className={className} aria-hidden />;
    case "hammer":
      return <HammerIcon className={className} aria-hidden />;
    case "message-circle":
      return <MessageCircleIcon className={className} aria-hidden />;
    case "search":
      return <SearchIcon className={className} aria-hidden />;
    case "square-pen":
      return <SquarePenIcon className={className} aria-hidden />;
    case "terminal":
      return <TerminalIcon className={className} aria-hidden />;
    case "wrench":
      return <WrenchIcon className={className} aria-hidden />;
    case "x":
      return <XIcon className={className} aria-hidden />;
    case "zap":
      return <ZapIcon className={className} aria-hidden />;
  }
}

function workToneIcon(tone: TimelineWorkEntry["tone"]): {
  iconName: WorkEntryIconName;
  className: string;
} {
  if (tone === "error") {
    return {
      iconName: "circle-alert",
      className: "text-foreground",
    };
  }
  if (tone === "thinking") {
    return {
      iconName: "brain",
      className: "text-foreground",
    };
  }
  if (tone === "info") {
    return {
      iconName: "check",
      className: "text-icon-muted",
    };
  }
  return {
    iconName: "zap",
    className: "text-foreground",
  };
}

function workEntryRawCommand(
  workEntry: Pick<TimelineWorkEntry, "command" | "rawCommand">,
): string | null {
  const rawCommand = workEntry.rawCommand?.trim();
  if (!rawCommand || !workEntry.command) {
    return null;
  }
  return rawCommand === workEntry.command.trim() ? null : rawCommand;
}

function buildToolCallExpandedBody(
  workEntry: TimelineWorkEntry,
  workspaceRoot: string | undefined,
  visibleLabel: string,
  viewedImagePath: string | null,
): string | null {
  const blocks: string[] = [];
  const seen = new Set<string>();
  const addBlock = (value: string | null | undefined) => {
    const text = value?.trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    blocks.push(text);
  };
  if (workEntry.itemType === "mcp_tool_call" && workEntry.toolData !== undefined) {
    addBlock(`MCP call\n${JSON.stringify(workEntry.toolData, null, 2)}`);
  }
  const command = workEntry.command?.trim();
  const raw = workEntryRawCommand(workEntry);
  if (command === visibleLabel.trim()) {
    seen.add(command);
  } else {
    addBlock(raw ?? command);
  }
  const detail = workEntry.detail?.trim();
  if (detail !== viewedImagePath?.trim()) {
    addBlock(detail);
  }
  const viewedImagePaths = new Set(
    viewedImagePath
      ? [viewedImagePath.trim(), formatWorkspaceRelativePath(viewedImagePath, workspaceRoot)]
      : [],
  );
  const changedFiles = (workEntry.changedFiles ?? []).flatMap((filePath) => {
    const formattedPath = formatWorkspaceRelativePath(filePath, workspaceRoot);
    return viewedImagePaths.has(filePath) ||
      viewedImagePaths.has(formattedPath) ||
      filePath.trim() === detail ||
      formattedPath === detail
      ? []
      : [formattedPath];
  });
  if (changedFiles.length > 0) {
    addBlock([...new Set(changedFiles)].join("\n"));
  }
  return blocks.length > 0 ? blocks.join("\n\n") : null;
}

const toolCallExpandedBodyClassName =
  "max-h-64 cursor-text overflow-auto whitespace-pre-wrap break-words font-mono text-secondary-label text-[length:var(--font-size-code,0.6875rem)] leading-relaxed select-text";

function workEntryIconName(workEntry: TimelineWorkEntry): WorkEntryIconName {
  if (
    workEntry.sourceActivityKind === "user-input.requested" ||
    workEntry.sourceActivityKind === "user-input.resolved"
  ) {
    return "message-circle";
  }
  if (workEntry.toolSurface) return workEntry.toolSurface;
  const toolPresentation = resolveWorkEntryToolPresentation(workEntry);
  if (toolPresentation) return toolPresentation.icon;
  const action = toolGroupAction(workEntry);
  if (action !== "other") return toolGroupSummaryIconName(action);

  switch (workEntry.itemType) {
    case "mcp_tool_call":
      return "wrench";
    case "dynamic_tool_call":
      return "hammer";
    case "collab_agent_tool_call":
      return "bot";
  }

  // Subagent lifecycle rows (grouped by taskId) get agent identity chrome.
  if (workEntry.taskId) {
    return "bot";
  }

  return workToneIcon(workEntry.tone).iconName;
}

const stopRowToggle = (e: { stopPropagation: () => void }) => e.stopPropagation();

/**
 * A1 spawn CTA: one anchored row per workflow run (or per-turn direct-spawn
 * batch). Live status is derived from the shared agent panel model at render
 * time — the row itself never re-renders a roster; the Agents panel is the
 * only roster. Freezes to past tense when every member settles. Static dot,
 * no animation.
 */
const AgentSpawnCtaRow = memo(function AgentSpawnCtaRow(props: { workEntry: TimelineWorkEntry }) {
  const { workEntry } = props;
  const { agentPanelModel, onOpenAgents } = use(WorkActivityRowsCtx);
  const spawn = workEntry.agentSpawn;
  if (!spawn) {
    return null;
  }

  const memberIds = new Set(spawn.agentTaskIds);
  const workflowGroup = spawn.workflowId
    ? agentPanelModel.workflows.find((group) => group.workflow.id === spawn.workflowId)
    : undefined;
  const agents = workflowGroup
    ? [...workflowGroup.phases.flatMap((phase) => phase.members), ...workflowGroup.unphasedMembers]
    : agentPanelModel.directAgents.filter((agent) => memberIds.has(agent.id));
  const agentCount = Math.max(
    agents.length,
    Math.max(memberIds.size - (spawn.workflowId ? 1 : 0), 0),
  );

  const summary = deriveAgentSpawnSummary({
    agents,
    agentCount,
    coordinatorStatus: workflowGroup?.workflow.status,
  });
  const { live, lead } = summary;
  // Same rule as the panel footer: providers may aggregate member usage into
  // the coordinator, so count the coordinator only when no members exist.
  const totalTokens = agents.reduce(
    (sum, agent) => sum + (agent.usage?.totalTokens ?? 0),
    spawn.workflowId && agents.length === 0 ? (workflowGroup?.workflow.usage?.totalTokens ?? 0) : 0,
  );

  const livePhase = workflowGroup?.phases.find((phase) => phase.state === "running");
  const workflowName =
    workflowGroup?.workflow.workflowName ?? workflowGroup?.workflow.title ?? null;

  const dotClass = {
    working: "bg-info",
    failed: "bg-destructive",
    completed: "bg-success",
    inactive: "bg-muted-foreground/50",
  }[summary.tone];
  const status =
    live && livePhase ? `${livePhase.title} · ${livePhase.activeCount} working` : summary.status;

  return (
    <button
      type="button"
      onClick={onOpenAgents}
      className="flex w-full items-center gap-2 rounded-md border border-border/60 bg-card/50 px-2.5 py-1.5 text-left text-[13px] transition hover:bg-accent/50"
    >
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", dotClass)} />
      <WorkEntryIcon name="bot" className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate">
        <span className="font-medium">{lead}</span>
        {workflowName ? <span className="text-muted-foreground"> · {workflowName}</span> : null}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[.7rem] text-muted-foreground">
        <span>{status}</span>
        {totalTokens > 0 ? (
          <span className="tabular-nums">Σ {formatSubagentTokenCount(totalTokens)}</span>
        ) : null}
        <span className="text-info-foreground">{live ? "Open Agents ▸" : "View ▸"}</span>
      </span>
    </button>
  );
});

export const SimpleWorkEntryRow = memo(function SimpleWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  workspaceRoot: string | undefined;
  isExpandedToolGroupEntry: boolean;
  displayLabel?: string | undefined;
}) {
  const { workEntry, workspaceRoot, isExpandedToolGroupEntry, displayLabel } = props;
  // Before any hooks: spawn CTA rows render their own component.
  if (workEntry.agentSpawn) {
    return <AgentSpawnCtaRow workEntry={workEntry} />;
  }
  return (
    <PlainWorkEntryRow
      workEntry={workEntry}
      workspaceRoot={workspaceRoot}
      isExpandedToolGroupEntry={isExpandedToolGroupEntry}
      displayLabel={displayLabel}
    />
  );
});

const PlainWorkEntryRow = memo(function PlainWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  workspaceRoot: string | undefined;
  isExpandedToolGroupEntry: boolean;
  displayLabel?: string | undefined;
}) {
  const { workEntry, workspaceRoot, isExpandedToolGroupEntry, displayLabel } = props;
  const { threadRef, onImageExpand } = use(WorkActivityRowsCtx);
  const groupView = use(WorkGroupViewCtx);
  const [expanded, setExpanded] = useState(
    () => groupView?.state.expandedEntries.has(workEntry.id) ?? false,
  );
  const toggleExpanded = () => {
    const next = !expanded;
    if (groupView) {
      groupView.onToggleEntry();
      if (next) groupView.state.expandedEntries.add(workEntry.id);
      else groupView.state.expandedEntries.delete(workEntry.id);
    }
    setExpanded(next);
  };
  const iconConfig = workToneIcon(workEntry.tone);
  const showWarningIndicator = workEntry.sourceActivityKind === "runtime.warning";
  const showFailedIndicator = workEntryDisplayIndicatesToolFailure(workEntry);
  const showDestructiveRowStyle =
    showFailedIndicator &&
    (workEntrySignalsSevereFailure(workEntry) || !workLogEntryIsToolLike(workEntry));
  const entryIconName =
    showWarningIndicator || showDestructiveRowStyle ? "circle-alert" : workEntryIconName(workEntry);
  const entryToolIcon =
    showWarningIndicator || showDestructiveRowStyle
      ? undefined
      : (workEntry.toolIcon ?? workEntry.toolSource?.icon);
  const previewText = displayLabel ?? workEntryDisplayLabel(workEntry, workspaceRoot);
  const viewedImagePath = workEntryViewedImagePath(workEntry);
  const viewedImage =
    viewedImagePath && threadRef
      ? resolveViewedImageAsset(viewedImagePath, {
          threadId: threadRef.threadId,
          workspaceRoot,
        })
      : null;
  const commandMatchesVisibleLabel = workEntry.command?.trim() === previewText.trim();
  const canExpand =
    (workEntry.itemType === "mcp_tool_call" && workEntry.toolData !== undefined) ||
    Boolean(
      (!commandMatchesVisibleLabel &&
        (workEntryRawCommand(workEntry) || workEntry.command?.trim())) ||
      workEntry.detail?.trim() ||
      workEntry.changedFiles?.length ||
      viewedImage,
    );
  const expandedBody = expanded
    ? buildToolCallExpandedBody(
        workEntry,
        workspaceRoot,
        previewText,
        viewedImage ? viewedImagePath : null,
      )
    : null;
  // Reserve destructive row styling for severe failures, not routine tool errors.
  const iconWrapperClass = cn(
    "flex size-6 shrink-0 items-center justify-center",
    showWarningIndicator
      ? "text-warning"
      : showDestructiveRowStyle
        ? "text-destructive"
        : showFailedIndicator
          ? failedToolIconClassName
          : workEntry.tone === "tool"
            ? "text-icon-muted"
            : iconConfig.className,
  );
  const headingClass = showWarningIndicator
    ? "font-medium text-warning"
    : showDestructiveRowStyle
      ? "font-medium text-destructive"
      : workLogEntryIsToolLike(workEntry)
        ? "text-secondary-label"
        : "text-foreground/80";
  const accessibleDisplayText = showFailedIndicator
    ? `${previewText}, tool call failed`
    : previewText;
  const rowToggleProps = canExpand
    ? {
        role: "button" as const,
        tabIndex: 0 as const,
        "aria-label": accessibleDisplayText,
        "aria-expanded": expanded,
        onClick: toggleExpanded,
        onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggleExpanded();
          }
        },
      }
    : {};

  return (
    <div
      className={cn(
        "flex flex-col rounded-md px-0.5 transition-colors",
        isExpandedToolGroupEntry ? "py-0" : "py-0.5",
        canExpand &&
          "cursor-pointer hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
      )}
      {...rowToggleProps}
    >
      <div className="flex select-none items-center gap-1.5 transition-[opacity,translate] duration-200">
        <span
          className={iconWrapperClass}
          role={showFailedIndicator ? "img" : undefined}
          aria-label={showFailedIndicator ? "Tool call failed" : undefined}
        >
          <ToolActivityIconView
            icon={entryToolIcon}
            fallbackName={entryIconName}
            className="block size-4 shrink-0 stroke-[1.8]"
            muted
          />
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <div className="min-w-0 flex-1 overflow-hidden">
            <p className="flex min-w-0 w-full items-baseline gap-1.5 text-sm leading-relaxed">
              <span
                className={cn(
                  "min-w-0 flex-1",
                  expanded || (commandMatchesVisibleLabel && !canExpand)
                    ? "whitespace-pre-wrap break-words select-text"
                    : "truncate",
                  headingClass,
                )}
                onClick={expanded ? stopRowToggle : undefined}
                onPointerDown={expanded ? stopRowToggle : undefined}
              >
                {previewText}
              </span>
            </p>
          </div>
          {showFailedIndicator &&
          !showDestructiveRowStyle &&
          !toolIconAcceptsTint(entryIconName, entryToolIcon) ? (
            <XIcon aria-hidden className={cn("size-3 shrink-0", failedToolIconClassName)} />
          ) : null}
          <span
            className={cn(
              "flex size-4 shrink-0 items-center justify-center",
              !canExpand && "invisible",
            )}
            aria-hidden
          >
            <ChevronDownIcon
              className={cn(
                "size-3 shrink-0 text-icon-muted opacity-70 transition-transform duration-200",
                expanded && "rotate-180",
              )}
            />
          </span>
        </div>
      </div>
      {expanded && viewedImage && threadRef ? (
        <div
          className="mt-1 ms-7 cursor-default"
          onClick={stopRowToggle}
          onPointerDown={stopRowToggle}
        >
          <ChatMarkdownAssetImage
            environmentId={threadRef.environmentId}
            resource={viewedImage.resource}
            alt={viewedImage.alt}
            srcFragment={viewedImage.srcFragment}
            workspaceRoot={workspaceRoot}
            style={{ maxHeight: "16rem" }}
            onImageExpand={onImageExpand}
          />
        </div>
      ) : null}
      {expanded && canExpand && expandedBody ? (
        <div
          className="mt-1 ms-7 cursor-default rounded-md bg-muted/40 px-3 py-2"
          onClick={stopRowToggle}
          onPointerDown={stopRowToggle}
        >
          <pre className={toolCallExpandedBodyClassName}>{expandedBody}</pre>
        </div>
      ) : null}
    </div>
  );
});
