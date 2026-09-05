import {
  type ApprovalRequestId,
  DEFAULT_MODEL,
  defaultInstanceIdForDriver,
  type EnvironmentId,
  type MessageId,
  type ModelSelection,
  type ProjectScript,
  type ProjectId,
  type ProviderApprovalDecision,
  type PreviewAnnotationPayload,
  ProviderInstanceId,
  type ServerProvider,
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
  type ThreadId,
  type TurnId,
  type KeybindingCommand,
  OrchestrationThreadActivity,
  ProviderInteractionMode,
  ProviderDriverKind,
  RuntimeMode,
  TerminalOpenInput,
} from "@t3tools/contracts";
import {
  connectionStatusTitle,
  type EnvironmentConnectionPresentation,
} from "@t3tools/client-runtime/connection";
import {
  changeRequestAutoSettles,
  effectiveSettled,
  effectiveSnoozed,
  threadWokeAt,
} from "@t3tools/client-runtime/state/thread-settled";
import {
  codexFeedbackMessage,
  parseCodexFeedbackCommand,
  submitCodexFeedback,
  type CodexFeedbackSubmission,
} from "@t3tools/client-runtime/state/threads";
import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  applyClaudePromptEffortPrefix,
  createModelSelection,
  resolvePromptInjectedEffort,
} from "@t3tools/shared/model";
import { CHAT_LIST_ANCHOR_OFFSET } from "@t3tools/shared/chatList";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { truncate } from "@t3tools/shared/String";
import {
  getTerminalLabel,
  nextTerminalId,
  resolveTerminalSessionLabel,
} from "@t3tools/shared/terminalLabels";
import { Debouncer } from "@tanstack/react-pacer";
import { useAtomValue } from "@effect/atom-react";
import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { useNavigate } from "@tanstack/react-router";
import { useShallow } from "zustand/react/shallow";
import {
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { isElectron } from "../env";
import { readLocalApi } from "../localApi";
import { useDiffPanelStore } from "../diffPanelStore";
import {
  collapseExpandedComposerCursor,
  parseStandaloneComposerSlashCommand,
  type ComposerSubmissionIntent,
} from "../composer-logic";
import {
  derivePendingApprovals,
  derivePendingUserInputs,
  derivePhase,
  deriveTimelineEntries,
  deriveActiveWorkStartedAt,
  deriveActivePlanState,
  deriveTurnPlans,
  findLatestProposedPlan,
  deriveWorkLogEntries,
  hasActionableProposedPlan,
  isLatestTurnSettled,
} from "../session-logic";
import { type LegendListRef } from "@legendapp/list/react";
import { getAnchoredTurnMetrics, type TimelineScrollMode } from "./chat/timelineScrollAnchoring";
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../pendingUserInput";
import { useUiStateStore } from "../uiStateStore";
import {
  buildPlanImplementationThreadTitle,
  buildPlanImplementationPrompt,
  resolvePlanFollowUpSubmission,
} from "../proposedPlan";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  DEFAULT_THREAD_TERMINAL_ID,
  MAX_TERMINALS_PER_GROUP,
  type ChatMessage,
  type TurnDiffSummary,
} from "../types";
import { useTheme } from "../hooks/useTheme";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { isCommandPaletteOpen } from "../commandPaletteBus";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../rightPanelLayout";
import {
  fileSurfaceId,
  selectActiveRightPanel,
  selectActiveRightPanelSurface,
  selectThreadRightPanelState,
  terminalSurfaceId,
  type RightPanelSurface,
  updatePullRequestTabStatus,
  useRightPanelStore,
} from "../rightPanelStore";
import {
  isPreviewSupportedInRuntime,
  setActivePreviewTab,
  useThreadPreviewState,
} from "../previewStateStore";
import { previewRuntimeTabId } from "../browser/previewRuntimeTabId";
import { addBrowserSurface } from "./preview/addBrowserSurface";
import { closePreviewSession } from "./preview/closePreviewSession";
import { ThreadPreviewMiniPlayer } from "./preview/ThreadPreviewMiniPlayer";
import { subscribePreviewAction } from "./preview/previewActionBus";
import { getConfiguredPreviewUrls } from "./preview/previewEmptyStateLogic";
import { makeWorkspaceFileDropHandlers } from "./chat/workspaceFileDrop";
import {
  selectThreadPreviewMiniPlayer,
  usePreviewMiniPlayerStore,
} from "../previewMiniPlayerStore";
import { isThreadOwnPullRequest } from "./pullRequest/pullRequestDetail.logic";
import { PullRequestDetailPanel } from "./pullRequest/PullRequestDetailPanel";
import { PullRequestDetailGhost } from "./pullRequest/PullRequestGhosts";
import { PullRequestsUnavailableState } from "./pullRequest/PullRequestsUnavailableState";
import { RightPanelTabs, type PullRequestTabStatus } from "./RightPanelTabs";
import { AgentsPanel } from "./AgentsPanel";
import { MagiPanel } from "./magi/MagiPanel";
import {
  deriveAgentPanelModel,
  foldSubagentActivities,
  reconcileSubagentProjectionStatuses,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";
import { BranchToolbar } from "./BranchToolbar";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import ThreadTerminalDrawer from "./ThreadTerminalDrawer";
import {
  AlarmClockIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  GitBranchIcon,
  PaperclipIcon,
  WifiOffIcon,
} from "lucide-react";
import { cn, randomHex, randomUUID } from "~/lib/utils";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { decodeProjectScriptKeybindingRule } from "~/lib/projectScriptKeybindings";
import { type NewProjectScriptInput } from "./ProjectScriptsControl";
import type { SourceControlProjectActionTarget } from "./source-control/SourceControlPanel";
import {
  buildProjectScript,
  commandForProjectScript,
  nextProjectScriptId,
  projectScriptIdFromCommand,
} from "~/projectScripts";
import { newDraftId, newMessageId, newThreadId } from "~/lib/utils";
import { registerFaviconProjectForThread } from "~/browserFaviconStore";
import { getProviderModelCapabilities, resolveSelectableProvider } from "../providerModels";
import { NO_PROVIDER_MODEL_SELECTION } from "../providerInstances";
import {
  useClientSettings,
  useClientSettingsHydrated,
  useEnvironmentSettings,
} from "../hooks/useSettings";
import { useNowMinute } from "../hooks/useNowMinute";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { resolveAppModelSelectionForInstance } from "../modelSelection";
import { confirmTerminalClose, isTerminalCloseConfirmPending } from "../lib/terminalCloseConfirm";
import { getTerminalFocusOwner } from "../lib/terminalFocus";
import {
  preventRepeatedTerminalCloseShortcut,
  preventTerminalCloseShortcut,
} from "../lib/terminalCloseShortcut";
import { resolveSubagentParentThreadRef } from "../subagentControls";
import { resolveNewDraftStartFromOrigin } from "../lib/chatThreadActions";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "../logicalProject";
import { buildDraftThreadRouteParams, buildThreadRouteParams } from "../threadRoutes";
import {
  type ComposerImageAttachment,
  type DraftThreadEnvMode,
  useComposerDraftStore,
  type DraftId,
} from "../composerDraftStore";
import {
  appendTerminalContextsToPrompt,
  formatTerminalContextLabel,
  type TerminalContextDraft,
  type TerminalContextSelection,
} from "../lib/terminalContext";
import {
  appendElementContextsToPrompt,
  type ElementContextDraft,
  formatElementContextLabel,
} from "../lib/elementContext";
import { appendPreviewAnnotationPrompt } from "../lib/previewAnnotation";
import { appendReviewCommentsToPrompt, type ReviewCommentContext } from "../reviewCommentContext";
import { environmentCatalog } from "../connection/catalog";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { registerChatViewThreadProject } from "./ChatView.browserHistoryInterop";
import { useKnownTerminalSessions, useThreadRunningTerminalIds } from "../state/terminalSessions";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentQuery } from "../state/query";
import {
  primaryServerAvailableEditorsAtom,
  primaryServerKeybindingsAtom,
  primaryServerSettingsAtom,
  serverEnvironment,
} from "../state/server";
import { terminalEnvironment } from "../state/terminal";
import { threadEnvironment, useEnvironmentThread } from "../state/threads";
import {
  requestOlderThreadTurns,
  threadHasOlderTurns,
} from "@t3tools/client-runtime/state/threads";
import { vcsEnvironment } from "../state/vcs";
import { useEnvironments, usePrimaryEnvironment } from "../state/environments";
import {
  useProject,
  useProjects,
  useThread,
  useThreadRefs,
  useThreadShell,
  useThreadShells,
} from "../state/entities";
import { environmentShell } from "../state/shell";
import { ChatComposer, type ChatComposerHandle } from "./chat/ChatComposer";
import { DraftHeroHeadline } from "./chat/DraftHeroHeadline";
import { ExpandedImageDialog } from "./chat/ExpandedImageDialog";
import { PullRequestThreadDialog } from "./PullRequestThreadDialog";
import { MessagesTimeline } from "./chat/MessagesTimeline";
import { ChatHeader } from "./chat/ChatHeader";
import { PanelLayoutControls, RightPanelMaximizeControl } from "./chat/PanelLayoutControls";
import { type ExpandedImagePreview } from "./chat/ExpandedImagePreview";
import { NoActiveThreadState } from "./NoActiveThreadState";
import { WorkspacePageHeader } from "./WorkspacePageHeader";
import {
  resolveEffectiveEnvMode,
  resolveLocalCheckoutBranchMismatch,
  shouldShowComposerContextStrip,
  shouldShowEnvironmentIndicator,
} from "./BranchToolbar.logic";
import {
  getProviderStatusBannerKey,
  ProviderStatusBanner,
  shouldShowProviderStatusBanner,
} from "./chat/ProviderStatusBanner";
import {
  dismissThreadErrorBannerForSession,
  getThreadErrorBannerKey,
  isThreadErrorBannerDismissedForSession,
  shouldShowThreadErrorBanner,
  ThreadErrorBanner,
} from "./chat/ThreadErrorBanner";
import {
  resolveDisplayedThreadPr,
  threadChangeRequestSnapshotsAtom,
} from "./ThreadStatusIndicators";
import { ComposerBannerStack, type ComposerBannerStackItem } from "./chat/ComposerBannerStack";
import { SubagentControlBar } from "./chat/SubagentControlBar";
import { ThreadSyncStatusPill } from "./chat/ThreadSyncStatusPill";
import {
  DRAFT_HERO_TRANSITION_ANIMATION_ID,
  DRAFT_HERO_TRANSITION_DURATION_MS,
  DRAFT_HERO_TRANSITION_EASING,
  MOBILE_COMPOSER_VIEW_TRANSITION_NAME,
  MOBILE_DRAFT_HEADLINE_VIEW_TRANSITION_NAME,
  runMobileComposerTransition,
} from "./chat/draftHeroTransition";
import {
  MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  branchMismatchKey,
  buildExpiredTerminalContextToastCopy,
  buildLocalDraftThread,
  buildLoadingThreadFromShell,
  buildThreadTurnInterruptInput,
  canLoadStandaloneThreadConversation,
  collectUserMessageBlobPreviewUrls,
  deriveAgentChildConversationByProviderId,
  deriveAgentChildLifecycleByProviderId,
  deriveComposerSendState,
  dismissBranchMismatchForSession,
  hasEnvironmentReconnectWarningGraceElapsed,
  scheduleEnvironmentReconnectWarning,
  isBranchMismatchDismissedForSession,
  shouldShowBranchMismatchBanner,
  getStartedThreadModelChangeBlockReason,
  isTerminalKeybindingCommand,
  isTerminalUiAvailable,
  LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
  LastInvokedScriptByProjectSchema,
  PullRequestDialogState,
  cloneComposerImageForRetry,
  deriveLockedProvider,
  readFileAsDataUrl,
  reconcileMountedTerminalThreadIds,
  resolveThreadMetadataUpdateForNextTurn,
  resolveSendEnvMode,
  revokeBlobPreviewUrl,
  revokeUserMessagePreviewUrls,
  terminalThreadRefsToCloseWhenDisabled,
  shouldWriteThreadErrorToCurrentServerThread,
  isLatestRequestSequence,
  startNewThreadForProject,
  waitForStartedServerThread,
} from "./ChatView.logic";
import {
  resolveThreadErrorDismissAction,
  resolveThreadErrorPresentation,
  resolveSourceControlPanelTarget,
  retargetOpenSourceControlSurface,
  useSourceControlRightPanelSurfaceState,
  useSourceControlThreadMetadataRouting,
} from "./ChatView.sourceControl";
import { useLocalDispatchState } from "./ChatView.localDispatch";
import type { ThreadSyncPhase } from "../threadSync";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useComposerHandleContext } from "../composerHandleContext";
import { sanitizeThreadErrorMessage } from "~/rpc/transportError";
import { RightPanelSheet } from "./RightPanelSheet";
import { previewEnvironment } from "../state/preview";
import { useAtomCommand } from "../state/use-atom-command";
import { Button } from "./ui/button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { ServerUpdateAction, ServerUpdateProgress } from "./ServerUpdateAction";
import {
  buildVersionMismatchDismissalKey,
  dismissVersionMismatch,
  isVersionMismatchDismissed,
  resolveServerConfigVersionMismatch,
  resolveServerSelfUpdateCapability,
  serverUpdateGuidance,
} from "../versionSkew";
import { useAssetUrls } from "../assets/assetUrls";

const IMAGE_ONLY_BOOTSTRAP_PROMPT =
  "[User attached one or more images without additional text. Respond using the conversation context and the attached image(s).]";
const EMPTY_ACTIVITIES: OrchestrationThreadActivity[] = [];
const EMPTY_PROVIDERS: ServerProvider[] = [];
const EMPTY_PENDING_USER_INPUT_ANSWERS: Record<string, PendingUserInputDraftAnswer> = {};
function useDraftHeroLayoutTransition(isDraftHeroState: boolean) {
  const transitionGroupRef = useRef<HTMLDivElement | null>(null);
  const composerAnchorRef = useRef<HTMLDivElement | null>(null);
  const previousStateRef = useRef(isDraftHeroState);
  const previousComposerRectRef = useRef<DOMRect | null>(null);
  const animationRef = useRef<Animation | null>(null);
  const attachTransitionGroupRef = (element: HTMLDivElement | null) => {
    transitionGroupRef.current = element;
  };
  const attachComposerAnchorRef = (element: HTMLDivElement | null) => {
    composerAnchorRef.current = element;
  };
  const captureComposerRect = () => {
    previousComposerRectRef.current = composerAnchorRef.current?.getBoundingClientRect() ?? null;
  };

  useLayoutEffect(() => {
    const transitionGroup = transitionGroupRef.current;
    const nextComposerRect = composerAnchorRef.current?.getBoundingClientRect() ?? null;
    const stateChanged = previousStateRef.current !== isDraftHeroState;
    const prefersReducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const mobileComposerTransitionActive =
      typeof document !== "undefined" &&
      document.documentElement.dataset.mobileComposerRouteTransition === "true";

    animationRef.current?.cancel();
    animationRef.current = null;

    const previousComposerRect = previousComposerRectRef.current;
    if (
      stateChanged &&
      !prefersReducedMotion &&
      !mobileComposerTransitionActive &&
      transitionGroup &&
      previousComposerRect &&
      nextComposerRect &&
      typeof transitionGroup.animate === "function"
    ) {
      const translateX = previousComposerRect.left - nextComposerRect.left;
      const translateY = previousComposerRect.top - nextComposerRect.top;
      if (Math.abs(translateX) >= 0.5 || Math.abs(translateY) >= 0.5) {
        const animation = transitionGroup.animate(
          [
            { transform: `translate3d(${translateX}px, ${translateY}px, 0)` },
            { transform: "translate3d(0, 0, 0)" },
          ],
          {
            duration: DRAFT_HERO_TRANSITION_DURATION_MS,
            easing: DRAFT_HERO_TRANSITION_EASING,
          },
        );
        animation.id = DRAFT_HERO_TRANSITION_ANIMATION_ID;
        animationRef.current = animation;
        void animation.finished
          .catch(() => undefined)
          .then(() => {
            if (animationRef.current !== animation) {
              return;
            }
            animationRef.current = null;
          });
      }
    }

    previousStateRef.current = isDraftHeroState;
    previousComposerRectRef.current = nextComposerRect;
  }, [isDraftHeroState]);

  return [attachTransitionGroupRef, attachComposerAnchorRef, captureComposerRect] as const;
}
const PreviewPanel = lazy(() =>
  import("./preview/PreviewPanel").then((module) => ({ default: module.PreviewPanel })),
);
const DiffPanel = lazy(() => import("./DiffPanel"));
const FilePreviewPanel = lazy(() => import("./files/FilePreviewPanel"));
const SourceControlPanel = lazy(() =>
  import("./source-control/SourceControlPanel").then((module) => ({
    default: module.SourceControlPanel,
  })),
);
const EMPTY_PENDING_FILE_SURFACE_IDS: ReadonlySet<string> = new Set();
const TYPE_TO_FOCUS_EDITABLE_SELECTOR = [
  "input",
  "textarea",
  "select",
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
  '[role="textbox"]',
].join(",");
const TYPE_TO_FOCUS_INTERACTIVE_SELECTOR = [
  "button",
  "a[href]",
  "summary",
  '[role="button"]',
  '[role="checkbox"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="tab"]',
].join(",");
const TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR = [
  '[data-slot="dialog"]',
  '[data-slot="menu-popup"]',
  '[data-slot="select-popup"]',
  '[data-slot="popover-popup"]',
  '[data-slot="combobox-popup"]',
  '[data-slot="autocomplete-popup"]',
].join(",");
const TIMELINE_SCROLL_NAVIGATION_KEYS = new Set([
  "ArrowDown",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
  "Spacebar",
  " ",
]);
const TIMELINE_SCROLL_LISTENER_SETUP_MAX_ATTEMPTS = 12;

type EnvironmentUnavailableState = {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connection: EnvironmentConnectionPresentation;
};

function eventPathContainsSelector(event: Event, selector: string): boolean {
  const path = event.composedPath();
  if (path.length === 0 && event.target) {
    path.push(event.target);
  }
  return path.some((target) => target instanceof Element && target.closest(selector));
}

function shouldTypeToFocusComposer(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing) return false;
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  if (event.key.length !== 1) return false;

  if (eventPathContainsSelector(event, TYPE_TO_FOCUS_EDITABLE_SELECTOR)) return false;
  if (eventPathContainsSelector(event, TYPE_TO_FOCUS_INTERACTIVE_SELECTOR)) return false;
  if (document.querySelector(TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR)) return false;

  // The right-panel surface launcher claims its shortcut letters while it is
  // visible (data attribute set in RightPanelTabs); those keys open surfaces
  // instead of typing into the composer.
  const launcherKeys = document
    .querySelector("[data-surface-launcher-keys]")
    ?.getAttribute("data-surface-launcher-keys");
  if (launcherKeys && launcherKeys.toLowerCase().includes(event.key.toLowerCase())) return false;

  return true;
}

function shouldTreatKeyAsTimelineScrollNavigation(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing) return false;
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  if (!TIMELINE_SCROLL_NAVIGATION_KEYS.has(event.key)) return false;

  if (eventPathContainsSelector(event, TYPE_TO_FOCUS_EDITABLE_SELECTOR)) return false;
  if (eventPathContainsSelector(event, TYPE_TO_FOCUS_INTERACTIVE_SELECTOR)) return false;
  if (document.querySelector(TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR)) return false;

  return true;
}

function isPointerInNativeScrollbarGutter(scrollNode: HTMLElement, event: PointerEvent): boolean {
  const verticalScrollbarWidth = scrollNode.offsetWidth - scrollNode.clientWidth;
  const horizontalScrollbarHeight = scrollNode.offsetHeight - scrollNode.clientHeight;
  if (verticalScrollbarWidth <= 0 && horizontalScrollbarHeight <= 0) {
    return false;
  }

  const rect = scrollNode.getBoundingClientRect();
  const isRtl = getComputedStyle(scrollNode).direction === "rtl";
  const verticalScrollbarStart = isRtl ? rect.left : rect.right - verticalScrollbarWidth;
  const verticalScrollbarEnd = isRtl ? rect.left + verticalScrollbarWidth : rect.right;
  const isInVerticalScrollbar =
    verticalScrollbarWidth > 0 &&
    event.clientX >= verticalScrollbarStart &&
    event.clientX <= verticalScrollbarEnd &&
    event.clientY >= rect.top &&
    event.clientY <= rect.bottom;
  const isInHorizontalScrollbar =
    horizontalScrollbarHeight > 0 &&
    event.clientX >= rect.left &&
    event.clientX <= rect.right &&
    event.clientY >= rect.bottom - horizontalScrollbarHeight &&
    event.clientY <= rect.bottom;

  return isInVerticalScrollbar || isInHorizontalScrollbar;
}

function formatOutgoingPrompt(params: {
  provider: ProviderDriverKind;
  model: string | null;
  models: ReadonlyArray<ServerProvider["models"][number]>;
  effort: string | null;
  text: string;
}): string {
  const caps = getProviderModelCapabilities(params.models, params.model, params.provider);
  const promptEffort = resolvePromptInjectedEffort(caps, params.effort);
  return applyClaudePromptEffortPrefix(params.text, promptEffort);
}
const SCRIPT_TERMINAL_COLS = 120;
const SCRIPT_TERMINAL_ROWS = 30;

type ChatViewProps =
  | {
      environmentId: EnvironmentId;
      threadId: ThreadId;
      onDiffPanelOpen?: () => void;
      reserveTitleBarControlInset?: boolean;
      forceExpandedMobileComposer?: boolean;
      threadSyncPhase?: ThreadSyncPhase | null;
      routeKind: "server";
      draftId?: never;
    }
  | {
      environmentId: EnvironmentId;
      threadId: ThreadId;
      onDiffPanelOpen?: () => void;
      reserveTitleBarControlInset?: boolean;
      forceExpandedMobileComposer?: boolean;
      threadSyncPhase?: never;
      routeKind: "draft";
      draftId: DraftId;
    };

interface TerminalLaunchContext {
  threadId: ThreadId;
  cwd: string;
  worktreePath: string | null;
}

type PersistentTerminalLaunchContext = Pick<TerminalLaunchContext, "cwd" | "worktreePath">;

/** Same terminal ids (order ignored) — avoids reconcile when only server session ordering differs. */
function terminalIdListsEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  if (left.length === 0) {
    return true;
  }
  const sortedLeft = left.toSorted((a, b) => a.localeCompare(b));
  const sortedRight = right.toSorted((a, b) => a.localeCompare(b));
  for (let index = 0; index < sortedLeft.length; index += 1) {
    if (sortedLeft[index] !== sortedRight[index]) {
      return false;
    }
  }
  return true;
}

/**
 * Server knows about fewer sessions than the client, but every server id still exists locally.
 * Typical right after `terminal.open`: known-session list lags; reconciling would drop the new id
 * and later re-add it as a separate group (no split layout).
 */
function serverTerminalIdsStrictSubsetOfClient(
  serverIds: readonly string[],
  clientIds: readonly string[],
): boolean {
  if (serverIds.length >= clientIds.length || clientIds.length === 0) {
    return false;
  }
  const clientSet = new Set(clientIds);
  for (const id of serverIds) {
    if (!clientSet.has(id)) {
      return false;
    }
  }
  return true;
}

interface PersistentThreadTerminalDrawerProps {
  threadRef: { environmentId: EnvironmentId; threadId: ThreadId };
  threadId: ThreadId;
  visible: boolean;
  launchContext: PersistentTerminalLaunchContext | null;
  focusRequestId: number;
  splitShortcutLabel: string | undefined;
  splitVerticalShortcutLabel: string | undefined;
  newShortcutLabel: string | undefined;
  closeShortcutLabel: string | undefined;
  keybindings: ResolvedKeybindingsConfig;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
}

const PersistentThreadTerminalDrawer = memo(function PersistentThreadTerminalDrawer({
  threadRef,
  threadId,
  visible,
  launchContext,
  focusRequestId,
  splitShortcutLabel,
  splitVerticalShortcutLabel,
  newShortcutLabel,
  closeShortcutLabel,
  keybindings,
  onAddTerminalContext,
}: PersistentThreadTerminalDrawerProps) {
  const openTerminal = useAtomCommand(terminalEnvironment.open, "terminal open");
  const writeTerminal = useAtomCommand(terminalEnvironment.write, "terminal write");
  const closeTerminalMutation = useAtomCommand(terminalEnvironment.close, "terminal close");
  const draftThread = useComposerDraftStore((store) => store.getDraftThreadByRef(threadRef));
  const serverThread = useThread(threadRef, { waitForShell: draftThread !== null });
  const projectRef = serverThread
    ? scopeProjectRef(serverThread.environmentId, serverThread.projectId)
    : draftThread
      ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
      : null;
  const project = useProject(projectRef);
  const terminalUiState = useTerminalUiStateStore((state) =>
    selectThreadTerminalUiState(state.terminalUiStateByThreadKey, threadRef),
  );
  const knownTerminalSessions = useKnownTerminalSessions({
    environmentId: threadRef.environmentId,
    threadId,
  });
  const panelSurfaces = useRightPanelStore(
    (state) => selectThreadRightPanelState(state.byThreadKey, threadRef).surfaces,
  );
  const panelTerminalIds = useMemo(
    () =>
      new Set(
        panelSurfaces.flatMap((surface) =>
          surface.kind === "terminal" ? surface.terminalIds : [],
        ),
      ),
    [panelSurfaces],
  );
  const drawerTerminalSessions = useMemo(
    () =>
      knownTerminalSessions.filter((session) => !panelTerminalIds.has(session.target.terminalId)),
    [knownTerminalSessions, panelTerminalIds],
  );
  const terminalLabelsById = useMemo(() => {
    const next = new Map<string, string>();
    for (const session of drawerTerminalSessions) {
      next.set(
        session.target.terminalId,
        resolveTerminalSessionLabel(session.target.terminalId, session.state.summary),
      );
    }
    return next;
  }, [drawerTerminalSessions]);
  const terminalLaunchLocationsById = useMemo(() => {
    const next = new Map<
      string,
      {
        readonly cwd: string;
        readonly worktreePath: string | null;
        readonly runtimeEnv: Record<string, string>;
      }
    >();
    if (!project) {
      return next;
    }

    for (const session of drawerTerminalSessions) {
      const summary = session.state.summary;
      if (!summary) {
        continue;
      }
      const worktreePathForLaunch =
        launchContext !== null ? launchContext.worktreePath : summary.worktreePath;
      next.set(session.target.terminalId, {
        cwd: launchContext?.cwd ?? summary.cwd,
        worktreePath: worktreePathForLaunch,
        runtimeEnv: projectScriptRuntimeEnv({
          project: { cwd: project.workspaceRoot },
          worktreePath: worktreePathForLaunch,
        }),
      });
    }

    return next;
  }, [drawerTerminalSessions, launchContext, project]);
  const serverOrderedTerminalIds = useMemo(
    () => drawerTerminalSessions.map((session) => session.target.terminalId),
    [drawerTerminalSessions],
  );
  const storeSetTerminalHeight = useTerminalUiStateStore((state) => state.setTerminalHeight);
  const storeSplitTerminal = useTerminalUiStateStore((state) => state.splitTerminal);
  const storeSplitTerminalVertical = useTerminalUiStateStore(
    (state) => state.splitTerminalVertical,
  );
  const storeNewTerminal = useTerminalUiStateStore((state) => state.newTerminal);
  const storeSetActiveTerminal = useTerminalUiStateStore((state) => state.setActiveTerminal);
  const storeCloseTerminal = useTerminalUiStateStore((state) => state.closeTerminal);
  const reconcileTerminalIds = useTerminalUiStateStore((state) => state.reconcileTerminalIds);

  useEffect(() => {
    if (terminalIdListsEqual(serverOrderedTerminalIds, terminalUiState.terminalIds)) {
      return;
    }
    if (
      serverTerminalIdsStrictSubsetOfClient(serverOrderedTerminalIds, terminalUiState.terminalIds)
    ) {
      return;
    }
    reconcileTerminalIds(threadRef, serverOrderedTerminalIds);
  }, [reconcileTerminalIds, serverOrderedTerminalIds, terminalUiState.terminalIds, threadRef]);
  const [localFocusRequestId, setLocalFocusRequestId] = useState(0);
  const worktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const effectiveWorktreePath = useMemo(() => {
    if (launchContext !== null) {
      return launchContext.worktreePath;
    }
    return worktreePath;
  }, [launchContext, worktreePath]);
  const cwd = useMemo(
    () =>
      launchContext?.cwd ??
      (project
        ? projectScriptCwd({
            project: { cwd: project.workspaceRoot },
            worktreePath: effectiveWorktreePath,
          })
        : null),
    [effectiveWorktreePath, launchContext?.cwd, project],
  );
  const runtimeEnv = useMemo(
    () =>
      project
        ? projectScriptRuntimeEnv({
            project: { cwd: project.workspaceRoot },
            worktreePath: effectiveWorktreePath,
          })
        : {},
    [effectiveWorktreePath, project],
  );

  const bumpFocusRequestId = useCallback(() => {
    if (!visible) {
      return;
    }
    setLocalFocusRequestId((value) => value + 1);
  }, [visible]);

  const setTerminalHeight = useCallback(
    (height: number) => {
      storeSetTerminalHeight(threadRef, height);
    },
    [storeSetTerminalHeight, threadRef],
  );

  const splitTerminal = useCallback(() => {
    if (!cwd) {
      return;
    }
    const terminalId = nextTerminalId(serverOrderedTerminalIds);
    storeSplitTerminal(threadRef, terminalId);
    bumpFocusRequestId();
    void openTerminal({
      environmentId: threadRef.environmentId,
      input: {
        threadId,
        terminalId,
        cwd,
        ...(effectiveWorktreePath != null ? { worktreePath: effectiveWorktreePath } : {}),
        env: runtimeEnv,
      },
    });
  }, [
    bumpFocusRequestId,
    cwd,
    effectiveWorktreePath,
    runtimeEnv,
    serverOrderedTerminalIds,
    storeSplitTerminal,
    threadId,
    threadRef,
    openTerminal,
  ]);
  const splitTerminalVertical = useCallback(() => {
    if (!cwd) {
      return;
    }
    const terminalId = nextTerminalId(serverOrderedTerminalIds);
    storeSplitTerminalVertical(threadRef, terminalId);
    bumpFocusRequestId();
    void openTerminal({
      environmentId: threadRef.environmentId,
      input: {
        threadId,
        terminalId,
        cwd,
        ...(effectiveWorktreePath != null ? { worktreePath: effectiveWorktreePath } : {}),
        env: runtimeEnv,
      },
    });
  }, [
    bumpFocusRequestId,
    cwd,
    effectiveWorktreePath,
    openTerminal,
    runtimeEnv,
    serverOrderedTerminalIds,
    storeSplitTerminalVertical,
    threadId,
    threadRef,
  ]);

  const createNewTerminal = useCallback(() => {
    if (!cwd) {
      return;
    }
    const terminalId = nextTerminalId(serverOrderedTerminalIds);
    storeNewTerminal(threadRef, terminalId);
    bumpFocusRequestId();
    void openTerminal({
      environmentId: threadRef.environmentId,
      input: {
        threadId,
        terminalId,
        cwd,
        ...(effectiveWorktreePath != null ? { worktreePath: effectiveWorktreePath } : {}),
        env: runtimeEnv,
      },
    });
  }, [
    bumpFocusRequestId,
    cwd,
    effectiveWorktreePath,
    runtimeEnv,
    serverOrderedTerminalIds,
    storeNewTerminal,
    threadId,
    threadRef,
    openTerminal,
  ]);

  const activateTerminal = useCallback(
    (terminalId: string) => {
      storeSetActiveTerminal(threadRef, terminalId);
      bumpFocusRequestId();
    },
    [bumpFocusRequestId, storeSetActiveTerminal, threadRef],
  );

  const closeTerminal = useCallback(
    (terminalId: string) => {
      const fallbackExitWrite = () =>
        writeTerminal({
          environmentId: threadRef.environmentId,
          input: { threadId, terminalId, data: "exit\n" },
        });

      void (async () => {
        const closeResult = await closeTerminalMutation({
          environmentId: threadRef.environmentId,
          input: {
            threadId,
            terminalId,
            deleteHistory: true,
          },
        });
        if (closeResult._tag === "Failure" && !isAtomCommandInterrupted(closeResult)) {
          await fallbackExitWrite();
        }
      })();

      storeCloseTerminal(threadRef, terminalId);
      bumpFocusRequestId();
    },
    [
      bumpFocusRequestId,
      storeCloseTerminal,
      threadId,
      threadRef,
      closeTerminalMutation,
      writeTerminal,
    ],
  );

  const handleAddTerminalContext = useCallback(
    (selection: TerminalContextSelection) => {
      if (!visible) {
        return;
      }
      onAddTerminalContext(selection);
    },
    [onAddTerminalContext, visible],
  );

  if (!project || !terminalUiState.terminalOpen || !cwd) {
    return null;
  }

  return (
    <div className={visible ? undefined : "hidden"}>
      <ThreadTerminalDrawer
        threadRef={threadRef}
        threadId={threadId}
        cwd={cwd}
        worktreePath={effectiveWorktreePath}
        runtimeEnv={runtimeEnv}
        visible={visible}
        height={terminalUiState.terminalHeight}
        // Known-session order is MRU and changes on focus; persisted store order keeps sidebar labels stable.
        terminalIds={terminalUiState.terminalIds}
        activeTerminalId={terminalUiState.activeTerminalId}
        terminalGroups={terminalUiState.terminalGroups}
        activeTerminalGroupId={terminalUiState.activeTerminalGroupId}
        focusRequestId={focusRequestId + localFocusRequestId + (visible ? 1 : 0)}
        onSplitTerminal={splitTerminal}
        onSplitTerminalVertical={splitTerminalVertical}
        onNewTerminal={createNewTerminal}
        splitShortcutLabel={visible ? splitShortcutLabel : undefined}
        splitVerticalShortcutLabel={visible ? splitVerticalShortcutLabel : undefined}
        newShortcutLabel={visible ? newShortcutLabel : undefined}
        closeShortcutLabel={visible ? closeShortcutLabel : undefined}
        keybindings={keybindings}
        onActiveTerminalChange={activateTerminal}
        onCloseTerminal={closeTerminal}
        onHeightChange={setTerminalHeight}
        onAddTerminalContext={handleAddTerminalContext}
        terminalLabelsById={terminalLabelsById}
        terminalLaunchLocationsById={terminalLaunchLocationsById}
      />
    </div>
  );
});

interface PersistentThreadTerminalPanelProps {
  threadRef: ScopedThreadRef;
  surface: Extract<RightPanelSurface, { kind: "terminal" }>;
  launchContext: PersistentTerminalLaunchContext | null;
  focusRequestId: number;
  keybindings: ResolvedKeybindingsConfig;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
  onSplitTerminal: () => void;
  onSplitTerminalVertical: () => void;
  onNewTerminal: () => void;
  onActiveTerminalChange: (terminalId: string) => void;
  onCloseTerminal: (terminalId: string) => void;
  splitShortcutLabel?: string | undefined;
  splitVerticalShortcutLabel?: string | undefined;
  newShortcutLabel?: string | undefined;
  closeShortcutLabel?: string | undefined;
}

const PersistentThreadTerminalPanel = memo(function PersistentThreadTerminalPanel({
  threadRef,
  surface,
  launchContext,
  focusRequestId,
  keybindings,
  onAddTerminalContext,
  onSplitTerminal,
  onSplitTerminalVertical,
  onNewTerminal,
  onActiveTerminalChange,
  onCloseTerminal,
  splitShortcutLabel,
  splitVerticalShortcutLabel,
  newShortcutLabel,
  closeShortcutLabel,
}: PersistentThreadTerminalPanelProps) {
  const terminalThreadRef = useMemo(
    () =>
      surface.target
        ? scopeThreadRef(surface.target.environmentId as EnvironmentId, threadRef.threadId)
        : threadRef,
    [surface.target, threadRef],
  );
  const draftThread = useComposerDraftStore((store) =>
    surface.target ? null : store.getDraftThreadByRef(threadRef),
  );
  const serverThread = useThread(surface.target ? null : threadRef, {
    waitForShell: draftThread !== null,
  });
  const projectRef = surface.target
    ? scopeProjectRef(
        surface.target.environmentId as EnvironmentId,
        surface.target.projectId as ProjectId,
      )
    : serverThread
      ? scopeProjectRef(serverThread.environmentId, serverThread.projectId)
      : draftThread
        ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
        : null;
  const project = useProject(projectRef);
  const knownTerminalSessions = useKnownTerminalSessions({
    environmentId: terminalThreadRef.environmentId,
    threadId: terminalThreadRef.threadId,
  });
  const threadWorktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const activeSummary =
    knownTerminalSessions.find((session) => session.target.terminalId === surface.activeTerminalId)
      ?.state.summary ?? null;
  const worktreePath = surface.target
    ? surface.target.worktreePath
    : (launchContext?.worktreePath ?? activeSummary?.worktreePath ?? threadWorktreePath);
  const cwd = useMemo(
    () =>
      surface.target?.cwd ??
      launchContext?.cwd ??
      activeSummary?.cwd ??
      (project
        ? projectScriptCwd({
            project: { cwd: project.workspaceRoot },
            worktreePath,
          })
        : null),
    [activeSummary?.cwd, launchContext?.cwd, project, surface.target?.cwd, worktreePath],
  );
  const runtimeEnv = useMemo(
    () =>
      project
        ? projectScriptRuntimeEnv({
            project: { cwd: project.workspaceRoot },
            worktreePath,
          })
        : {},
    [project, worktreePath],
  );
  const terminalLabelsById = useMemo(() => {
    const labels = new Map<string, string>();
    for (const terminalId of surface.terminalIds) {
      const summary =
        knownTerminalSessions.find((session) => session.target.terminalId === terminalId)?.state
          .summary ?? null;
      labels.set(terminalId, resolveTerminalSessionLabel(terminalId, summary));
    }
    return labels;
  }, [knownTerminalSessions, surface.terminalIds]);
  const terminalLaunchLocationsById = useMemo(() => {
    const locations = new Map<
      string,
      {
        readonly cwd: string;
        readonly worktreePath: string | null;
        readonly runtimeEnv: Record<string, string>;
      }
    >();
    for (const terminalId of surface.terminalIds) {
      const summary =
        knownTerminalSessions.find((session) => session.target.terminalId === terminalId)?.state
          .summary ?? null;
      const terminalWorktreePath = surface.target
        ? surface.target.worktreePath
        : (launchContext?.worktreePath ?? summary?.worktreePath ?? threadWorktreePath);
      const terminalCwd =
        surface.target?.cwd ??
        launchContext?.cwd ??
        summary?.cwd ??
        (project
          ? projectScriptCwd({
              project: { cwd: project.workspaceRoot },
              worktreePath: terminalWorktreePath,
            })
          : null);
      if (!terminalCwd || !project) continue;
      locations.set(terminalId, {
        cwd: terminalCwd,
        worktreePath: terminalWorktreePath,
        runtimeEnv: projectScriptRuntimeEnv({
          project: { cwd: project.workspaceRoot },
          worktreePath: terminalWorktreePath,
        }),
      });
    }
    return locations;
  }, [
    knownTerminalSessions,
    launchContext?.cwd,
    launchContext?.worktreePath,
    project,
    surface.target,
    surface.terminalIds,
    threadWorktreePath,
  ]);

  if (!project || !cwd) return null;

  return (
    <ThreadTerminalDrawer
      mode="panel"
      threadRef={terminalThreadRef}
      threadId={terminalThreadRef.threadId}
      cwd={cwd}
      worktreePath={worktreePath}
      runtimeEnv={runtimeEnv}
      height={0}
      terminalIds={surface.terminalIds}
      activeTerminalId={surface.activeTerminalId}
      terminalGroups={[
        {
          id: surface.id,
          terminalIds: surface.terminalIds,
          ...(surface.splitDirection === "vertical" ? { splitDirection: "vertical" as const } : {}),
        },
      ]}
      activeTerminalGroupId={surface.id}
      focusRequestId={focusRequestId}
      onSplitTerminal={onSplitTerminal}
      onSplitTerminalVertical={onSplitTerminalVertical}
      onNewTerminal={onNewTerminal}
      splitShortcutLabel={splitShortcutLabel}
      splitVerticalShortcutLabel={splitVerticalShortcutLabel}
      newShortcutLabel={newShortcutLabel}
      closeShortcutLabel={closeShortcutLabel}
      onActiveTerminalChange={onActiveTerminalChange}
      onCloseTerminal={onCloseTerminal}
      onHeightChange={() => undefined}
      onAddTerminalContext={onAddTerminalContext}
      terminalLabelsById={terminalLabelsById}
      terminalLaunchLocationsById={terminalLaunchLocationsById}
      keybindings={keybindings}
    />
  );
});

// Errors surface through two maps (draft-keyed and thread-keyed) whose entries
// can race around promotion, so each write carries its time to let the latest
// one win when they collide.
type LocalThreadErrorEntry = {
  readonly message: string | null;
  readonly at: number;
};

function chatActionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An error occurred.";
}

function ChatViewContent(props: ChatViewProps) {
  const {
    environmentId,
    threadId,
    routeKind,
    onDiffPanelOpen,
    reserveTitleBarControlInset = true,
    forceExpandedMobileComposer = false,
  } = props;
  const draftId = routeKind === "draft" ? props.draftId : null;
  const threadSyncPhase = routeKind === "server" ? (props.threadSyncPhase ?? null) : null;
  const threadDetailLoading = threadSyncPhase === "loading";
  const handleNewThread = useNewThreadHandler();
  const routeThreadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const routeThreadKey = useMemo(() => scopedThreadKey(routeThreadRef), [routeThreadRef]);
  const threadShells = useThreadShells();
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const upsertKeybinding = useAtomCommand(serverEnvironment.upsertKeybinding, {
    reportFailure: false,
  });
  const openTerminal = useAtomCommand(terminalEnvironment.open, "terminal open");
  const writeTerminal = useAtomCommand(terminalEnvironment.write, "terminal write");
  const closeTerminalMutation = useAtomCommand(terminalEnvironment.close, "terminal close");
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const deleteThread = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const switchGitRef = useAtomCommand(vcsEnvironment.switchRef, { reportFailure: false });
  const setThreadRuntimeMode = useAtomCommand(threadEnvironment.setRuntimeMode, {
    reportFailure: false,
  });
  const setThreadInteractionMode = useAtomCommand(threadEnvironment.setInteractionMode, {
    reportFailure: false,
  });
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const uploadThreadFeedback = useAtomCommand(threadEnvironment.uploadFeedback, {
    reportFailure: false,
  });
  const interruptThreadTurn = useAtomCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });
  const respondToThreadApproval = useAtomCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const respondToThreadUserInput = useAtomCommand(threadEnvironment.respondToUserInput, {
    reportFailure: false,
  });
  const revertThreadCheckpoint = useAtomCommand(threadEnvironment.revertCheckpoint, {
    reportFailure: false,
  });
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const closePreview = useAtomCommand(previewEnvironment.close, "preview close");
  const { environments } = useEnvironments();
  const primaryEnvironment = usePrimaryEnvironment();
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  const environmentById = useMemo(
    () => new Map(environments.map((environment) => [environment.environmentId, environment])),
    [environments],
  );
  const composerDraftTarget: ScopedThreadRef | DraftId =
    routeKind === "server" ? routeThreadRef : props.draftId;
  const draftThread = useComposerDraftStore((store) =>
    routeKind === "server"
      ? store.getDraftSessionByRef(routeThreadRef)
      : draftId
        ? store.getDraftSession(draftId)
        : null,
  );
  const routeServerThreadShell = useThreadShell(routeKind === "server" ? routeThreadRef : null);
  const subagentConversationVisibilityEnabled = useClientSettings(
    (settings) => settings.subagentConversationVisibilityEnabled,
  );
  const clientSettingsHydrated = useClientSettingsHydrated();
  const canLoadRouteConversation =
    routeKind !== "server" ||
    canLoadStandaloneThreadConversation({
      threadShell: routeServerThreadShell,
      hasLocalDraft: draftThread !== null,
      clientSettingsHydrated,
      subagentConversationVisibilityEnabled,
    });
  const serverThread = useThread(canLoadRouteConversation ? routeThreadRef : null, {
    waitForShell: draftThread !== null,
  });
  const loadingServerThread = useMemo(
    () =>
      threadDetailLoading && routeServerThreadShell
        ? buildLoadingThreadFromShell(routeServerThreadShell)
        : null,
    [routeServerThreadShell, threadDetailLoading],
  );
  const activeServerThread = serverThread ?? loadingServerThread;
  // Pagination window state for the routed server thread: drives the
  // "load earlier turns" header when the loaded window has older history.
  const routeThreadState = useEnvironmentThread(
    routeKind === "server" && canLoadRouteConversation ? routeThreadRef.environmentId : null,
    routeKind === "server" && canLoadRouteConversation ? routeThreadRef.threadId : null,
  );
  const loadEarlierTurns = useMemo(() => {
    if (routeKind !== "server" || !threadHasOlderTurns(routeThreadState)) {
      return null;
    }
    return {
      loading: routeThreadState.page._tag === "Some" && routeThreadState.page.value.loadingOlder,
      onLoadEarlier: () => {
        requestOlderThreadTurns(routeThreadRef.environmentId, routeThreadRef.threadId);
      },
    };
  }, [routeKind, routeThreadRef, routeThreadState]);
  const markThreadVisited = useUiStateStore((store) => store.markThreadVisited);
  const settings = useEnvironmentSettings(environmentId);
  // New-thread defaults live in the primary environment's settings.json (the
  // settings UI never writes to remote environments), so read them from the
  // primary server rather than the thread's environment.
  const primaryServerSettings = useAtomValue(primaryServerSettingsAtom);
  const setStickyComposerModelSelection = useComposerDraftStore(
    (store) => store.setStickyModelSelection,
  );
  const timestampFormat = settings.timestampFormat;
  const terminalEnabled = true;
  const sourceControlPanelEnabled = true;
  const navigate = useNavigate();
  const { resolvedTheme } = useTheme();
  // Granular store selectors — avoid subscribing to prompt changes.
  const composerRuntimeMode = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.runtimeMode ?? null,
  );
  const composerInteractionMode = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.interactionMode ?? null,
  );
  const composerMagiArm = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.magiArm ?? null,
  );
  const composerActiveProvider = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.activeProvider ?? null,
  );
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const setComposerDraftMagiArm = useComposerDraftStore((store) => store.setMagiArm);
  const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
  const setComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.setTerminalContexts,
  );
  const setComposerDraftElementContexts = useComposerDraftStore(
    (store) => store.setElementContexts,
  );
  const setComposerDraftPreviewAnnotations = useComposerDraftStore(
    (store) => store.setPreviewAnnotations,
  );
  const setComposerDraftReviewComments = useComposerDraftStore((store) => store.setReviewComments);
  const setComposerDraftModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const setComposerDraftRuntimeMode = useComposerDraftStore((store) => store.setRuntimeMode);
  const setComposerDraftInteractionMode = useComposerDraftStore(
    (store) => store.setInteractionMode,
  );
  const clearComposerDraftContent = useComposerDraftStore((store) => store.clearComposerContent);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const getDraftSessionByLogicalProjectKey = useComposerDraftStore(
    (store) => store.getDraftSessionByLogicalProjectKey,
  );
  const getDraftSession = useComposerDraftStore((store) => store.getDraftSession);
  const setLogicalProjectDraftThreadId = useComposerDraftStore(
    (store) => store.setLogicalProjectDraftThreadId,
  );
  const promptRef = useRef("");
  const composerImagesRef = useRef<ComposerImageAttachment[]>([]);
  const composerTerminalContextsRef = useRef<TerminalContextDraft[]>([]);
  const composerElementContextsRef = useRef<ElementContextDraft[]>([]);
  const localComposerRef = useRef<ChatComposerHandle | null>(null);
  const composerRef = useComposerHandleContext() ?? localComposerRef;
  const [isWorkspaceFileDragActive, setIsWorkspaceFileDragActive] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);
  const [pendingSubagentStopThreadId, setPendingSubagentStopThreadId] = useState<ThreadId | null>(
    null,
  );
  const [optimisticUserMessages, setOptimisticUserMessages] = useState<ChatMessage[]>([]);
  const [feedbackSubmissionsByThreadKey, setFeedbackSubmissionsByThreadKey] = useState<
    Record<string, ReadonlyArray<CodexFeedbackSubmission>>
  >({});
  const feedbackSubmissions = useMemo(
    () => feedbackSubmissionsByThreadKey[routeThreadKey] ?? [],
    [feedbackSubmissionsByThreadKey, routeThreadKey],
  );
  const feedbackUploading = feedbackSubmissions.some(
    (submission) => submission.status === "uploading",
  );
  const optimisticUserMessagesRef = useRef(optimisticUserMessages);
  optimisticUserMessagesRef.current = optimisticUserMessages;
  const [localDraftErrorsByDraftId, setLocalDraftErrorsByDraftId] = useState<
    Record<string, LocalThreadErrorEntry>
  >({});
  const [localServerErrorsByThreadKey, setLocalServerErrorsByThreadKey] = useState<
    Record<string, LocalThreadErrorEntry>
  >({});
  const [isConnecting, _setIsConnecting] = useState(false);
  const [isRevertingCheckpoint, setIsRevertingCheckpoint] = useState(false);
  const [maximizedRightPanelThreadKey, setMaximizedRightPanelThreadKey] = useState<string | null>(
    null,
  );
  const [respondingRequestIds, setRespondingRequestIds] = useState<ApprovalRequestId[]>([]);
  const [respondingUserInputRequestIds, setRespondingUserInputRequestIds] = useState<
    ApprovalRequestId[]
  >([]);

  useEffect(() => {
    setIsWorkspaceFileDragActive(false);
  }, [draftId, routeThreadKey]);

  useEffect(() => {
    if (!isWorkspaceFileDragActive) return;
    const clearWorkspaceFileDrag = () => setIsWorkspaceFileDragActive(false);
    window.addEventListener("dragend", clearWorkspaceFileDrag);
    return () => window.removeEventListener("dragend", clearWorkspaceFileDrag);
  }, [isWorkspaceFileDragActive]);
  const [pendingUserInputAnswersByRequestId, setPendingUserInputAnswersByRequestId] = useState<
    Record<string, Record<string, PendingUserInputDraftAnswer>>
  >({});
  const [pendingUserInputQuestionIndexByRequestId, setPendingUserInputQuestionIndexByRequestId] =
    useState<Record<string, number>>({});
  const shouldUseRightPanelSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const [terminalFocusRequestId, setTerminalFocusRequestId] = useState(0);
  const [pullRequestDialogState, setPullRequestDialogState] =
    useState<PullRequestDialogState | null>(null);
  const [terminalUiLaunchContext, setTerminalUiLaunchContext] =
    useState<TerminalLaunchContext | null>(null);
  const [attachmentPreviewHandoffByMessageId, setAttachmentPreviewHandoffByMessageId] = useState<
    Record<string, string[]>
  >({});
  const [pendingServerThreadEnvMode, setPendingServerThreadEnvMode] =
    useState<DraftThreadEnvMode | null>(null);
  const [pendingServerThreadBranch, setPendingServerThreadBranch] = useState<string | null>();
  const [
    pendingServerThreadStartFromOriginByThreadId,
    setPendingServerThreadStartFromOriginByThreadId,
  ] = useState<Record<string, boolean>>({});
  const [lastInvokedScriptByProjectId, setLastInvokedScriptByProjectId] = useLocalStorage(
    LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
    {},
    LastInvokedScriptByProjectSchema,
  );
  const legendListRef = useRef<LegendListRef | null>(null);
  const [composerOverlayElement, setComposerOverlayElement] = useState<HTMLDivElement | null>(null);
  const [composerOverlayHeight, setComposerOverlayHeight] = useState(0);
  const isAtEndRef = useRef(true);
  const attachmentPreviewHandoffByMessageIdRef = useRef<Record<string, string[]>>({});
  const attachmentPreviewPromotionInFlightByMessageIdRef = useRef<Record<string, true>>({});
  const sendInFlightRef = useRef(false);
  const feedbackUploadsInFlightRef = useRef(new Set<string>());
  const terminalUiOpenByThreadRef = useRef<Record<string, boolean>>({});

  useLayoutEffect(() => {
    if (!composerOverlayElement) return;

    const updateHeight = () => {
      const nextHeight = Math.ceil(composerOverlayElement.getBoundingClientRect().height);
      if (nextHeight <= 0) return;
      setComposerOverlayHeight((currentHeight) =>
        currentHeight === nextHeight ? currentHeight : nextHeight,
      );
    };

    updateHeight();
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(updateHeight);
    observer.observe(composerOverlayElement);
    return () => observer.disconnect();
  }, [composerOverlayElement]);

  const terminalUiState = useTerminalUiStateStore((state) =>
    selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef),
  );
  const openTerminalThreadKeys = useTerminalUiStateStore(
    useShallow((state) =>
      Object.entries(state.terminalUiStateByThreadKey).flatMap(
        ([nextThreadKey, nextTerminalUiState]) =>
          nextTerminalUiState.terminalOpen ? [nextThreadKey] : [],
      ),
    ),
  );
  const storeSetTerminalOpen = useTerminalUiStateStore((s) => s.setTerminalOpen);
  const storeEnsureTerminal = useTerminalUiStateStore((state) => state.ensureTerminal);
  const storeSplitTerminal = useTerminalUiStateStore((s) => s.splitTerminal);
  const storeSplitTerminalVertical = useTerminalUiStateStore((s) => s.splitTerminalVertical);
  const storeNewTerminal = useTerminalUiStateStore((s) => s.newTerminal);
  const storeSetActiveTerminal = useTerminalUiStateStore((s) => s.setActiveTerminal);
  const storeCloseTerminal = useTerminalUiStateStore((s) => s.closeTerminal);
  const storeClearTerminalUiState = useTerminalUiStateStore((s) => s.clearTerminalUiState);
  const serverThreadRefs = useThreadRefs();
  const serverThreadKeys = useMemo(() => serverThreadRefs.map(scopedThreadKey), [serverThreadRefs]);
  const disabledTerminalThreadRefsToClose = useMemo(
    () =>
      terminalThreadRefsToCloseWhenDisabled({
        enableTerminal: terminalEnabled,
        openTerminalThreadKeys,
      }),
    [openTerminalThreadKeys, terminalEnabled],
  );
  const draftThreadsByThreadKey = useComposerDraftStore((store) => store.draftThreadsByThreadKey);
  const draftThreadKeys = useMemo(
    () =>
      Object.values(draftThreadsByThreadKey).map((draftThread) =>
        scopedThreadKey(scopeThreadRef(draftThread.environmentId, draftThread.threadId)),
      ),
    [draftThreadsByThreadKey],
  );
  const [mountedTerminalThreadKeys, setMountedTerminalThreadKeys] = useState<string[]>([]);
  const mountedTerminalThreadRefs = useMemo(
    () =>
      mountedTerminalThreadKeys.flatMap((mountedThreadKey) => {
        const mountedThreadRef = parseScopedThreadKey(mountedThreadKey);
        return mountedThreadRef ? [{ key: mountedThreadKey, threadRef: mountedThreadRef }] : [];
      }),
    [mountedTerminalThreadKeys],
  );

  const fallbackDraftProjectRef = draftThread
    ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
    : null;
  const fallbackDraftProject = useProject(fallbackDraftProjectRef);
  const localDraftError = activeServerThread
    ? null
    : ((draftId ? localDraftErrorsByDraftId[draftId]?.message : null) ?? null);
  const localServerError = localServerErrorsByThreadKey[routeThreadKey]?.message ?? null;
  // Draft errors are keyed by draftId while server errors are keyed by thread
  // key, so a pending draft entry must migrate when the server thread loads or
  // a failed send would silently disappear on promotion. When both keys hold
  // an entry, the most recent write wins.
  useEffect(() => {
    if (!activeServerThread || !draftId) {
      return;
    }
    const pendingDraftEntry = localDraftErrorsByDraftId[draftId];
    if (pendingDraftEntry === undefined) {
      return;
    }
    setLocalDraftErrorsByDraftId((existing) => {
      if (existing[draftId] === undefined) {
        return existing;
      }
      const next = { ...existing };
      delete next[draftId];
      return next;
    });
    setLocalServerErrorsByThreadKey((existing) => {
      const currentEntry = existing[routeThreadKey];
      if (
        currentEntry !== undefined &&
        (currentEntry.at > pendingDraftEntry.at ||
          currentEntry.message === pendingDraftEntry.message)
      ) {
        return existing;
      }
      return {
        ...existing,
        [routeThreadKey]: pendingDraftEntry,
      };
    });
  }, [activeServerThread, draftId, localDraftErrorsByDraftId, routeThreadKey]);
  const localDraftThread = useMemo(
    () =>
      draftThread
        ? buildLocalDraftThread(
            threadId,
            draftThread,
            fallbackDraftProject?.defaultModelSelection ?? NO_PROVIDER_MODEL_SELECTION,
          )
        : undefined,
    [draftThread, fallbackDraftProject?.defaultModelSelection, threadId],
  );
  // Promotion is data-driven: the draft route keeps rendering while the
  // server thread (same pre-allocated ref) starts, so live state must not
  // depend on which route is mounted.
  const isServerThread = activeServerThread !== null;
  const activeThread = activeServerThread ?? localDraftThread;
  const activeThreadSubagentRelation =
    subagentConversationVisibilityEnabled && activeThread?.parentRelation?.kind === "subagent"
      ? activeThread.parentRelation
      : null;
  // Persisted session errors can only be masked. The session-scoped mask set
  // does not trigger a render on its own, so bump a tick when applying it to
  // hide the banner immediately. Mirrors the branch mismatch banner.
  const [, setThreadErrorBannerDismissTick] = useState(0);
  const runtimeMode = composerRuntimeMode ?? activeThread?.runtimeMode ?? DEFAULT_RUNTIME_MODE;
  // Plan mode is legacy (Settings → Beta). With the flag off the effective
  // mode is forced to "default" — even for threads with a stored plan mode —
  // so nobody is trapped in plan mode while its toggle is hidden. The next
  // send persists "default" back to the thread.
  const interactionMode = settings.planModeEnabled
    ? (composerInteractionMode ?? activeThread?.interactionMode ?? DEFAULT_INTERACTION_MODE)
    : DEFAULT_INTERACTION_MODE;
  const isLocalDraftThread = !isServerThread && localDraftThread !== undefined;
  const canCheckoutPullRequestIntoThread = isLocalDraftThread;
  const activeThreadId = activeThread?.id ?? null;
  const activeThreadEnvironmentId = activeThread?.environmentId ?? null;
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: activeThread?.environmentId ?? null,
    threadId: activeThreadId,
  });
  const activeThreadKnownSessionsRaw = useKnownTerminalSessions({
    environmentId: activeThread?.environmentId ?? null,
    threadId: activeThreadId,
  });
  const activeThreadKnownSessions = useMemo(() => {
    if (activeThreadId === null) {
      return [];
    }
    return activeThreadKnownSessionsRaw.filter(
      (session) => session.target.threadId === activeThreadId,
    );
  }, [activeThreadId, activeThreadKnownSessionsRaw]);
  const activeServerOrderedTerminalIds = useMemo(
    () => activeThreadKnownSessions.map((session) => session.target.terminalId),
    [activeThreadKnownSessions],
  );
  const activeKnownTerminalIds = useMemo(
    () => [...new Set([...activeServerOrderedTerminalIds, ...terminalUiState.terminalIds])],
    [activeServerOrderedTerminalIds, terminalUiState.terminalIds],
  );
  const activeTerminalLabelsById = useMemo(() => {
    const labels = new Map<string, string>();
    for (const session of activeThreadKnownSessions) {
      labels.set(
        session.target.terminalId,
        resolveTerminalSessionLabel(session.target.terminalId, session.state.summary),
      );
    }
    return labels;
  }, [activeThreadKnownSessions]);
  const activeThreadRef = useMemo(
    () =>
      activeThreadEnvironmentId && activeThreadId
        ? scopeThreadRef(activeThreadEnvironmentId, activeThreadId)
        : null,
    [activeThreadEnvironmentId, activeThreadId],
  );
  const activeThreadKey = activeThreadRef ? scopedThreadKey(activeThreadRef) : null;
  const changeRequestSnapshotByKey = useAtomValue(threadChangeRequestSnapshotsAtom);
  const [timelineAnchor, setTimelineAnchor] = useState<{
    readonly threadKey: string | null;
    readonly messageId: MessageId | null;
  }>({ threadKey: activeThreadKey, messageId: null });
  if (timelineAnchor.threadKey !== activeThreadKey) {
    setTimelineAnchor({ threadKey: activeThreadKey, messageId: null });
  }
  const timelineAnchorMessageId = timelineAnchor.messageId;
  const activeThreadParentRef = resolveSubagentParentThreadRef(activeThread);
  const openActiveThreadParent = useCallback(() => {
    if (!activeThreadParentRef) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(activeThreadParentRef),
    });
  }, [activeThreadParentRef, navigate]);
  const childConversationByAgentId = useMemo(
    () =>
      deriveAgentChildConversationByProviderId({
        activeThread,
        threadShells,
        enabled: subagentConversationVisibilityEnabled,
      }),
    [activeThread, subagentConversationVisibilityEnabled, threadShells],
  );
  const childLifecycleByAgentId = useMemo(
    () => deriveAgentChildLifecycleByProviderId({ activeThread, threadShells }),
    [activeThread, threadShells],
  );
  const childTitleByAgentId = useMemo(() => {
    const titles = new Map<string, string>();
    for (const [agentId, conversation] of childConversationByAgentId) {
      titles.set(agentId, conversation.title);
    }
    return titles;
  }, [childConversationByAgentId]);
  const openAgentConversation = useCallback(
    (agentId: string) => {
      const childConversation = childConversationByAgentId.get(agentId);
      if (!childConversation) return;
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(childConversation.threadRef),
      });
    },
    [childConversationByAgentId, navigate],
  );
  const activeRightPanelKind = useRightPanelStore((state) =>
    selectActiveRightPanel(state.byThreadKey, activeThreadRef),
  );
  const diffOpen = activeRightPanelKind === "diff";
  const rightPanelState = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, activeThreadRef),
  );
  const activeRightPanelSurface = useRightPanelStore((state) =>
    selectActiveRightPanelSurface(state.byThreadKey, activeThreadRef),
  );
  const activePanelTerminalThreadRef = useMemo(
    () =>
      activeRightPanelSurface?.kind === "terminal" &&
      activeRightPanelSurface.target &&
      activeThreadId
        ? scopeThreadRef(
            activeRightPanelSurface.target.environmentId as EnvironmentId,
            activeThreadId,
          )
        : activeThreadRef,
    [activeRightPanelSurface, activeThreadId, activeThreadRef],
  );
  const activePanelTerminalSessions = useKnownTerminalSessions({
    environmentId: activePanelTerminalThreadRef?.environmentId ?? null,
    threadId: activePanelTerminalThreadRef?.threadId ?? null,
  });
  const allocatablePanelTerminalIds = useMemo(
    () => [
      ...new Set([
        ...activePanelTerminalSessions.map((session) => session.target.terminalId),
        ...(activeRightPanelSurface?.kind === "terminal"
          ? activeRightPanelSurface.terminalIds
          : []),
      ]),
    ],
    [activePanelTerminalSessions, activeRightPanelSurface],
  );
  const [pullRequestTabStatuses, setPullRequestTabStatuses] = useState<
    Record<string, PullRequestTabStatus>
  >({});
  // Keyed by the surface the panel is showing rather than by a key rebuilt from the status, so
  // the tab is found again whether or not that surface was opened with an environment on it.
  const activePullRequestSurfaceId =
    activeRightPanelSurface?.kind === "pull-request" ? activeRightPanelSurface.id : undefined;
  const handlePullRequestTabStatusChange = useCallback(
    (status: PullRequestTabStatus) => {
      const id = activePullRequestSurfaceId;
      if (id === undefined) return;
      setPullRequestTabStatuses((current) => updatePullRequestTabStatus(current, id, status));
    },
    [activePullRequestSurfaceId],
  );
  const activePreviewState = useThreadPreviewState(activeThreadRef);
  const activePreviewServerEpoch = activePreviewState.serverEpoch;
  const resolvePreviewRuntimeTabId = useMemo(
    () =>
      activeThreadRef
        ? (tabId: string) => previewRuntimeTabId(activeThreadRef, activePreviewServerEpoch, tabId)
        : undefined,
    [activeThreadRef, activePreviewServerEpoch],
  );
  const activePreviewMiniPlayer = usePreviewMiniPlayerStore((state) =>
    selectThreadPreviewMiniPlayer(state.byThreadKey, activeThreadRef),
  );
  const panelTerminalIds = useMemo(
    () =>
      new Set(
        rightPanelState.surfaces.flatMap((surface) =>
          surface.kind === "terminal" ? surface.terminalIds : [],
        ),
      ),
    [rightPanelState.surfaces],
  );
  const previewPanelOpen = activeRightPanelKind === "preview" && isPreviewSupportedInRuntime();
  const rightPanelOpen = rightPanelState.isOpen;
  const canMaximizeRightPanel = rightPanelOpen && !shouldUseRightPanelSheet;
  const rightPanelMaximized =
    canMaximizeRightPanel && maximizedRightPanelThreadKey === routeThreadKey;
  const inlineRightPanelOwnsTitleBar = rightPanelOpen && !shouldUseRightPanelSheet;

  useEffect(() => {
    if (!activeThreadRef) return;
    useRightPanelStore
      .getState()
      .reconcileBrowserSurfaces(activeThreadRef, Object.keys(activePreviewState.sessions));
  }, [activePreviewState.sessions, activeThreadRef]);

  useEffect(() => {
    if (!activeThreadRef || !activePreviewMiniPlayer) return;
    const miniTabStillExists = Boolean(activePreviewState.sessions[activePreviewMiniPlayer.tabId]);
    const sameTabOpenInPanel =
      previewPanelOpen &&
      activeRightPanelSurface?.kind === "preview" &&
      activeRightPanelSurface.resourceId === activePreviewMiniPlayer.tabId;
    if (!miniTabStillExists || sameTabOpenInPanel) {
      usePreviewMiniPlayerStore.getState().close(activeThreadRef);
    }
  }, [
    activePreviewMiniPlayer,
    activePreviewState.sessions,
    activeRightPanelSurface,
    activeThreadRef,
    previewPanelOpen,
  ]);

  const existingThreadKeys = useMemo(() => {
    const threadKeys = new Set<string>([...serverThreadKeys, ...draftThreadKeys]);
    if (activeThreadKey) {
      threadKeys.add(activeThreadKey);
    }
    return threadKeys;
  }, [activeThreadKey, draftThreadKeys, serverThreadKeys]);
  const existingOpenTerminalThreadKeys = useMemo(
    () => openTerminalThreadKeys.filter((nextThreadKey) => existingThreadKeys.has(nextThreadKey)),
    [existingThreadKeys, openTerminalThreadKeys],
  );
  const {
    clearActiveSourceControlMetadataError,
    handleSourceControlThreadRefChange,
    sourceControlMetadataError,
  } = useSourceControlThreadMetadataRouting({
    activeThreadKey,
    activeThreadRef,
    draftId,
    expectedBranch: activeServerThread?.branch ?? null,
    hasExpectedBranchObservation: activeServerThread !== null,
    existingThreadKeys,
    isServerThread,
    setDraftThreadContext,
    updateThreadMetadata,
  });
  const { error: threadError, source: threadErrorSource } = resolveThreadErrorPresentation({
    isServerThread,
    localDraftError,
    localServerError,
    sessionError: activeServerThread?.session?.lastError ?? null,
    sourceControlMetadataError,
  });
  const threadErrorBannerKey = getThreadErrorBannerKey(routeThreadKey, threadError);
  const visibleThreadError = shouldShowThreadErrorBanner(
    routeThreadKey,
    threadError,
    isThreadErrorBannerDismissedForSession(threadErrorBannerKey),
  )
    ? threadError
    : null;
  const activeLatestTurn = activeThread?.latestTurn ?? null;
  // Reading a finished thread clears the sidebar's Done badge. The visit is
  // stamped at the turn's completion time — not now/updatedAt — so it clears
  // exactly the completion the user is looking at: a wake or completion that
  // lands later still gets its signal (markThreadVisited never moves the
  // timestamp backwards).
  useEffect(() => {
    const completedAt = serverThread?.latestTurn?.completedAt;
    if (!serverThread?.id || !completedAt) return;
    markThreadVisited(
      scopedThreadKey(scopeThreadRef(serverThread.environmentId, serverThread.id)),
      completedAt,
    );
  }, [
    markThreadVisited,
    serverThread?.environmentId,
    serverThread?.id,
    serverThread?.latestTurn?.completedAt,
  ]);
  useEffect(() => {
    setMountedTerminalThreadKeys((currentThreadIds) => {
      const nextThreadIds = reconcileMountedTerminalThreadIds({
        currentThreadIds,
        openThreadIds: existingOpenTerminalThreadKeys,
        activeThreadId: activeThreadKey,
        activeThreadTerminalOpen: Boolean(activeThreadKey && terminalUiState.terminalOpen),
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
      });
      return currentThreadIds.length === nextThreadIds.length &&
        currentThreadIds.every((nextThreadId, index) => nextThreadId === nextThreadIds[index])
        ? currentThreadIds
        : nextThreadIds;
    });
  }, [activeThreadKey, existingOpenTerminalThreadKeys, terminalUiState.terminalOpen]);
  useEffect(() => {
    if (disabledTerminalThreadRefsToClose.length === 0) return;
    for (const threadRefToClose of disabledTerminalThreadRefsToClose) {
      storeSetTerminalOpen(threadRefToClose, false);
      storeClearTerminalUiState(threadRefToClose);
    }
  }, [disabledTerminalThreadRefsToClose, storeClearTerminalUiState, storeSetTerminalOpen]);
  const latestTurnSettled = isLatestTurnSettled(activeLatestTurn, activeThread?.session ?? null);
  const activeProjectRef = useMemo(
    () =>
      activeThread ? scopeProjectRef(activeThread.environmentId, activeThread.projectId) : null,
    [activeThread?.environmentId, activeThread?.projectId],
  );
  const activeProject = useProject(activeProjectRef);
  const hasActiveProject = activeProject !== null;
  const terminalAvailable = isTerminalUiAvailable({
    enableTerminal: terminalEnabled,
    hasActiveProject,
  });
  const gitCwd = activeProject
    ? projectScriptCwd({
        project: { cwd: activeProject.workspaceRoot },
        worktreePath: activeThread?.worktreePath ?? null,
      })
    : null;
  const gitStatusCwd = activeThread?.worktreePath ?? gitCwd;
  const gitStatusQuery = useEnvironmentQuery(
    gitStatusCwd === null
      ? null
      : vcsEnvironment.status({
          environmentId,
          input: { cwd: gitStatusCwd },
        }),
  );
  // Default true while loading to avoid hiding an available panel before Git status resolves.
  const isGitRepo = gitStatusQuery.data?.isRepo ?? true;
  const {
    addSourceControlSurface,
    sourceControlAvailable,
    visibleActiveRightPanelSurface,
    visibleRightPanelSurfaces,
  } = useSourceControlRightPanelSurfaceState({
    activeRightPanelSurface,
    activeThreadRef,
    gitCwd: sourceControlPanelEnabled ? gitCwd : null,
    isGitRepo,
    rightPanelSurfaces: rightPanelState.surfaces,
  });
  const activeFileSurface =
    visibleActiveRightPanelSurface?.kind === "file" ? visibleActiveRightPanelSurface : null;
  const handleNewThreadInActiveProject = useCallback(() => {
    startNewThreadForProject(activeProjectRef, handleNewThread);
  }, [activeProjectRef, handleNewThread]);
  const activeEnvironmentShell = useEnvironmentQuery(
    activeThread ? environmentShell.stateAtom(activeThread.environmentId) : null,
  );
  const activeEnvironmentBootstrapComplete = activeEnvironmentShell.data?.snapshot._tag === "Some";
  const activeProjectKey = activeProject
    ? `${activeProject.environmentId}:${activeProject.workspaceRoot}`
    : null;
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const [pendingFileSurfaceIdsByProject, setPendingFileSurfaceIdsByProject] = useState<
    ReadonlyMap<string, ReadonlySet<string>>
  >(() => new Map());
  const pendingFileSurfaceIds = activeProjectKey
    ? (pendingFileSurfaceIdsByProject.get(activeProjectKey) ?? EMPTY_PENDING_FILE_SURFACE_IDS)
    : EMPTY_PENDING_FILE_SURFACE_IDS;
  const handleFilePendingChange = useCallback(
    (relativePath: string, pending: boolean) => {
      if (!activeProjectKey) return;
      const cwd = activeFileSurface?.cwd;
      setPendingFileSurfaceIdsByProject((currentByProject) => {
        const current = currentByProject.get(activeProjectKey) ?? EMPTY_PENDING_FILE_SURFACE_IDS;
        const surfaceId = fileSurfaceId(relativePath, cwd);
        if (current.has(surfaceId) === pending) return currentByProject;
        const next = new Set(current);
        if (pending) next.add(surfaceId);
        else next.delete(surfaceId);
        const nextByProject = new Map(currentByProject);
        if (next.size === 0) nextByProject.delete(activeProjectKey);
        else nextByProject.set(activeProjectKey, next);
        return nextByProject;
      });
    },
    [activeFileSurface?.cwd, activeProjectKey],
  );
  const configuredPreviewUrls = useMemo(
    () => getConfiguredPreviewUrls(activeProject?.scripts),
    [activeProject?.scripts],
  );

  useEffect(() => {
    if (!activeThreadRef || !activeEnvironmentBootstrapComplete) return;
    useRightPanelStore.getState().reconcileFileSurfaces(activeThreadRef, activeProject !== null);
  }, [activeEnvironmentBootstrapComplete, activeProject, activeThreadRef]);

  // Compute the list of environments this logical project spans, used to
  // drive the environment picker in BranchToolbar.
  const allProjects = useProjects();
  const primaryEnvironmentId = primaryEnvironment?.environmentId ?? null;
  useEffect(() => {
    if (!activeThreadRef || !activeProjectRef) return;
    registerFaviconProjectForThread(activeThreadRef, activeProjectRef);
  }, [activeProjectRef, activeThreadRef]);
  useEffect(() => {
    if (!clientSettingsHydrated || !activeThreadRef || !activeProject) return;
    // Reuse the sidebar's grouping so history follows the project rows the user
    // sees. Deriving the key from the active project alone would miss the
    // identity a duplicate row borrows from its siblings.
    registerChatViewThreadProject({
      threadRef: activeThreadRef,
      activeProject,
      projects: allProjects,
      settings: projectGroupingSettings,
      primaryEnvironmentId,
    });
  }, [
    activeProject,
    activeThreadRef,
    allProjects,
    clientSettingsHydrated,
    primaryEnvironmentId,
    projectGroupingSettings,
  ]);
  const activeEnvironment =
    activeThread == null ? null : (environmentById.get(activeThread.environmentId) ?? null);
  const activeEnvironmentConnectionPhase = activeEnvironment?.connection.phase ?? "available";
  const activeEnvironmentUnavailable =
    activeEnvironment !== null && activeEnvironmentConnectionPhase !== "connected";
  const activeReconnectingEnvironmentId =
    activeEnvironmentConnectionPhase === "connecting" ||
    activeEnvironmentConnectionPhase === "reconnecting"
      ? (activeEnvironment?.environmentId ?? null)
      : null;
  const [reconnectWarningGraceElapsedEnvironmentId, setReconnectWarningGraceElapsedEnvironmentId] =
    useState<EnvironmentId | null>(null);
  const reconnectWarningGraceElapsed = hasEnvironmentReconnectWarningGraceElapsed(
    activeReconnectingEnvironmentId,
    reconnectWarningGraceElapsedEnvironmentId,
  );
  useEffect(() => {
    setReconnectWarningGraceElapsedEnvironmentId(null);
    if (activeReconnectingEnvironmentId === null) return;
    return scheduleEnvironmentReconnectWarning(() =>
      setReconnectWarningGraceElapsedEnvironmentId(activeReconnectingEnvironmentId),
    );
  }, [activeReconnectingEnvironmentId]);
  const activeEnvironmentUnavailableLabel = activeEnvironment?.label ?? null;
  const activeEnvironmentUnavailableState = useMemo<EnvironmentUnavailableState | null>(() => {
    if (!activeEnvironmentUnavailable || !activeEnvironmentUnavailableLabel || !activeEnvironment) {
      return null;
    }

    return {
      environmentId: activeEnvironment.environmentId,
      label: activeEnvironmentUnavailableLabel,
      connection: activeEnvironment.connection,
    };
  }, [activeEnvironment, activeEnvironmentUnavailable, activeEnvironmentUnavailableLabel]);
  const handleReconnectActiveEnvironment = useCallback(
    async (environmentId: EnvironmentId) => {
      const result = await retryEnvironment(environmentId);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not reconnect environment",
            description: error instanceof Error ? error.message : "Failed to reconnect.",
          }),
        );
      }
    },
    [retryEnvironment],
  );
  const logicalProjectEnvironments = useMemo(() => {
    if (!activeProject) return [];
    const logicalKey = deriveLogicalProjectKeyFromSettings(activeProject, projectGroupingSettings);
    const memberProjects = allProjects.filter(
      (p) => deriveLogicalProjectKeyFromSettings(p, projectGroupingSettings) === logicalKey,
    );
    const seen = new Set<string>();
    const envs: Array<{
      environmentId: EnvironmentId;
      projectId: ProjectId;
      label: string;
      isPrimary: boolean;
      cwd: string;
      connected: boolean;
      project: {
        id: ProjectId;
        workspaceRoot: string;
        scripts: readonly ProjectScript[];
        preferredScriptId: string | null;
      };
    }> = [];
    for (const p of memberProjects) {
      if (seen.has(p.environmentId)) continue;
      seen.add(p.environmentId);
      const isPrimary = p.environmentId === primaryEnvironmentId;
      const environment = environmentById.get(p.environmentId);
      const label = environment?.label ?? p.environmentId;
      envs.push({
        environmentId: p.environmentId,
        projectId: p.id,
        label,
        isPrimary,
        cwd: p.workspaceRoot,
        connected: environment?.connection.phase === "connected",
        project: {
          id: p.id,
          workspaceRoot: p.workspaceRoot,
          scripts: p.scripts,
          preferredScriptId: lastInvokedScriptByProjectId[p.id] ?? null,
        },
      });
    }
    // Sort: primary first, then alphabetical
    envs.sort((a, b) => {
      if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
    return envs;
  }, [
    activeProject,
    allProjects,
    projectGroupingSettings,
    primaryEnvironmentId,
    environmentById,
    lastInvokedScriptByProjectId,
  ]);
  const hasMultipleEnvironments = logicalProjectEnvironments.length > 1;
  const activeEnvironmentOption =
    logicalProjectEnvironments.find(
      (environment) => environment.environmentId === activeThread?.environmentId,
    ) ?? null;
  const showComposerEnvironmentIndicator = shouldShowEnvironmentIndicator({
    activeEnvironment: activeEnvironmentOption,
    canPickEnvironment: hasMultipleEnvironments,
  });

  const openPullRequestDialog = useCallback(
    (reference?: string) => {
      if (!canCheckoutPullRequestIntoThread) {
        return;
      }
      setPullRequestDialogState({
        initialReference: reference ?? null,
        key: Date.now(),
      });
    },
    [canCheckoutPullRequestIntoThread],
  );

  const closePullRequestDialog = useCallback(() => {
    setPullRequestDialogState(null);
  }, []);

  const openOrReuseProjectDraftThread = useCallback(
    async (input: { branch: string; worktreePath: string | null; envMode: DraftThreadEnvMode }) => {
      if (!activeProject) {
        throw new Error("No active project is available for this pull request.");
      }
      const activeProjectRef = scopeProjectRef(activeProject.environmentId, activeProject.id);
      const logicalProjectKey = deriveLogicalProjectKeyFromSettings(
        activeProject,
        projectGroupingSettings,
      );
      const storedDraftSession = getDraftSessionByLogicalProjectKey(logicalProjectKey);
      if (storedDraftSession) {
        setDraftThreadContext(storedDraftSession.draftId, input);
        setLogicalProjectDraftThreadId(
          logicalProjectKey,
          activeProjectRef,
          storedDraftSession.draftId,
          {
            threadId: storedDraftSession.threadId,
            ...input,
          },
        );
        if (routeKind !== "draft" || draftId !== storedDraftSession.draftId) {
          await navigate({
            to: "/draft/$draftId",
            params: buildDraftThreadRouteParams(storedDraftSession.draftId),
          });
        }
        return storedDraftSession.threadId;
      }

      const activeDraftSession = routeKind === "draft" && draftId ? getDraftSession(draftId) : null;
      if (
        !isServerThread &&
        activeDraftSession?.logicalProjectKey === logicalProjectKey &&
        draftId
      ) {
        setDraftThreadContext(draftId, input);
        setLogicalProjectDraftThreadId(logicalProjectKey, activeProjectRef, draftId, {
          threadId: activeDraftSession.threadId,
          createdAt: activeDraftSession.createdAt,
          runtimeMode: activeDraftSession.runtimeMode,
          interactionMode: activeDraftSession.interactionMode,
          ...input,
        });
        return activeDraftSession.threadId;
      }

      const nextDraftId = newDraftId();
      const nextThreadId = newThreadId();
      setLogicalProjectDraftThreadId(logicalProjectKey, activeProjectRef, nextDraftId, {
        threadId: nextThreadId,
        createdAt: new Date().toISOString(),
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_INTERACTION_MODE,
        ...input,
      });
      await navigate({
        to: "/draft/$draftId",
        params: buildDraftThreadRouteParams(nextDraftId),
      });
      return nextThreadId;
    },
    [
      activeProject,
      draftId,
      getDraftSession,
      getDraftSessionByLogicalProjectKey,
      isServerThread,
      navigate,
      projectGroupingSettings,
      routeKind,
      setDraftThreadContext,
      setLogicalProjectDraftThreadId,
    ],
  );

  const handlePreparedPullRequestThread = useCallback(
    async (input: { branch: string; worktreePath: string | null }) => {
      await openOrReuseProjectDraftThread({
        branch: input.branch,
        worktreePath: input.worktreePath,
        envMode: input.worktreePath ? "worktree" : "local",
      });
    },
    [openOrReuseProjectDraftThread],
  );

  const selectedProviderByThreadId = composerActiveProvider ?? null;
  const threadProvider =
    activeThread?.modelSelection.instanceId ??
    activeProject?.defaultModelSelection?.instanceId ??
    null;
  // Once a thread selects an environment, never substitute the primary
  // environment's config while the selected environment is still loading.
  const serverConfig = activeThread
    ? (activeEnvironment?.serverConfig ?? null)
    : (primaryEnvironment?.serverConfig ?? null);
  const providerStatuses = serverConfig?.providers ?? EMPTY_PROVIDERS;
  const lockedProvider = deriveLockedProvider({
    thread: activeThread,
    selectedProvider: selectedProviderByThreadId,
    threadProvider,
  });
  const pullRequestsCapabilityKnown = serverConfig !== null;
  const supportsPullRequests = serverConfig?.environment.capabilities.pullRequests === true;
  const versionMismatch = resolveServerConfigVersionMismatch(serverConfig);
  const versionMismatchDismissKey =
    versionMismatch && activeThread
      ? buildVersionMismatchDismissalKey(activeThread.environmentId, versionMismatch)
      : null;
  const [dismissedVersionMismatchKey, setDismissedVersionMismatchKey] = useState<string | null>(
    null,
  );
  const versionMismatchDismissed =
    versionMismatchDismissKey === dismissedVersionMismatchKey ||
    isVersionMismatchDismissed(versionMismatchDismissKey);
  const showVersionMismatchBanner =
    versionMismatch !== null && versionMismatchDismissKey !== null && !versionMismatchDismissed;
  const hasMultipleRegisteredEnvironments = environments.length > 1;
  const versionMismatchServerLabel =
    hasMultipleRegisteredEnvironments && activeThread
      ? `${environmentById.get(activeThread.environmentId)?.label ?? serverConfig?.environment.label ?? activeThread.environmentId} server`
      : "server";
  const serverUpdateEnvironmentId = activeThread?.environmentId ?? null;
  const versionMismatchSelfUpdate = resolveServerSelfUpdateCapability(serverConfig);
  const serverUpdateState = useAtomValue(
    serverEnvironment.updateStateAtom(serverUpdateEnvironmentId),
  );
  const systemComposerBannerItems = useMemo<ComposerBannerStackItem[]>(() => {
    const items: ComposerBannerStackItem[] = [];
    const updateRunning = serverUpdateState.status === "running";
    const unavailableConnection = activeEnvironmentUnavailableState?.connection ?? null;
    const environmentReconnecting =
      unavailableConnection !== null &&
      (unavailableConnection.phase === "connecting" ||
        unavailableConnection.phase === "reconnecting");
    // Reconnecting to a version-skewed server with no update in flight
    // usually means the server is restarting mid-update and a refresh wiped
    // the in-memory update state. Fold the reconnect and version banners
    // into one calm line instead of stacking "Failed to connect" on
    // "versions differ". A failed update never folds: its error and retry
    // action must stay visible.
    const reconnectingThroughVersionSkew =
      serverUpdateState.status === "idle" && environmentReconnecting && versionMismatch !== null;
    // While an update runs, transient connect blips are expected (the server
    // restarts) and the update banner already shows progress. Hard failure
    // phases still surface so the Reconnect action stays reachable.
    const suppressUnavailableBanner =
      environmentReconnecting &&
      (updateRunning || (!reconnectingThroughVersionSkew && !reconnectWarningGraceElapsed));
    if (activeEnvironmentUnavailableState && unavailableConnection && !suppressUnavailableBanner) {
      if (reconnectingThroughVersionSkew) {
        items.push({
          id: `environment-unavailable:${activeEnvironmentUnavailableState.environmentId}`,
          variant: "default",
          // Live connection status: calm styling, but it must front the stack.
          urgent: true,
          icon: (
            <span
              className="size-1.5 animate-status-pulse rounded-full bg-foreground"
              aria-hidden="true"
            />
          ),
          title: `${unavailableConnection.phase === "connecting" ? "Connecting" : "Reconnecting"} to ${activeEnvironmentUnavailableState.label}`,
          description: "It may be finishing an update. One moment.",
        });
      } else {
        items.push({
          id: `environment-unavailable:${activeEnvironmentUnavailableState.environmentId}`,
          variant: unavailableConnection.phase === "error" ? "error" : "warning",
          icon: <WifiOffIcon />,
          title: `${activeEnvironmentUnavailableState.label}: ${connectionStatusTitle(unavailableConnection)}`,
          description:
            unavailableConnection.error ??
            "Reconnect this environment before sending messages or running actions.",
          actions: (
            <>
              <Button
                size="xs"
                disabled={environmentReconnecting}
                onClick={() =>
                  void handleReconnectActiveEnvironment(
                    activeEnvironmentUnavailableState.environmentId,
                  )
                }
              >
                {environmentReconnecting ? "Reconnecting..." : "Reconnect"}
              </Button>
              <Button
                size="xs"
                variant="outline"
                onClick={() => void navigate({ to: "/settings/connections" })}
              >
                Connections
              </Button>
            </>
          ),
        });
      }
    }
    if (
      serverUpdateEnvironmentId &&
      !reconnectingThroughVersionSkew &&
      (serverUpdateState.status !== "idle" ||
        (showVersionMismatchBanner && versionMismatch && versionMismatchDismissKey))
    ) {
      const updateInProgress = serverUpdateState.status === "running";
      const updateFailed = serverUpdateState.status === "failed";
      items.push({
        id: `server-version:${serverUpdateEnvironmentId}`,
        variant: updateFailed ? "error" : "default",
        // A running update is live progress the user is waiting on; only the
        // idle "update available" offer is calm enough to stack behind.
        urgent: updateInProgress,
        // In-flight and failed states carry their own status dot inside
        // ServerUpdateProgress; only the idle offer needs an icon.
        icon:
          updateInProgress || updateFailed ? null : (
            <span
              className="size-1.5 rounded-full border border-muted-foreground/40"
              aria-hidden="true"
            />
          ),
        title:
          updateInProgress || updateFailed ? (
            `${updateFailed ? "Could not update" : "Updating"} ${versionMismatchServerLabel}`
          ) : versionMismatch ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button type="button" className="cursor-help rounded-sm text-left">
                    Server update available
                  </button>
                }
              />
              <TooltipPopup side="top">
                {versionMismatchServerLabel} {versionMismatch.serverVersion}{" "}
                <span aria-hidden="true">→</span> {versionMismatch.clientVersion}
              </TooltipPopup>
            </Tooltip>
          ) : (
            "Server update available"
          ),
        description:
          updateInProgress || updateFailed ? (
            <ServerUpdateProgress state={serverUpdateState} />
          ) : versionMismatchSelfUpdate === "desktop-managed" ? (
            serverUpdateGuidance(versionMismatchSelfUpdate, versionMismatchServerLabel)
          ) : null,
        // The desktop-managed guidance is already the description; the action
        // slot would only repeat it.
        actions:
          updateInProgress ||
          !versionMismatch ||
          versionMismatchSelfUpdate === "desktop-managed" ? undefined : (
            <ServerUpdateAction
              environmentId={serverUpdateEnvironmentId}
              serverLabel={versionMismatchServerLabel}
              selfUpdate={versionMismatchSelfUpdate}
              targetVersion={versionMismatch.clientVersion}
              label={updateFailed ? "Retry" : "Update"}
            />
          ),
        ...(updateInProgress || updateFailed || !versionMismatchDismissKey
          ? {}
          : {
              dismissLabel: "Dismiss update notice",
              onDismiss: () => {
                dismissVersionMismatch(versionMismatchDismissKey);
                setDismissedVersionMismatchKey(versionMismatchDismissKey);
              },
            }),
      });
    }
    return items;
  }, [
    activeEnvironmentUnavailableState,
    reconnectWarningGraceElapsed,
    handleReconnectActiveEnvironment,
    navigate,
    setDismissedVersionMismatchKey,
    showVersionMismatchBanner,
    serverUpdateState,
    versionMismatch,
    versionMismatchDismissKey,
    serverUpdateEnvironmentId,
    versionMismatchSelfUpdate,
    versionMismatchServerLabel,
  ]);
  const unlockedSelectedProvider = resolveSelectableProvider(
    providerStatuses,
    selectedProviderByThreadId ?? threadProvider,
  );
  const selectedProvider: ProviderDriverKind = lockedProvider ?? unlockedSelectedProvider;
  const phase = derivePhase(activeThread?.session ?? null);
  const threadActivities = activeThread?.activities ?? EMPTY_ACTIVITIES;
  const workLogEntries = useMemo(() => deriveWorkLogEntries(threadActivities), [threadActivities]);
  const turnPlans = useMemo(() => deriveTurnPlans(threadActivities), [threadActivities]);
  // Native subagent fold: memoized by activity-list identity, shared by the
  // Agents surface, live strip, and workflow cards. v2Projection is null
  // until orchestration-v2 lands (source precedence lives in the derive).
  // sessionLive derives interruption for agents orphaned by session death.
  const agentSessionLive = phase !== "disconnected";
  const agentPanelModel = useMemo(
    () =>
      deriveAgentPanelModel({
        agents: reconcileSubagentProjectionStatuses(
          foldSubagentActivities(threadActivities, { sessionLive: agentSessionLive }),
          childLifecycleByAgentId,
        ),
      }),
    [agentSessionLive, childLifecycleByAgentId, threadActivities],
  );
  const pendingApprovals = useMemo(
    () => derivePendingApprovals(threadActivities),
    [threadActivities],
  );
  const pendingUserInputs = useMemo(
    () => derivePendingUserInputs(threadActivities),
    [threadActivities],
  );
  const activePendingUserInput = pendingUserInputs[0] ?? null;
  const activePendingDraftAnswers = useMemo(
    () =>
      activePendingUserInput
        ? (pendingUserInputAnswersByRequestId[activePendingUserInput.requestId] ??
          EMPTY_PENDING_USER_INPUT_ANSWERS)
        : EMPTY_PENDING_USER_INPUT_ANSWERS,
    [activePendingUserInput, pendingUserInputAnswersByRequestId],
  );
  const activePendingQuestionIndex = activePendingUserInput
    ? (pendingUserInputQuestionIndexByRequestId[activePendingUserInput.requestId] ?? 0)
    : 0;
  const activePendingProgress = useMemo(
    () =>
      activePendingUserInput
        ? derivePendingUserInputProgress(
            activePendingUserInput.questions,
            activePendingDraftAnswers,
            activePendingQuestionIndex,
          )
        : null,
    [activePendingDraftAnswers, activePendingQuestionIndex, activePendingUserInput],
  );
  const activePendingResolvedAnswers = useMemo(
    () =>
      activePendingUserInput
        ? buildPendingUserInputAnswers(activePendingUserInput.questions, activePendingDraftAnswers)
        : null,
    [activePendingDraftAnswers, activePendingUserInput],
  );
  const activePendingIsResponding = activePendingUserInput
    ? respondingUserInputRequestIds.includes(activePendingUserInput.requestId)
    : false;
  const activeProposedPlan = useMemo(() => {
    if (!latestTurnSettled) {
      return null;
    }
    return findLatestProposedPlan(
      activeThread?.proposedPlans ?? [],
      activeLatestTurn?.turnId ?? null,
    );
  }, [activeLatestTurn?.turnId, activeThread?.proposedPlans, latestTurnSettled]);
  const activePlan = useMemo(
    () => deriveActivePlanState(threadActivities, activeLatestTurn?.turnId ?? undefined),
    [activeLatestTurn?.turnId, threadActivities],
  );
  // Current step for the in-chat working row: only for the running turn's own
  // plan (deriveActivePlanState falls back to older turns' plans, which must
  // not label fresh work). Falls back to the first pending step so an
  // all-pending freshly written plan labels the row, matching the chip and
  // the server's planProgress.
  const workingStepLabel = useMemo(() => {
    if (!activePlan || activePlan.turnId !== (activeLatestTurn?.turnId ?? null)) {
      return null;
    }
    return (
      activePlan.steps.find((step) => step.status === "inProgress")?.step ??
      activePlan.steps.find((step) => step.status === "pending")?.step ??
      null
    );
  }, [activeLatestTurn?.turnId, activePlan]);
  const showPlanFollowUpPrompt =
    pendingUserInputs.length === 0 &&
    interactionMode === "plan" &&
    latestTurnSettled &&
    hasActionableProposedPlan(activeProposedPlan);
  const activePendingApproval = pendingApprovals[0] ?? null;
  const {
    beginMessageDispatch,
    beginNewThreadBusyState,
    resetLocalDispatch,
    localDispatchStartedAt,
    isPreparingWorktree,
    isSendBusy,
  } = useLocalDispatchState({
    activeThread,
    activeLatestTurn,
    phase,
    activePendingApproval: activePendingApproval?.requestId ?? null,
    activePendingUserInput: activePendingUserInput?.requestId ?? null,
    threadError,
  });
  const isWorking = phase === "running" || isSendBusy || isConnecting || isRevertingCheckpoint;
  const activeWorkStartedAt = deriveActiveWorkStartedAt(
    activeLatestTurn,
    activeThread?.session ?? null,
    localDispatchStartedAt,
  );
  useEffect(() => {
    attachmentPreviewHandoffByMessageIdRef.current = attachmentPreviewHandoffByMessageId;
  }, [attachmentPreviewHandoffByMessageId]);
  const clearAttachmentPreviewHandoff = useCallback(
    (messageId: MessageId, previewUrls?: ReadonlyArray<string>) => {
      delete attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId];
      const currentPreviewUrls =
        previewUrls ?? attachmentPreviewHandoffByMessageIdRef.current[messageId] ?? [];
      setAttachmentPreviewHandoffByMessageId((existing) => {
        if (!(messageId in existing)) {
          return existing;
        }
        const next = { ...existing };
        delete next[messageId];
        attachmentPreviewHandoffByMessageIdRef.current = next;
        return next;
      });
      for (const previewUrl of currentPreviewUrls) {
        revokeBlobPreviewUrl(previewUrl);
      }
    },
    [],
  );
  const clearAttachmentPreviewHandoffs = useCallback(() => {
    attachmentPreviewPromotionInFlightByMessageIdRef.current = {};
    for (const previewUrls of Object.values(attachmentPreviewHandoffByMessageIdRef.current)) {
      for (const previewUrl of previewUrls) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
    attachmentPreviewHandoffByMessageIdRef.current = {};
    setAttachmentPreviewHandoffByMessageId({});
  }, []);
  useEffect(() => {
    return () => {
      clearAttachmentPreviewHandoffs();
      for (const message of optimisticUserMessagesRef.current) {
        revokeUserMessagePreviewUrls(message);
      }
    };
  }, [clearAttachmentPreviewHandoffs]);
  const handoffAttachmentPreviews = useCallback((messageId: MessageId, previewUrls: string[]) => {
    if (previewUrls.length === 0) return;

    const previousPreviewUrls = attachmentPreviewHandoffByMessageIdRef.current[messageId] ?? [];
    const nextPreviewUrlSet = new Set(previewUrls);
    for (const previewUrl of previousPreviewUrls) {
      if (!nextPreviewUrlSet.has(previewUrl)) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
    setAttachmentPreviewHandoffByMessageId((existing) => {
      const next = {
        ...existing,
        [messageId]: previewUrls,
      };
      attachmentPreviewHandoffByMessageIdRef.current = next;
      return next;
    });
  }, []);
  const serverMessages = activeThread?.messages;
  const serverAttachmentIds = useMemo(() => {
    const attachmentIds = new Set<string>();
    for (const message of serverMessages ?? []) {
      for (const attachment of message.attachments ?? []) {
        attachmentIds.add(attachment.id);
      }
    }
    return [...attachmentIds];
  }, [serverMessages]);
  const serverAttachmentResources = useMemo(
    () =>
      serverAttachmentIds.map((attachmentId) => ({
        _tag: "attachment" as const,
        attachmentId,
      })),
    [serverAttachmentIds],
  );
  const serverAttachmentUrls = useAssetUrls(environmentId, serverAttachmentResources);
  const serverAttachmentUrlById = useMemo(
    () =>
      new Map(
        serverAttachmentIds.flatMap((attachmentId, index) => {
          const url = serverAttachmentUrls[index];
          return url ? [[attachmentId, url] as const] : [];
        }),
      ),
    [serverAttachmentIds, serverAttachmentUrls],
  );
  const displayServerMessages = useMemo<ReadonlyArray<ChatMessage>>(() => {
    if (!serverMessages) return [];
    return serverMessages.map((message) => {
      if (!message.attachments || message.attachments.length === 0) {
        return message;
      }
      return {
        ...message,
        attachments: message.attachments.map((attachment) => {
          const previewUrl = serverAttachmentUrlById.get(attachment.id);
          return previewUrl ? { ...attachment, previewUrl } : attachment;
        }),
      };
    });
  }, [serverAttachmentUrlById, serverMessages]);
  useEffect(() => {
    if (typeof Image === "undefined" || displayServerMessages.length === 0) {
      return;
    }

    const cleanups: Array<() => void> = [];
    const userMessagesById = new Map<string, ChatMessage>(
      displayServerMessages
        .filter((message) => message.role === "user")
        .map((message) => [String(message.id), message] as const),
    );

    for (const [messageId, handoffPreviewUrls] of Object.entries(
      attachmentPreviewHandoffByMessageId,
    )) {
      if (attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId]) {
        continue;
      }

      const serverMessage = userMessagesById.get(messageId);
      if (!serverMessage?.attachments || serverMessage.attachments.length === 0) {
        continue;
      }

      const serverPreviewUrls = serverMessage.attachments.flatMap((attachment) =>
        attachment.type === "image" && attachment.previewUrl ? [attachment.previewUrl] : [],
      );
      if (
        serverPreviewUrls.length === 0 ||
        serverPreviewUrls.length !== handoffPreviewUrls.length ||
        serverPreviewUrls.some((previewUrl) => previewUrl.startsWith("blob:"))
      ) {
        continue;
      }

      attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId] = true;

      let cancelled = false;
      const imageInstances: HTMLImageElement[] = [];

      const preloadServerPreviews = Promise.all(
        serverPreviewUrls.map(
          (previewUrl) =>
            new Promise<void>((resolve, reject) => {
              const image = new Image();
              imageInstances.push(image);
              const handleLoad = () => resolve();
              const handleError = () =>
                reject(new Error(`Failed to load server preview for ${messageId}.`));
              image.addEventListener("load", handleLoad, { once: true });
              image.addEventListener("error", handleError, { once: true });
              image.src = previewUrl;
            }),
        ),
      );

      void preloadServerPreviews
        .then(() => {
          if (cancelled) {
            return;
          }
          clearAttachmentPreviewHandoff(messageId as MessageId, handoffPreviewUrls);
        })
        .catch(() => {
          if (!cancelled) {
            delete attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId];
          }
        });

      cleanups.push(() => {
        cancelled = true;
        delete attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId];
        for (const image of imageInstances) {
          image.src = "";
        }
      });
    }

    return () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
  }, [attachmentPreviewHandoffByMessageId, clearAttachmentPreviewHandoff, displayServerMessages]);
  const timelineMessages = useMemo(() => {
    const messages = displayServerMessages;
    const serverMessagesWithPreviewHandoff =
      Object.keys(attachmentPreviewHandoffByMessageId).length === 0
        ? messages
        : // Spread only fires for the few messages that actually changed;
          // unchanged ones early-return their original reference.
          // In-place mutation would break React's immutable state contract.
          messages.map((message) => {
            if (
              message.role !== "user" ||
              !message.attachments ||
              message.attachments.length === 0
            ) {
              return message;
            }
            const handoffPreviewUrls = attachmentPreviewHandoffByMessageId[message.id];
            if (!handoffPreviewUrls || handoffPreviewUrls.length === 0) {
              return message;
            }

            let changed = false;
            let imageIndex = 0;
            const attachments = message.attachments.map((attachment) => {
              if (attachment.type !== "image") {
                return attachment;
              }
              const handoffPreviewUrl = handoffPreviewUrls[imageIndex];
              imageIndex += 1;
              if (!handoffPreviewUrl || attachment.previewUrl === handoffPreviewUrl) {
                return attachment;
              }
              changed = true;
              return {
                ...attachment,
                previewUrl: handoffPreviewUrl,
              };
            });

            return changed ? { ...message, attachments } : message;
          });

    const localMessages = [
      ...optimisticUserMessages,
      ...feedbackSubmissions.flatMap((submission) =>
        submission.status === "interrupted"
          ? []
          : [codexFeedbackMessage(submission), codexFeedbackMessage(submission, "assistant")],
      ),
    ];
    if (localMessages.length === 0) {
      return serverMessagesWithPreviewHandoff;
    }
    const serverIds = new Set(serverMessagesWithPreviewHandoff.map((message) => message.id));
    const pendingMessages = localMessages.filter((message) => !serverIds.has(message.id));
    if (pendingMessages.length === 0) {
      return serverMessagesWithPreviewHandoff;
    }
    return [...serverMessagesWithPreviewHandoff, ...pendingMessages];
  }, [
    attachmentPreviewHandoffByMessageId,
    displayServerMessages,
    feedbackSubmissions,
    optimisticUserMessages,
  ]);
  const timelineEntries = useMemo(
    () =>
      deriveTimelineEntries(
        timelineMessages,
        activeThread?.proposedPlans ?? [],
        workLogEntries,
        turnPlans,
      ),
    [activeThread?.proposedPlans, timelineMessages, turnPlans, workLogEntries],
  );
  const [dockedDraftHeroThreadKey, setDockedDraftHeroThreadKey] = useState<string | null>(null);
  const draftHeroDockRequested =
    activeThreadKey !== null && dockedDraftHeroThreadKey === activeThreadKey;
  const isDraftHeroState =
    isLocalDraftThread && timelineEntries.length === 0 && !isWorking && !draftHeroDockRequested;
  const [
    attachDraftHeroTransitionGroupRef,
    attachDraftHeroComposerAnchorRef,
    captureDraftHeroComposerRect,
  ] = useDraftHeroLayoutTransition(isDraftHeroState);
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } =
    useTurnDiffSummaries(activeThread);
  const turnDiffSummaryByAssistantMessageId = useMemo(() => {
    const byMessageId = new Map<MessageId, TurnDiffSummary>();
    for (const summary of turnDiffSummaries) {
      if (!summary.assistantMessageId) continue;
      byMessageId.set(summary.assistantMessageId, summary);
    }
    return byMessageId;
  }, [turnDiffSummaries]);
  const revertTurnCountByUserMessageId = useMemo(() => {
    const byUserMessageId = new Map<MessageId, number>();
    for (let index = 0; index < timelineEntries.length; index += 1) {
      const entry = timelineEntries[index];
      if (!entry || entry.kind !== "message" || entry.message.role !== "user") {
        continue;
      }

      for (let nextIndex = index + 1; nextIndex < timelineEntries.length; nextIndex += 1) {
        const nextEntry = timelineEntries[nextIndex];
        if (!nextEntry || nextEntry.kind !== "message") {
          continue;
        }
        if (nextEntry.message.role === "user") {
          break;
        }
        const summary = turnDiffSummaryByAssistantMessageId.get(nextEntry.message.id);
        if (!summary) {
          continue;
        }
        const turnCount =
          summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId];
        if (typeof turnCount !== "number") {
          break;
        }
        byUserMessageId.set(entry.message.id, Math.max(0, turnCount - 1));
        break;
      }
    }

    return byUserMessageId;
  }, [inferredCheckpointTurnCountByTurnId, timelineEntries, turnDiffSummaryByAssistantMessageId]);

  const sourceControlPanelTarget = resolveSourceControlPanelTarget({
    activeThreadRef,
    gitCwd,
    surface: visibleActiveRightPanelSurface,
  });
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const availableEditors = useAtomValue(primaryServerAvailableEditorsAtom);
  // Prefer an instance-id match so a custom Codex instance (e.g.
  // `codex_personal`) surfaces its own status/message in the banner rather
  // than the default Codex's. Falls back to first-match-by-kind when no
  // saved instance id is available or the instance no longer exists.
  const selectedProviderInstanceId =
    providerStatuses.find((status) => status.instanceId === selectedProviderByThreadId)
      ?.instanceId ?? null;
  const activeProviderInstanceId =
    selectedProviderInstanceId ??
    activeThread?.session?.providerInstanceId ??
    activeThread?.modelSelection.instanceId ??
    activeProject?.defaultModelSelection?.instanceId ??
    null;
  const activeProviderStatus = useMemo(() => {
    if (activeProviderInstanceId) {
      return (
        providerStatuses.find((status) => status.instanceId === activeProviderInstanceId) ?? null
      );
    }
    const defaultInstanceId = defaultInstanceIdForDriver(selectedProvider);
    return providerStatuses.find((status) => status.instanceId === defaultInstanceId) ?? null;
  }, [activeProviderInstanceId, providerStatuses, selectedProvider]);
  const providerStatusBannerKey = getProviderStatusBannerKey(activeProviderStatus);
  const [dismissedProviderStatusBannerKey, setDismissedProviderStatusBannerKey] = useState<
    string | null
  >(null);
  useEffect(() => {
    if (providerStatusBannerKey === null && dismissedProviderStatusBannerKey !== null) {
      setDismissedProviderStatusBannerKey(null);
    }
  }, [dismissedProviderStatusBannerKey, providerStatusBannerKey]);
  const visibleProviderStatus = shouldShowProviderStatusBanner(
    activeProviderStatus,
    dismissedProviderStatusBannerKey,
  )
    ? activeProviderStatus
    : null;
  const hasTimelineTopBanner = Boolean(visibleThreadError) || visibleProviderStatus !== null;
  const activeProjectCwd = activeProject?.workspaceRoot ?? null;
  const activeThreadWorktreePath = activeThread?.worktreePath ?? null;
  const activeWorkspaceRoot = activeThreadWorktreePath ?? activeProjectCwd ?? undefined;
  const activeTerminalLaunchContext =
    terminalUiLaunchContext?.threadId === activeThreadId ? terminalUiLaunchContext : null;
  const showComposerContextStrip = shouldShowComposerContextStrip({
    hasActiveProject: activeProject !== null,
    isGitRepo,
    showEnvironmentIndicator: showComposerEnvironmentIndicator,
  });
  const initialDiffPanelGitScope =
    gitStatusQuery.data?.hasWorkingTreeChanges === true ? "unstaged" : "branch";
  const diffPanelGitStatusResolutionKey = gitStatusQuery.data ? "resolved" : "pending";
  const terminalShortcutLabelOptions = useMemo(
    () => ({
      context: {
        terminalFocus: true,
        terminalOpen: Boolean(terminalUiState.terminalOpen),
      },
    }),
    [terminalUiState.terminalOpen],
  );
  const splitTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.split", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const splitTerminalVerticalShortcutLabel = useMemo(
    () =>
      shortcutLabelForCommand(keybindings, "terminal.splitVertical", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const newTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.new", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const closeTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.close", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const onToggleDiff = useCallback(() => {
    if (!isServerThread) {
      return;
    }
    if (!diffOpen) {
      onDiffPanelOpen?.();
    }
    if (activeThreadRef) {
      useRightPanelStore.getState().toggle(activeThreadRef, "diff");
    }
  }, [activeThreadRef, diffOpen, isServerThread, onDiffPanelOpen]);

  const envLocked = Boolean(
    activeThread &&
    (activeThread.messages.length > 0 ||
      (activeThread.session !== null && activeThread.session.status !== "stopped")),
  );

  // Handle environment change for draft threads.  When the user picks a
  // different environment we update the draft context to point at the physical
  // project in that environment while keeping the same logical project.
  const onEnvironmentChange = useCallback(
    (nextEnvironmentId: EnvironmentId) => {
      if (envLocked || !draftId) return;
      const target = logicalProjectEnvironments.find(
        (env) => env.environmentId === nextEnvironmentId,
      );
      if (!target) return;
      if (activeThreadRef) {
        retargetOpenSourceControlSurface({
          currentThreadRef: activeThreadRef,
          nextThreadRef: scopeThreadRef(target.environmentId, activeThreadRef.threadId),
        });
      }
      setDraftThreadContext(draftId, {
        projectRef: scopeProjectRef(target.environmentId, target.projectId),
      });
    },
    [activeThreadRef, draftId, envLocked, logicalProjectEnvironments, setDraftThreadContext],
  );

  const activeTerminalGroup =
    terminalUiState.terminalGroups.find(
      (group) => group.id === terminalUiState.activeTerminalGroupId,
    ) ??
    terminalUiState.terminalGroups.find((group) =>
      group.terminalIds.includes(terminalUiState.activeTerminalId),
    ) ??
    null;
  const hasReachedSplitLimit =
    (activeTerminalGroup?.terminalIds.length ?? 0) >= MAX_TERMINALS_PER_GROUP;
  const setThreadError = useCallback(
    (targetThreadId: ThreadId | null, error: string | null) => {
      if (!targetThreadId) return;
      const nextError = sanitizeThreadErrorMessage(error);
      const nextEntry: LocalThreadErrorEntry = { message: nextError, at: Date.now() };
      if (
        shouldWriteThreadErrorToCurrentServerThread({
          activeServerThread,
          routeThreadRef,
          targetThreadId,
        })
      ) {
        setLocalServerErrorsByThreadKey((existing) => {
          if ((existing[routeThreadKey]?.message ?? null) === nextError) {
            return existing;
          }
          return {
            ...existing,
            [routeThreadKey]: nextEntry,
          };
        });
        return;
      }
      const localDraftErrorKey = draftId ?? targetThreadId;
      setLocalDraftErrorsByDraftId((existing) => {
        if ((existing[localDraftErrorKey]?.message ?? null) === nextError) {
          return existing;
        }
        return {
          ...existing,
          [localDraftErrorKey]: nextEntry,
        };
      });
    },
    [activeServerThread, draftId, routeThreadKey, routeThreadRef],
  );

  const focusComposer = useCallback(() => {
    composerRef.current?.focusAtEnd();
  }, [composerRef]);
  const scheduleComposerFocus = useCallback(() => {
    window.requestAnimationFrame(() => {
      focusComposer();
    });
  }, [focusComposer]);
  const addTerminalContextToDraft = useCallback(
    (selection: TerminalContextSelection) => {
      composerRef.current?.addTerminalContext(selection);
    },
    [composerRef],
  );
  const setTerminalOpen = useCallback(
    (open: boolean) => {
      if (!activeThreadRef) return;
      if (open && !terminalEnabled) return;
      storeSetTerminalOpen(activeThreadRef, open);
    },
    [activeThreadRef, storeSetTerminalOpen, terminalEnabled],
  );
  const toggleTerminalVisibility = useCallback(() => {
    if (!activeThreadRef || !terminalEnabled) return;
    const nextOpen = !terminalUiState.terminalOpen;
    if (nextOpen && terminalUiState.terminalIds.length === 0) {
      if (!activeThreadId || !activeProject) {
        return;
      }
      const cwdForOpen = gitCwd ?? activeProject.workspaceRoot;
      if (!cwdForOpen) {
        return;
      }
      const terminalId = nextTerminalId([...activeKnownTerminalIds, ...panelTerminalIds]);
      storeEnsureTerminal(activeThreadRef, terminalId, { open: true });
      void openTerminal({
        environmentId,
        input: {
          threadId: activeThreadId,
          terminalId,
          cwd: cwdForOpen,
          ...(activeThreadWorktreePath != null ? { worktreePath: activeThreadWorktreePath } : {}),
          env: projectScriptRuntimeEnv({
            project: { cwd: activeProject.workspaceRoot },
            worktreePath: activeThreadWorktreePath,
          }),
        },
      });
      return;
    }
    setTerminalOpen(nextOpen);
  }, [
    activeKnownTerminalIds,
    activeProject,
    activeThreadId,
    activeThreadRef,
    activeThreadWorktreePath,
    environmentId,
    gitCwd,
    openTerminal,
    panelTerminalIds,
    setTerminalOpen,
    storeEnsureTerminal,
    terminalEnabled,
    terminalUiState.terminalIds.length,
    terminalUiState.terminalOpen,
  ]);
  const splitTerminal = useCallback(
    (direction: "horizontal" | "vertical" = "horizontal") => {
      if (!activeThreadRef || hasReachedSplitLimit || !activeThreadId || !activeProject) {
        return;
      }
      const cwdForOpen = gitCwd ?? activeProject.workspaceRoot;
      if (!cwdForOpen) {
        return;
      }
      const terminalId = nextTerminalId(activeKnownTerminalIds);
      if (direction === "vertical") {
        storeSplitTerminalVertical(activeThreadRef, terminalId);
      } else {
        storeSplitTerminal(activeThreadRef, terminalId);
      }
      setTerminalFocusRequestId((value) => value + 1);
      void openTerminal({
        environmentId,
        input: {
          threadId: activeThreadId,
          terminalId,
          cwd: cwdForOpen,
          ...(activeThreadWorktreePath != null ? { worktreePath: activeThreadWorktreePath } : {}),
          env: projectScriptRuntimeEnv({
            project: { cwd: activeProject.workspaceRoot },
            worktreePath: activeThreadWorktreePath,
          }),
        },
      });
    },
    [
      activeProject,
      activeKnownTerminalIds,
      activeThreadId,
      activeThreadRef,
      openTerminal,
      activeThreadWorktreePath,
      environmentId,
      gitCwd,
      hasReachedSplitLimit,
      storeSplitTerminal,
      storeSplitTerminalVertical,
    ],
  );
  const createNewTerminal = useCallback(() => {
    if (!activeThreadRef || !activeThreadId || !activeProject) {
      return;
    }
    const cwdForOpen = gitCwd ?? activeProject.workspaceRoot;
    if (!cwdForOpen) {
      return;
    }
    const terminalId = nextTerminalId(activeKnownTerminalIds);
    storeNewTerminal(activeThreadRef, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
    void openTerminal({
      environmentId,
      input: {
        threadId: activeThreadId,
        terminalId,
        cwd: cwdForOpen,
        ...(activeThreadWorktreePath != null ? { worktreePath: activeThreadWorktreePath } : {}),
        env: projectScriptRuntimeEnv({
          project: { cwd: activeProject.workspaceRoot },
          worktreePath: activeThreadWorktreePath,
        }),
      },
    });
  }, [
    activeProject,
    activeKnownTerminalIds,
    activeThreadId,
    activeThreadRef,
    openTerminal,
    activeThreadWorktreePath,
    environmentId,
    gitCwd,
    storeNewTerminal,
  ]);
  const closeTerminal = useCallback(
    (terminalId: string) => {
      if (!activeThreadId || !activeThreadRef) return;
      const fallbackExitWrite = () =>
        writeTerminal({
          environmentId,
          input: { threadId: activeThreadId, terminalId, data: "exit\n" },
        });
      void (async () => {
        const closeResult = await closeTerminalMutation({
          environmentId,
          input: {
            threadId: activeThreadId,
            terminalId,
            deleteHistory: true,
          },
        });
        if (closeResult._tag === "Failure" && !isAtomCommandInterrupted(closeResult)) {
          await fallbackExitWrite();
        }
      })();
      storeCloseTerminal(activeThreadRef, terminalId);
      setTerminalFocusRequestId((value) => value + 1);
    },
    [
      activeThreadId,
      activeThreadRef,
      closeTerminalMutation,
      environmentId,
      storeCloseTerminal,
      writeTerminal,
    ],
  );
  const runProjectScript = useCallback(
    async (
      script: ProjectScript,
      options?: {
        cwd?: string;
        env?: Record<string, string>;
        worktreePath?: string | null;
        preferNewTerminal?: boolean;
        rememberAsLastInvoked?: boolean;
      },
    ) => {
      if (!activeThreadId || !activeProject || !activeThread) return;
      if (options?.rememberAsLastInvoked !== false) {
        setLastInvokedScriptByProjectId((current) => {
          if (current[activeProject.id] === script.id) return current;
          return { ...current, [activeProject.id]: script.id };
        });
      }
      const targetCwd = options?.cwd ?? gitCwd ?? activeProject.workspaceRoot;
      const baseTerminalId =
        terminalUiState.activeTerminalId || activeKnownTerminalIds[0] || DEFAULT_THREAD_TERMINAL_ID;
      const isBaseTerminalBusy = runningTerminalIds.includes(baseTerminalId);
      const wantsNewTerminal = Boolean(options?.preferNewTerminal) || isBaseTerminalBusy;
      const shouldCreateNewTerminal = wantsNewTerminal;
      const targetWorktreePath = options?.worktreePath ?? activeThread.worktreePath ?? null;

      setTerminalUiLaunchContext({
        threadId: activeThreadId,
        cwd: targetCwd,
        worktreePath: targetWorktreePath,
      });
      setTerminalOpen(true);
      if (!activeThreadRef) {
        return;
      }
      setTerminalFocusRequestId((value) => value + 1);

      const runtimeEnv = projectScriptRuntimeEnv({
        project: {
          cwd: activeProject.workspaceRoot,
        },
        worktreePath: targetWorktreePath,
        ...(options?.env ? { extraEnv: options.env } : {}),
      });
      const targetTerminalId = shouldCreateNewTerminal
        ? nextTerminalId(activeKnownTerminalIds)
        : baseTerminalId;
      const openTerminalInput: TerminalOpenInput = shouldCreateNewTerminal
        ? {
            threadId: activeThreadId,
            terminalId: targetTerminalId,
            cwd: targetCwd,
            ...(targetWorktreePath !== null ? { worktreePath: targetWorktreePath } : {}),
            env: runtimeEnv,
            cols: SCRIPT_TERMINAL_COLS,
            rows: SCRIPT_TERMINAL_ROWS,
          }
        : {
            threadId: activeThreadId,
            terminalId: targetTerminalId,
            cwd: targetCwd,
            ...(targetWorktreePath !== null ? { worktreePath: targetWorktreePath } : {}),
            env: runtimeEnv,
          };

      if (shouldCreateNewTerminal) {
        storeNewTerminal(activeThreadRef, targetTerminalId);
      } else {
        storeSetActiveTerminal(activeThreadRef, targetTerminalId);
      }

      const openResult = await openTerminal({ environmentId, input: openTerminalInput });
      if (openResult._tag === "Failure") {
        if (!isAtomCommandInterrupted(openResult)) {
          const error = squashAtomCommandFailure(openResult);
          setThreadError(
            activeThreadId,
            error instanceof Error ? error.message : `Failed to run script "${script.name}".`,
          );
        }
        return;
      }

      const writeResult = await writeTerminal({
        environmentId,
        input: {
          threadId: activeThreadId,
          terminalId: targetTerminalId,
          data: `${script.command}\r`,
        },
      });
      if (writeResult._tag === "Failure" && !isAtomCommandInterrupted(writeResult)) {
        const error = squashAtomCommandFailure(writeResult);
        setThreadError(
          activeThreadId,
          error instanceof Error ? error.message : `Failed to run script "${script.name}".`,
        );
      }
    },
    [
      activeProject,
      activeThread,
      activeThreadId,
      activeThreadRef,
      gitCwd,
      setTerminalOpen,
      setThreadError,
      storeNewTerminal,
      storeSetActiveTerminal,
      setLastInvokedScriptByProjectId,
      environmentId,
      openTerminal,
      activeKnownTerminalIds,
      runningTerminalIds,
      terminalUiState.activeTerminalId,
      writeTerminal,
    ],
  );

  const runSourceControlProjectScript = useCallback(
    async (target: SourceControlProjectActionTarget, script: ProjectScript) => {
      if (!activeThreadRef) return;

      setLastInvokedScriptByProjectId((current) =>
        current[target.projectId] === script.id
          ? current
          : { ...current, [target.projectId]: script.id },
      );
      const terminalId = `action-${randomUUID()}`;
      const terminalTarget = {
        environmentId: target.environmentId,
        projectId: target.projectId,
        cwd: target.cwd,
        worktreePath: target.worktreePath,
        label: `${script.name} · ${target.environmentLabel}`,
      };
      useRightPanelStore.getState().openTerminal(activeThreadRef, terminalId, terminalTarget);
      setTerminalFocusRequestId((value) => value + 1);

      const runtimeEnv = projectScriptRuntimeEnv({
        project: { cwd: target.projectCwd },
        worktreePath: target.worktreePath,
      });
      const openResult = await openTerminal({
        environmentId: target.environmentId,
        input: {
          threadId: activeThreadRef.threadId,
          terminalId,
          cwd: target.cwd,
          ...(target.worktreePath !== null ? { worktreePath: target.worktreePath } : {}),
          env: runtimeEnv,
          cols: SCRIPT_TERMINAL_COLS,
          rows: SCRIPT_TERMINAL_ROWS,
        },
      });
      if (openResult._tag === "Failure") {
        useRightPanelStore
          .getState()
          .closeSurface(activeThreadRef, terminalSurfaceId(terminalId, terminalTarget));
        if (!isAtomCommandInterrupted(openResult)) {
          const error = squashAtomCommandFailure(openResult);
          setThreadError(
            activeThreadRef.threadId,
            error instanceof Error ? error.message : `Failed to run action "${script.name}".`,
          );
        }
        return;
      }

      const writeResult = await writeTerminal({
        environmentId: target.environmentId,
        input: {
          threadId: activeThreadRef.threadId,
          terminalId,
          data: `${script.command}\r`,
        },
      });
      if (writeResult._tag === "Failure" && !isAtomCommandInterrupted(writeResult)) {
        const error = squashAtomCommandFailure(writeResult);
        setThreadError(
          activeThreadRef.threadId,
          error instanceof Error ? error.message : `Failed to run action "${script.name}".`,
        );
      }
    },
    [activeThreadRef, openTerminal, setLastInvokedScriptByProjectId, setThreadError, writeTerminal],
  );

  const persistProjectScripts = useCallback(
    async (input: {
      environmentId: EnvironmentId;
      projectId: ProjectId;
      projectCwd: string;
      previousScripts: ReadonlyArray<ProjectScript>;
      nextScripts: ReadonlyArray<ProjectScript>;
      keybinding?: string | null;
      keybindingCommand: KeybindingCommand;
    }): Promise<AtomCommandResult<void, unknown>> => {
      const updateResult = mapAtomCommandResult(
        await updateProject({
          environmentId: input.environmentId,
          input: {
            projectId: input.projectId,
            scripts: input.nextScripts,
          },
        }),
        () => undefined,
      );
      if (updateResult._tag === "Failure") {
        return updateResult;
      }

      const keybindingRule = decodeProjectScriptKeybindingRule({
        keybinding: input.keybinding,
        command: input.keybindingCommand,
      });

      if (isElectron && keybindingRule) {
        return mapAtomCommandResult(
          await upsertKeybinding({
            environmentId: input.environmentId,
            input: keybindingRule,
          }),
          () => undefined,
        );
      }
      return updateResult;
    },
    [updateProject, upsertKeybinding],
  );
  const saveProjectScriptForTarget = useCallback(
    async (
      target: SourceControlProjectActionTarget,
      input: NewProjectScriptInput,
    ): Promise<AtomCommandResult<void, unknown>> => {
      const nextId = nextProjectScriptId(
        input.name,
        target.scripts.map((script) => script.id),
      );
      const nextScript = buildProjectScript(nextId, input);
      const nextScripts = input.runOnWorktreeCreate
        ? [
            ...target.scripts.map((script) =>
              script.runOnWorktreeCreate ? { ...script, runOnWorktreeCreate: false } : script,
            ),
            nextScript,
          ]
        : [...target.scripts, nextScript];

      return persistProjectScripts({
        environmentId: target.environmentId,
        projectId: target.projectId,
        projectCwd: target.projectCwd,
        previousScripts: target.scripts,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(nextId),
      });
    },
    [persistProjectScripts],
  );
  const updateProjectScriptForTarget = useCallback(
    async (
      target: SourceControlProjectActionTarget,
      scriptId: string,
      input: NewProjectScriptInput,
    ): Promise<AtomCommandResult<void, unknown>> => {
      const existingScript = target.scripts.find((script) => script.id === scriptId);
      if (!existingScript) {
        return AsyncResult.failure(Cause.fail(new Error("Script not found.")));
      }

      const updatedScript = buildProjectScript(existingScript.id, input);
      const nextScripts = target.scripts.map((script) =>
        script.id === scriptId
          ? updatedScript
          : input.runOnWorktreeCreate
            ? { ...script, runOnWorktreeCreate: false }
            : script,
      );

      return persistProjectScripts({
        environmentId: target.environmentId,
        projectId: target.projectId,
        projectCwd: target.projectCwd,
        previousScripts: target.scripts,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(scriptId),
      });
    },
    [persistProjectScripts],
  );
  const deleteProjectScriptForTarget = useCallback(
    async (
      target: SourceControlProjectActionTarget,
      scriptId: string,
    ): Promise<AtomCommandResult<void, unknown>> => {
      const nextScripts = target.scripts.filter((script) => script.id !== scriptId);

      const deletedName = target.scripts.find((script) => script.id === scriptId)?.name;

      const result = await persistProjectScripts({
        environmentId: target.environmentId,
        projectId: target.projectId,
        projectCwd: target.projectCwd,
        previousScripts: target.scripts,
        nextScripts,
        keybinding: null,
        keybindingCommand: commandForProjectScript(scriptId),
      });
      if (result._tag === "Success") {
        toastManager.add({
          type: "success",
          title: `Deleted action "${deletedName ?? "Unknown"}"`,
        });
      } else if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not delete action",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          }),
        );
      }
      return result;
    },
    [persistProjectScripts],
  );
  const activeProjectActionTarget = useMemo<SourceControlProjectActionTarget | null>(
    () =>
      activeProject
        ? {
            environmentId,
            environmentLabel: activeEnvironment?.label ?? environmentId,
            projectId: activeProject.id,
            cwd: gitCwd ?? activeProject.workspaceRoot,
            projectCwd: activeProject.workspaceRoot,
            worktreePath: activeThreadWorktreePath,
            scripts: activeProject.scripts,
          }
        : null,
    [activeEnvironment?.label, activeProject, activeThreadWorktreePath, environmentId, gitCwd],
  );
  const saveProjectScript = useCallback(
    (input: NewProjectScriptInput): Promise<AtomCommandResult<void, unknown>> =>
      activeProjectActionTarget
        ? saveProjectScriptForTarget(activeProjectActionTarget, input)
        : Promise.resolve(AsyncResult.success(undefined)),
    [activeProjectActionTarget, saveProjectScriptForTarget],
  );
  const updateProjectScript = useCallback(
    (scriptId: string, input: NewProjectScriptInput): Promise<AtomCommandResult<void, unknown>> =>
      activeProjectActionTarget
        ? updateProjectScriptForTarget(activeProjectActionTarget, scriptId, input)
        : Promise.resolve(AsyncResult.success(undefined)),
    [activeProjectActionTarget, updateProjectScriptForTarget],
  );
  const deleteProjectScript = useCallback(
    (scriptId: string): Promise<AtomCommandResult<void, unknown>> =>
      activeProjectActionTarget
        ? deleteProjectScriptForTarget(activeProjectActionTarget, scriptId)
        : Promise.resolve(AsyncResult.success(undefined)),
    [activeProjectActionTarget, deleteProjectScriptForTarget],
  );

  const handleRuntimeModeChange = useCallback(
    (mode: RuntimeMode) => {
      if (mode === runtimeMode) return;
      setComposerDraftRuntimeMode(composerDraftTarget, mode);
      if (isLocalDraftThread) {
        setDraftThreadContext(composerDraftTarget, { runtimeMode: mode });
      }
      scheduleComposerFocus();
    },
    [
      isLocalDraftThread,
      runtimeMode,
      scheduleComposerFocus,
      composerDraftTarget,
      setComposerDraftRuntimeMode,
      setDraftThreadContext,
    ],
  );

  const handleInteractionModeChange = useCallback(
    (mode: ProviderInteractionMode) => {
      if (mode === interactionMode) return;
      setComposerDraftInteractionMode(composerDraftTarget, mode);
      if (isLocalDraftThread) {
        setDraftThreadContext(composerDraftTarget, { interactionMode: mode });
      }
      scheduleComposerFocus();
    },
    [
      interactionMode,
      isLocalDraftThread,
      scheduleComposerFocus,
      composerDraftTarget,
      setComposerDraftInteractionMode,
      setDraftThreadContext,
    ],
  );
  const toggleInteractionMode = useCallback(() => {
    handleInteractionModeChange(interactionMode === "plan" ? "default" : "plan");
  }, [handleInteractionModeChange, interactionMode]);
  const createBrowserSurface = useCallback(() => {
    if (!activeThreadRef) return;
    void addBrowserSurface({ threadRef: activeThreadRef, openPreview });
  }, [activeThreadRef, openPreview]);
  const addDiffSurface = useCallback(() => {
    if (!activeThreadRef || !isServerThread || !isGitRepo) return;
    useRightPanelStore.getState().open(activeThreadRef, "diff");
    onDiffPanelOpen?.();
  }, [activeThreadRef, isGitRepo, isServerThread, onDiffPanelOpen]);

  const dismissThreadError = useCallback(() => {
    const action = resolveThreadErrorDismissAction(threadErrorSource);
    if (action === "clear-thread") {
      setThreadError(activeThreadId, null);
    } else if (action === "clear-source-control") {
      clearActiveSourceControlMetadataError();
    } else {
      dismissThreadErrorBannerForSession(threadErrorBannerKey);
      setThreadErrorBannerDismissTick((tick) => tick + 1);
    }
  }, [
    activeThreadId,
    clearActiveSourceControlMetadataError,
    setThreadError,
    threadErrorBannerKey,
    threadErrorSource,
  ]);
  const addFilesSurface = useCallback(() => {
    if (!activeThreadRef || !activeProject) return;
    useRightPanelStore.getState().open(activeThreadRef, "files");
  }, [activeProject, activeThreadRef]);
  const addAgentsSurface = useCallback(() => {
    if (!activeThreadRef) return;
    useRightPanelStore.getState().open(activeThreadRef, "agents");
  }, [activeThreadRef]);
  const addMagiSurface = useCallback(() => {
    if (!activeThreadRef || (!isServerThread && !isLocalDraftThread)) return;
    useRightPanelStore.getState().open(activeThreadRef, "magi");
  }, [activeThreadRef, isLocalDraftThread, isServerThread]);
  const openFileSurface = useCallback(
    (relativePath: string) => {
      if (!activeThreadRef || !activeProject) return;
      useRightPanelStore
        .getState()
        .openFile(activeThreadRef, relativePath, undefined, activeFileSurface?.cwd);
    },
    [activeFileSurface?.cwd, activeProject, activeThreadRef],
  );
  // The thread's own change request, placed against the project it belongs to. Without a
  // project there is nothing to resolve it against, so the caller falls back to the browser.
  const threadRepository = activeProject?.repositoryIdentity?.displayName ?? null;
  const openThreadPullRequest = useCallback(
    (number: number) => {
      if (
        !supportsPullRequests ||
        !activeThreadRef ||
        !activeProject ||
        threadRepository === null
      ) {
        return;
      }
      useRightPanelStore.getState().openPullRequest(activeThreadRef, {
        projectId: activeProject.id,
        repository: threadRepository,
        number,
      });
    },
    [activeProject, activeThreadRef, supportsPullRequests, threadRepository],
  );
  const togglePreviewPanel = useCallback(() => {
    if (!activeThreadRef || !isPreviewSupportedInRuntime()) return;
    if (previewPanelOpen) {
      useRightPanelStore.getState().close(activeThreadRef);
      return;
    }
    const activeTabId = activePreviewState.activeTabId;
    if (activeTabId) {
      useRightPanelStore.getState().openBrowser(activeThreadRef, activeTabId);
    } else {
      createBrowserSurface();
    }
  }, [activePreviewState.activeTabId, activeThreadRef, createBrowserSurface, previewPanelOpen]);
  const closePreviewPanel = useCallback(() => {
    if (activeThreadRef) {
      setMaximizedRightPanelThreadKey(null);
      useRightPanelStore.getState().close(activeThreadRef);
    }
  }, [activeThreadRef]);
  const activePanelTerminalTarget =
    activeRightPanelSurface?.kind === "terminal" ? activeRightPanelSurface.target : undefined;
  const activePanelTerminalProject = activePanelTerminalTarget
    ? (allProjects.find(
        (project) =>
          project.environmentId === activePanelTerminalTarget.environmentId &&
          project.id === activePanelTerminalTarget.projectId,
      ) ?? null)
    : activeProject;
  const addTerminalSurface = useCallback(() => {
    if (!activeThreadRef || !activeThreadId || !activePanelTerminalProject) return;
    const cwd =
      activePanelTerminalTarget?.cwd ?? gitCwd ?? activePanelTerminalProject.workspaceRoot;
    const worktreePath = activePanelTerminalTarget
      ? activePanelTerminalTarget.worktreePath
      : activeThreadWorktreePath;
    const terminalId = nextTerminalId(
      activePanelTerminalTarget
        ? allocatablePanelTerminalIds
        : [...activeKnownTerminalIds, ...panelTerminalIds],
    );
    useRightPanelStore
      .getState()
      .openTerminal(activeThreadRef, terminalId, activePanelTerminalTarget);
    setTerminalFocusRequestId((value) => value + 1);
    void openTerminal({
      environmentId:
        (activePanelTerminalTarget?.environmentId as EnvironmentId | undefined) ??
        activeThreadRef.environmentId,
      input: {
        threadId: activeThreadId,
        terminalId,
        cwd,
        ...(worktreePath != null ? { worktreePath } : {}),
        env: projectScriptRuntimeEnv({
          project: { cwd: activePanelTerminalProject.workspaceRoot },
          worktreePath,
        }),
      },
    });
  }, [
    activeKnownTerminalIds,
    activePanelTerminalProject,
    activePanelTerminalTarget,
    activeThreadId,
    activeThreadRef,
    activeThreadWorktreePath,
    allocatablePanelTerminalIds,
    gitCwd,
    openTerminal,
    panelTerminalIds,
  ]);
  const splitPanelTerminal = useCallback(
    (direction: "horizontal" | "vertical" = "horizontal") => {
      if (!terminalEnabled) return;
      if (
        !activeThreadRef ||
        !activeThreadId ||
        !activePanelTerminalProject ||
        activeRightPanelSurface?.kind !== "terminal" ||
        activeRightPanelSurface.terminalIds.length >= MAX_TERMINALS_PER_GROUP
      ) {
        return;
      }
      const terminalId = nextTerminalId(
        activePanelTerminalTarget
          ? allocatablePanelTerminalIds
          : [...activeKnownTerminalIds, ...panelTerminalIds],
      );
      const cwd =
        activePanelTerminalTarget?.cwd ?? gitCwd ?? activePanelTerminalProject.workspaceRoot;
      const worktreePath = activePanelTerminalTarget
        ? activePanelTerminalTarget.worktreePath
        : activeThreadWorktreePath;
      useRightPanelStore
        .getState()
        .splitTerminal(activeThreadRef, activeRightPanelSurface.id, terminalId, direction);
      setTerminalFocusRequestId((value) => value + 1);
      void openTerminal({
        environmentId:
          (activePanelTerminalTarget?.environmentId as EnvironmentId | undefined) ??
          activeThreadRef.environmentId,
        input: {
          threadId: activeThreadId,
          terminalId,
          cwd,
          ...(worktreePath != null ? { worktreePath } : {}),
          env: projectScriptRuntimeEnv({
            project: { cwd: activePanelTerminalProject.workspaceRoot },
            worktreePath,
          }),
        },
      });
    },
    [
      activeKnownTerminalIds,
      activePanelTerminalProject,
      activePanelTerminalTarget,
      activeRightPanelSurface,
      activeThreadId,
      activeThreadRef,
      activeThreadWorktreePath,
      allocatablePanelTerminalIds,
      gitCwd,
      openTerminal,
      panelTerminalIds,
      terminalEnabled,
    ],
  );
  const splitPanelTerminalVertical = useCallback(() => {
    splitPanelTerminal("vertical");
  }, [splitPanelTerminal]);
  const activatePanelTerminal = useCallback(
    (terminalId: string) => {
      if (!activeThreadRef || activeRightPanelSurface?.kind !== "terminal") return;
      useRightPanelStore
        .getState()
        .activateTerminal(activeThreadRef, activeRightPanelSurface.id, terminalId);
      setTerminalFocusRequestId((value) => value + 1);
    },
    [activeRightPanelSurface, activeThreadRef],
  );
  const closePanelTerminal = useCallback(
    (terminalId: string) => {
      if (!activeThreadRef || activeRightPanelSurface?.kind !== "terminal") return;
      const terminalThreadRef = activeRightPanelSurface.target
        ? scopeThreadRef(
            activeRightPanelSurface.target.environmentId as EnvironmentId,
            activeThreadRef.threadId,
          )
        : activeThreadRef;
      void closeTerminalMutation({
        environmentId: terminalThreadRef.environmentId,
        input: { threadId: activeThreadRef.threadId, terminalId, deleteHistory: true },
      });
      storeCloseTerminal(terminalThreadRef, terminalId);
      useRightPanelStore
        .getState()
        .closeTerminal(activeThreadRef, activeRightPanelSurface.id, terminalId);
      setTerminalFocusRequestId((value) => value + 1);
    },
    [activeRightPanelSurface, activeThreadRef, closeTerminalMutation, storeCloseTerminal],
  );
  const requestCloseTerminal = useCallback(
    (terminalId: string) => {
      const label = activeTerminalLabelsById.get(terminalId) ?? getTerminalLabel(terminalId);
      void confirmTerminalClose([label]).then((confirmed) => {
        if (confirmed) closeTerminal(terminalId);
      });
    },
    [activeTerminalLabelsById, closeTerminal],
  );
  const requestClosePanelTerminal = useCallback(
    (terminalId: string) => {
      const label =
        (activeRightPanelSurface?.kind === "terminal"
          ? activeRightPanelSurface.target?.label
          : undefined) ??
        activeTerminalLabelsById.get(terminalId) ??
        getTerminalLabel(terminalId);
      void confirmTerminalClose([label]).then((confirmed) => {
        if (confirmed) closePanelTerminal(terminalId);
      });
    },
    [activeRightPanelSurface, activeTerminalLabelsById, closePanelTerminal],
  );
  const activateRightPanelSurface = useCallback(
    (surface: RightPanelSurface) => {
      if (!activeThreadRef) return;
      useRightPanelStore.getState().activateSurface(activeThreadRef, surface.id);
      if (surface.kind === "preview" && surface.resourceId) {
        setActivePreviewTab(activeThreadRef, surface.resourceId);
      }
      if (surface.kind === "terminal") {
        setTerminalFocusRequestId((value) => value + 1);
      }
      if (surface.kind === "diff" && !diffOpen) {
        onDiffPanelOpen?.();
      }
    },
    [activeThreadRef, diffOpen, onDiffPanelOpen],
  );
  const toggleRightPanel = useCallback(() => {
    if (!activeThreadRef) return;
    if (rightPanelOpen) {
      closePreviewPanel();
      return;
    }
    useRightPanelStore.getState().toggleVisibility(activeThreadRef);
  }, [activeThreadRef, closePreviewPanel, rightPanelOpen]);
  const toggleRightPanelMaximized = useCallback(() => {
    if (!canMaximizeRightPanel) return;
    setMaximizedRightPanelThreadKey((threadKey) =>
      threadKey === routeThreadKey ? null : routeThreadKey,
    );
  }, [canMaximizeRightPanel, routeThreadKey]);
  const cleanupRightPanelSurfaces = useCallback(
    (surfaces: readonly RightPanelSurface[]) => {
      if (!activeThreadRef) return;
      for (const surface of surfaces) {
        if (surface.kind === "preview" && surface.resourceId) {
          void closePreviewSession({
            closePreview,
            snapshot: activePreviewState.sessions[surface.resourceId] ?? null,
            tabId: surface.resourceId,
            threadRef: activeThreadRef,
          });
        }
        if (surface.kind === "terminal") {
          const terminalThreadRef = surface.target
            ? scopeThreadRef(
                surface.target.environmentId as EnvironmentId,
                activeThreadRef.threadId,
              )
            : activeThreadRef;
          for (const terminalId of surface.terminalIds) {
            storeCloseTerminal(terminalThreadRef, terminalId);
            void closeTerminalMutation({
              environmentId: terminalThreadRef.environmentId,
              input: { threadId: terminalThreadRef.threadId, terminalId, deleteHistory: true },
            });
          }
        }
      }
    },
    [
      activeThreadRef,
      activePreviewState.sessions,
      closePreview,
      closeTerminalMutation,
      storeCloseTerminal,
    ],
  );
  const syncActivePreviewSurface = useCallback(() => {
    if (!activeThreadRef) return;
    const nextActiveSurface = selectActiveRightPanelSurface(
      useRightPanelStore.getState().byThreadKey,
      activeThreadRef,
    );
    if (nextActiveSurface?.kind === "preview" && nextActiveSurface.resourceId) {
      setActivePreviewTab(activeThreadRef, nextActiveSurface.resourceId);
    }
  }, [activeThreadRef]);
  const closeRightPanelSurface = useCallback(
    (surface: RightPanelSurface) => {
      if (!activeThreadRef) return;
      const finishClose = () => {
        cleanupRightPanelSurfaces([surface]);
        useRightPanelStore.getState().closeSurface(activeThreadRef, surface.id);
        syncActivePreviewSurface();
      };
      if (surface.kind !== "terminal") {
        finishClose();
        return;
      }
      const activeLabel =
        surface.target?.label ??
        activeTerminalLabelsById.get(surface.activeTerminalId) ??
        getTerminalLabel(surface.activeTerminalId);
      const otherLabels = surface.terminalIds
        .filter((terminalId) => terminalId !== surface.activeTerminalId)
        .map(
          (terminalId) => activeTerminalLabelsById.get(terminalId) ?? getTerminalLabel(terminalId),
        );
      void confirmTerminalClose([activeLabel, ...otherLabels]).then((confirmed) => {
        if (confirmed) finishClose();
      });
    },
    [
      activeThreadRef,
      activeTerminalLabelsById,
      cleanupRightPanelSurfaces,
      syncActivePreviewSurface,
    ],
  );
  const closeOtherRightPanelSurfaces = useCallback(
    (surface: RightPanelSurface) => {
      if (!activeThreadRef) return;
      const surfaces = rightPanelState.surfaces.filter((entry) => entry.id !== surface.id);
      cleanupRightPanelSurfaces(surfaces);
      useRightPanelStore.getState().closeOtherSurfaces(activeThreadRef, surface.id);
      syncActivePreviewSurface();
    },
    [
      activeThreadRef,
      cleanupRightPanelSurfaces,
      rightPanelState.surfaces,
      syncActivePreviewSurface,
    ],
  );
  const closeRightPanelSurfacesToRight = useCallback(
    (surface: RightPanelSurface) => {
      if (!activeThreadRef) return;
      const surfaceIndex = rightPanelState.surfaces.findIndex((entry) => entry.id === surface.id);
      if (surfaceIndex < 0) return;
      const surfaces = rightPanelState.surfaces.slice(surfaceIndex + 1);
      cleanupRightPanelSurfaces(surfaces);
      useRightPanelStore.getState().closeSurfacesToRight(activeThreadRef, surface.id);
      syncActivePreviewSurface();
    },
    [
      activeThreadRef,
      cleanupRightPanelSurfaces,
      rightPanelState.surfaces,
      syncActivePreviewSurface,
    ],
  );
  const closeAllRightPanelSurfaces = useCallback(() => {
    if (!activeThreadRef) return;
    cleanupRightPanelSurfaces(rightPanelState.surfaces);
    useRightPanelStore.getState().closeAllSurfaces(activeThreadRef);
  }, [activeThreadRef, cleanupRightPanelSurfaces, rightPanelState.surfaces]);
  const copyRightPanelFilePath = useCallback((relativePath: string) => {
    if (typeof window === "undefined" || !navigator.clipboard?.writeText) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy path",
          description: "Clipboard API unavailable.",
        }),
      );
      return;
    }

    void navigator.clipboard.writeText(relativePath).then(
      () => {
        toastManager.add({
          type: "success",
          title: "Path copied",
          description: relativePath,
        });
      },
      (error) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to copy path",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      },
    );
  }, []);
  useEffect(
    () =>
      subscribePreviewAction((action) => {
        if (action === "toggle-panel") togglePreviewPanel();
      }),
    [togglePreviewPanel],
  );
  const persistThreadSettingsForNextTurn = useCallback(
    async (input: {
      threadId: ThreadId;
      createdAt: string;
      modelSelection?: ModelSelection;
      branch?: string;
      runtimeMode: RuntimeMode;
      interactionMode: ProviderInteractionMode;
    }): Promise<AtomCommandResult<void, unknown>> => {
      if (!serverThread) {
        return AsyncResult.success(undefined);
      }

      let result: AtomCommandResult<void, unknown> = AsyncResult.success(undefined);
      const metadataUpdate = resolveThreadMetadataUpdateForNextTurn({
        currentModelSelection: serverThread.modelSelection,
        ...(input.modelSelection ? { nextModelSelection: input.modelSelection } : {}),
        currentBranch: serverThread.branch,
        ...(input.branch ? { nextBranch: input.branch } : {}),
      });
      if (metadataUpdate) {
        result = mapAtomCommandResult(
          await updateThreadMetadata({
            environmentId,
            input: {
              threadId: input.threadId,
              ...metadataUpdate,
            },
          }),
          () => undefined,
        );
        if (result._tag === "Failure") {
          return result;
        }
      }

      if (input.runtimeMode !== serverThread.runtimeMode) {
        result = mapAtomCommandResult(
          await setThreadRuntimeMode({
            environmentId,
            input: {
              threadId: input.threadId,
              runtimeMode: input.runtimeMode,
              createdAt: input.createdAt,
            },
          }),
          () => undefined,
        );
        if (result._tag === "Failure") {
          return result;
        }
      }

      if (input.interactionMode !== serverThread.interactionMode) {
        result = mapAtomCommandResult(
          await setThreadInteractionMode({
            environmentId,
            input: {
              threadId: input.threadId,
              interactionMode: input.interactionMode,
              createdAt: input.createdAt,
            },
          }),
          () => undefined,
        );
      }
      return result;
    },
    [
      environmentId,
      serverThread,
      setThreadInteractionMode,
      setThreadRuntimeMode,
      updateThreadMetadata,
    ],
  );

  // Debounce *showing* the scroll-to-bottom pill so it doesn't flash during
  // thread switches. LegendList fires scroll events with isAtEnd=false while
  // initialScrollAtEnd is settling; hiding is always immediate.
  const showScrollDebouncer = useRef(
    new Debouncer(() => setShowScrollToBottom(true), { wait: 150 }),
  );
  const timelineScrollModeRef = useRef<TimelineScrollMode>("following-end");
  // State mirror of the follow mode refs. LegendList's maintainScrollAtEnd
  // re-pins on its own (independent of the refs), so the timeline needs a
  // render-visible flag to switch it off once the user scrolls away.
  const [timelineLiveFollowEnabled, setTimelineLiveFollowEnabled] = useState(true);
  const pendingTimelineAnchorRef = useRef<MessageId | null>(null);
  const positionedTimelineAnchorRef = useRef<MessageId | null>(null);
  const settledTimelineAnchorRef = useRef<MessageId | null>(null);
  const activeTimelineAnchorIndexRef = useRef<number | null>(null);
  const anchorUserScrollGenerationRef = useRef(0);
  const liveFollowUserScrollGenerationRef = useRef<number | null>(0);
  const pendingAnchorScrollRestoreRef = useRef<{
    readonly messageId: MessageId;
    readonly offset: number;
    readonly userScrollGeneration: number;
  } | null>(null);
  const anchorScrollRestoreFrameRef = useRef<number | null>(null);
  const manualNavigationListenersInstalledRef = useRef(false);
  const previousTimelineEntryCountRef = useRef(timelineEntries.length);
  const [manualNavigationListenerRetryToken, setManualNavigationListenerRetryToken] = useState(0);
  const clearPendingTimelineAnchorScrollRestore = useCallback(() => {
    pendingAnchorScrollRestoreRef.current = null;
    if (anchorScrollRestoreFrameRef.current !== null) {
      cancelAnimationFrame(anchorScrollRestoreFrameRef.current);
      anchorScrollRestoreFrameRef.current = null;
    }
  }, []);
  const clearTimelineAnchorIfPositioningExhausted = useCallback((messageId: MessageId) => {
    if (positionedTimelineAnchorRef.current !== messageId) {
      return;
    }
    positionedTimelineAnchorRef.current = null;
    settledTimelineAnchorRef.current = null;
    activeTimelineAnchorIndexRef.current = null;
    timelineScrollModeRef.current = "following-end";
  }, []);
  const clearFailedTimelineAnchor = useCallback(
    (threadKey: string, messageId: MessageId) => {
      timelineScrollModeRef.current = "following-end";
      liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current;
      pendingTimelineAnchorRef.current = null;
      if (positionedTimelineAnchorRef.current === messageId) {
        positionedTimelineAnchorRef.current = null;
      }
      if (settledTimelineAnchorRef.current === messageId) {
        settledTimelineAnchorRef.current = null;
      }
      activeTimelineAnchorIndexRef.current = null;
      if (pendingAnchorScrollRestoreRef.current?.messageId === messageId) {
        clearPendingTimelineAnchorScrollRestore();
      }
      setTimelineAnchor((current) =>
        current.threadKey === threadKey && current.messageId === messageId
          ? { threadKey: current.threadKey, messageId: null }
          : current,
      );
    },
    [clearPendingTimelineAnchorScrollRestore],
  );
  const cancelTimelineLiveFollowForUserNavigation = useCallback(() => {
    anchorUserScrollGenerationRef.current += 1;
    timelineScrollModeRef.current = "free-scrolling";
    liveFollowUserScrollGenerationRef.current = null;
    setTimelineLiveFollowEnabled(false);
    pendingTimelineAnchorRef.current = null;
    positionedTimelineAnchorRef.current = null;
    settledTimelineAnchorRef.current = null;
    activeTimelineAnchorIndexRef.current = null;
    clearPendingTimelineAnchorScrollRestore();
  }, [clearPendingTimelineAnchorScrollRestore]);
  const cancelTimelineLiveFollowForUserNavigationRef = useRef(
    cancelTimelineLiveFollowForUserNavigation,
  );
  useEffect(() => {
    cancelTimelineLiveFollowForUserNavigationRef.current =
      cancelTimelineLiveFollowForUserNavigation;
  }, [cancelTimelineLiveFollowForUserNavigation]);
  const getActiveTimelineTurnMetrics = useCallback(
    (list?: LegendListRef | null) => {
      const resolvedList = list ?? legendListRef.current;
      const anchorIndex = activeTimelineAnchorIndexRef.current;
      const state = resolvedList?.getState();
      if (!resolvedList || !state || anchorIndex === null) {
        return null;
      }

      return getAnchoredTurnMetrics({
        state,
        anchorIndex,
        composerOverlayHeight,
        anchorOffset: CHAT_LIST_ANCHOR_OFFSET,
      });
    },
    [composerOverlayHeight],
  );
  // Live-follow stays active after send/thread-open until an actual list scroll
  // gesture opts out.
  const scrollToEnd = useCallback(
    (animated = false) => {
      isAtEndRef.current = true;
      timelineScrollModeRef.current = "following-end";
      liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current;
      pendingTimelineAnchorRef.current = null;
      positionedTimelineAnchorRef.current = null;
      settledTimelineAnchorRef.current = null;
      activeTimelineAnchorIndexRef.current = null;
      clearPendingTimelineAnchorScrollRestore();
      showScrollDebouncer.current.cancel();
      setShowScrollToBottom(false);
      void legendListRef.current?.scrollToEnd?.({ animated });
    },
    [clearPendingTimelineAnchorScrollRestore],
  );
  useEffect(() => {
    let frame: number | null = null;
    let removeListeners: (() => void) | null = null;
    let cancelled = false;
    manualNavigationListenersInstalledRef.current = false;

    const scheduleSetup = (remainingAttempts: number) => {
      frame = requestAnimationFrame(() => {
        frame = null;
        if (cancelled || removeListeners !== null) {
          return;
        }

        const scrollNode = legendListRef.current?.getScrollableNode();
        if (!scrollNode) {
          if (remainingAttempts > 0) {
            scheduleSetup(remainingAttempts - 1);
          } else {
            manualNavigationListenersInstalledRef.current = false;
          }
          return;
        }
        const handleManualNavigation = () => {
          cancelTimelineLiveFollowForUserNavigationRef.current();
        };
        const handleKeyboardNavigation = (event: KeyboardEvent) => {
          if (shouldTreatKeyAsTimelineScrollNavigation(event)) {
            handleManualNavigation();
          }
        };
        const handleScrollbarPointerNavigation = (event: PointerEvent) => {
          if (isPointerInNativeScrollbarGutter(scrollNode, event)) {
            handleManualNavigation();
          }
        };
        scrollNode.addEventListener("wheel", handleManualNavigation, {
          passive: true,
        });
        scrollNode.addEventListener("touchmove", handleManualNavigation, {
          passive: true,
        });
        scrollNode.addEventListener("keydown", handleKeyboardNavigation, {
          capture: true,
        });
        scrollNode.addEventListener("pointerdown", handleScrollbarPointerNavigation, {
          capture: true,
        });
        removeListeners = () => {
          scrollNode.removeEventListener("wheel", handleManualNavigation);
          scrollNode.removeEventListener("touchmove", handleManualNavigation);
          scrollNode.removeEventListener("keydown", handleKeyboardNavigation, {
            capture: true,
          });
          scrollNode.removeEventListener("pointerdown", handleScrollbarPointerNavigation, {
            capture: true,
          });
        };
        manualNavigationListenersInstalledRef.current = true;
      });
    };

    scheduleSetup(TIMELINE_SCROLL_LISTENER_SETUP_MAX_ATTEMPTS);

    return () => {
      cancelled = true;
      manualNavigationListenersInstalledRef.current = false;
      if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
      removeListeners?.();
    };
  }, [activeThread?.id, timelineEntries.length > 0, manualNavigationListenerRetryToken]);

  useEffect(() => {
    const previousTimelineEntryCount = previousTimelineEntryCountRef.current;
    previousTimelineEntryCountRef.current = timelineEntries.length;
    if (
      previousTimelineEntryCount > 0 &&
      timelineEntries.length > previousTimelineEntryCount &&
      !manualNavigationListenersInstalledRef.current
    ) {
      setManualNavigationListenerRetryToken((token) => token + 1);
    }
  }, [timelineEntries.length]);

  const onTimelineAnchorReady = useCallback(
    (messageId: MessageId, anchorIndex: number) => {
      if (pendingTimelineAnchorRef.current === messageId) {
        pendingTimelineAnchorRef.current = null;
      }
      activeTimelineAnchorIndexRef.current = anchorIndex;
      if (positionedTimelineAnchorRef.current === messageId) {
        return;
      }
      positionedTimelineAnchorRef.current = messageId;
      settledTimelineAnchorRef.current = null;
      const positionAnchor = (remainingAttempts: number) => {
        requestAnimationFrame(() => {
          if (positionedTimelineAnchorRef.current !== messageId) {
            return;
          }
          const list = legendListRef.current;
          if (!list) {
            if (remainingAttempts > 0) {
              positionAnchor(remainingAttempts - 1);
            } else {
              clearTimelineAnchorIfPositioningExhausted(messageId);
            }
            return;
          }
          const scrollNode = list.getScrollableNode();
          if (!scrollNode) {
            if (remainingAttempts > 0) {
              positionAnchor(remainingAttempts - 1);
            } else {
              clearTimelineAnchorIfPositioningExhausted(messageId);
            }
            return;
          }
          let finished = false;
          const finishAnimatedPositioning = () => {
            if (finished) {
              return;
            }
            finished = true;
            window.clearTimeout(fallbackTimer);
            scrollNode.removeEventListener("scrollend", finishAnimatedPositioning);
            if (positionedTimelineAnchorRef.current !== messageId) {
              return;
            }
            const scrollOffset = list.getState().scroll;
            void list.scrollToOffset({ offset: scrollOffset, animated: false });
            settledTimelineAnchorRef.current = messageId;
          };
          const fallbackTimer = window.setTimeout(finishAnimatedPositioning, 750);
          scrollNode.addEventListener("scrollend", finishAnimatedPositioning, { once: true });
          void list.scrollToIndex({
            index: anchorIndex,
            animated: true,
            viewPosition: 0,
            viewOffset: CHAT_LIST_ANCHOR_OFFSET,
          });
        });
      };
      requestAnimationFrame(() => positionAnchor(12));
    },
    [clearTimelineAnchorIfPositioningExhausted],
  );
  const onIsAtEndChange = useCallback((isAtEnd: boolean) => {
    if (
      !isAtEnd &&
      liveFollowUserScrollGenerationRef.current === anchorUserScrollGenerationRef.current
    ) {
      showScrollDebouncer.current.cancel();
      setShowScrollToBottom(false);
      return;
    }
    if (isAtEndRef.current === isAtEnd) return;
    isAtEndRef.current = isAtEnd;
    if (isAtEnd) {
      timelineScrollModeRef.current = "following-end";
      liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current;
      setTimelineLiveFollowEnabled(true);
      showScrollDebouncer.current.cancel();
      setShowScrollToBottom(false);
    } else {
      timelineScrollModeRef.current = "free-scrolling";
      liveFollowUserScrollGenerationRef.current = null;
      showScrollDebouncer.current.maybeExecute();
    }
  }, []);

  // Anchored end space intentionally disables LegendList's normal end-follow so
  // the sent message can stay near the top. T3 only owns streaming adjustments
  // during that mode; LegendList owns ordinary end-follow everywhere else.
  useEffect(() => {
    if (!activeThread?.id) {
      return;
    }
    if (liveFollowUserScrollGenerationRef.current !== anchorUserScrollGenerationRef.current) {
      return;
    }
    if (timelineScrollModeRef.current !== "anchoring-new-turn") {
      return;
    }

    let secondFrame: number | null = null;
    const frame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        if (liveFollowUserScrollGenerationRef.current !== anchorUserScrollGenerationRef.current) {
          return;
        }
        if (pendingTimelineAnchorRef.current !== null) {
          return;
        }
        if (
          positionedTimelineAnchorRef.current !== null &&
          settledTimelineAnchorRef.current !== positionedTimelineAnchorRef.current
        ) {
          return;
        }
        const list = legendListRef.current;
        if (!list) {
          return;
        }

        const metrics = getActiveTimelineTurnMetrics(list);
        if (!metrics || metrics.scrollDeltaToRevealEnd <= 1) {
          return;
        }

        const nextOffset = list.getState().scroll + metrics.scrollDeltaToRevealEnd;
        void list.scrollToOffset({ offset: nextOffset, animated: false });
      });
    });

    return () => {
      cancelAnimationFrame(frame);
      if (secondFrame !== null) {
        cancelAnimationFrame(secondFrame);
      }
    };
  }, [activeThread?.id, timelineEntries, getActiveTimelineTurnMetrics]);

  useEffect(() => {
    setPullRequestDialogState(null);
    isAtEndRef.current = true;
    timelineScrollModeRef.current = "following-end";
    liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current;
    setTimelineLiveFollowEnabled(true);
    pendingTimelineAnchorRef.current = null;
    positionedTimelineAnchorRef.current = null;
    settledTimelineAnchorRef.current = null;
    activeTimelineAnchorIndexRef.current = null;
    clearPendingTimelineAnchorScrollRestore();
    showScrollDebouncer.current.cancel();
    setShowScrollToBottom(false);
    // activeThreadRef resets transitively with the active thread.
  }, [activeThread?.id, clearPendingTimelineAnchorScrollRestore]);

  useEffect(() => {
    setIsRevertingCheckpoint(false);
  }, [activeThread?.id]);

  useEffect(() => {
    if (!activeThread?.id || terminalUiState.terminalOpen) return;
    const frame = window.requestAnimationFrame(() => {
      focusComposer();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeThread?.id, focusComposer, terminalUiState.terminalOpen]);

  useEffect(() => {
    if (!activeThread?.id) return;
    if (activeThread.messages.length === 0) {
      return;
    }
    const serverIds = new Set(activeThread.messages.map((message) => message.id));
    const removedMessages = optimisticUserMessages.filter((message) => serverIds.has(message.id));
    if (removedMessages.length === 0) {
      return;
    }
    const timer = window.setTimeout(() => {
      setOptimisticUserMessages((existing) =>
        existing.filter((message) => !serverIds.has(message.id)),
      );
    }, 0);
    for (const removedMessage of removedMessages) {
      const previewUrls = collectUserMessageBlobPreviewUrls(removedMessage);
      if (previewUrls.length > 0) {
        handoffAttachmentPreviews(removedMessage.id, previewUrls);
        continue;
      }
      revokeUserMessagePreviewUrls(removedMessage);
    }
    return () => {
      window.clearTimeout(timer);
    };
  }, [activeThread?.id, activeThread?.messages, handoffAttachmentPreviews, optimisticUserMessages]);

  useEffect(() => {
    setOptimisticUserMessages((existing) => {
      for (const message of existing) {
        revokeUserMessagePreviewUrls(message);
      }
      return [];
    });
    resetLocalDispatch();
    setExpandedImage(null);
  }, [draftId, resetLocalDispatch, threadId]);

  const closeExpandedImage = useCallback(() => {
    setExpandedImage(null);
  }, []);

  const activeWorktreePath = activeThread?.worktreePath ?? null;
  const derivedEnvMode: DraftThreadEnvMode = resolveEffectiveEnvMode({
    activeWorktreePath,
    hasServerThread: isServerThread,
    draftThreadEnvMode: isLocalDraftThread ? draftThread?.envMode : undefined,
  });
  const canOverrideServerThreadEnvMode = Boolean(
    isServerThread &&
    activeThread &&
    activeThread.messages.length === 0 &&
    activeThread.worktreePath === null &&
    !envLocked,
  );
  const envMode: DraftThreadEnvMode = canOverrideServerThreadEnvMode
    ? (pendingServerThreadEnvMode ?? draftThread?.envMode ?? derivedEnvMode)
    : derivedEnvMode;
  const activeThreadBranch =
    canOverrideServerThreadEnvMode && pendingServerThreadBranch !== undefined
      ? pendingServerThreadBranch
      : (activeThread?.branch ?? null);
  const startFromOrigin = isLocalDraftThread
    ? (draftThread?.startFromOrigin ?? false)
    : canOverrideServerThreadEnvMode
      ? (pendingServerThreadStartFromOriginByThreadId[activeThread?.id ?? ""] ??
        primaryServerSettings.newWorktreesStartFromOrigin)
      : false;
  const sendEnvMode = resolveSendEnvMode({
    requestedEnvMode: envMode,
    isGitRepo,
  });
  const localCheckoutBranchMismatch = useMemo(
    () =>
      isServerThread
        ? resolveLocalCheckoutBranchMismatch({
            effectiveEnvMode: envMode,
            activeWorktreePath,
            activeThreadBranch,
            currentGitBranch: gitStatusQuery.data?.refName ?? null,
          })
        : null,
    [activeThreadBranch, activeWorktreePath, envMode, gitStatusQuery.data?.refName, isServerThread],
  );
  // Settled state of the open thread, resolved exactly like the sidebar
  // partition (same shell, same capability gate, same PR auto-settle input)
  // so the banner and the sidebar row never disagree.
  const activeThreadShell = useThreadShell(isServerThread ? activeThreadRef : null);
  const autoSettleAfterDays = useClientSettings((settings) => settings.sidebarAutoSettleAfterDays);
  const autoSettleOnMerge = useClientSettings((settings) => settings.sidebarAutoSettleOnMerge);
  const activeThreadPr = resolveDisplayedThreadPr({
    threadBranch: activeThread?.branch ?? null,
    gitStatus: gitStatusQuery.data ?? null,
    snapshot: activeThreadKey ? changeRequestSnapshotByKey.get(activeThreadKey) : undefined,
    retainTerminalOnBranchMismatch: activeThread?.worktreePath === null,
  });
  // The right panel offers the thread's own change request, so it can only offer it once the
  // branch has one; until then the picker says so rather than opening an empty panel.
  const addPullRequestSurface = useCallback(() => {
    if (activeThreadPr === null) return;
    openThreadPullRequest(activeThreadPr.number);
  }, [activeThreadPr, openThreadPullRequest]);
  const pullRequestSurfaceAvailable =
    supportsPullRequests && activeThreadPr !== null && threadRepository !== null;
  // Primitive slice of the displayed PR for the settle-rule memos below:
  // resolveDisplayedThreadPr returns a fresh object every render, so memoize
  // on the fields the rules read instead of the object identity.
  const activeThreadPrState = activeThreadPr?.state ?? null;
  const activeThreadPrUpdatedAt = activeThreadPr?.updatedAt ?? null;
  const activeThreadChangeRequest = useMemo(
    () =>
      activeThreadPrState === null
        ? null
        : { state: activeThreadPrState, updatedAt: activeThreadPrUpdatedAt },
    [activeThreadPrState, activeThreadPrUpdatedAt],
  );
  const supportsSettlement = serverConfig?.environment.capabilities.threadSettlement === true;
  const supportsSnooze = serverConfig?.environment.capabilities.threadSnooze === true;
  const nowMinute = useNowMinute();
  const snoozeNow = new Date().toISOString();
  const activeThreadSnoozed =
    activeThreadShell !== null &&
    supportsSnooze &&
    effectiveSnoozed(activeThreadShell, { now: snoozeNow });
  const [snoozeWakeTick, bumpSnoozeWakeTick] = useState(0);
  void snoozeWakeTick;
  const activeThreadWokeAt =
    activeThreadShell !== null && supportsSnooze
      ? threadWokeAt(activeThreadShell, { now: snoozeNow })
      : null;
  useEffect(() => {
    if (!activeThreadSnoozed) return;
    const wakeAtMs = Date.parse(activeThreadShell?.snoozedUntil ?? "");
    if (!Number.isFinite(wakeAtMs)) return;
    const id = window.setTimeout(
      () => bumpSnoozeWakeTick((tick) => tick + 1),
      Math.min(Math.max(0, wakeAtMs - Date.now()) + 50, 2_147_483_647),
    );
    return () => window.clearTimeout(id);
  }, [activeThreadShell?.snoozedUntil, activeThreadSnoozed, snoozeWakeTick]);
  const acknowledgeActiveThreadWoke = useCallback(() => {
    if (activeThreadRef === null || activeThreadWokeAt === null) return;
    markThreadVisited(scopedThreadKey(activeThreadRef), activeThreadWokeAt);
  }, [activeThreadRef, activeThreadWokeAt, markThreadVisited]);
  // Mirror of the sidebar's Woke pill for the open thread. It uses the same
  // visit comparison and change request settle rule.
  const activeThreadLastVisitedAt = useUiStateStore((store) =>
    activeThreadKey === null ? undefined : store.threadLastVisitedAtById[activeThreadKey],
  );
  const activeThreadWokeVisible = useMemo(() => {
    if (activeThreadWokeAt === null) return false;
    if (
      changeRequestAutoSettles(activeThreadChangeRequest, {
        autoSettleOnMerge,
        thread: activeThreadShell,
      })
    ) {
      return false;
    }
    const wokeAtMs = Date.parse(activeThreadWokeAt);
    if (Number.isNaN(wokeAtMs)) return false;
    // Having the thread open counts as a visit at completedAt (the effect
    // above stamps it); folding that floor in here keeps a completion-
    // triggered wake from flashing a banner for one frame before the stamp
    // lands. An unparseable stored visit counts as never-visited: corrupt
    // local data must not eat the wake signal.
    const storedVisitMs = activeThreadLastVisitedAt ? Date.parse(activeThreadLastVisitedAt) : NaN;
    const completedAtMs = activeLatestTurn?.completedAt
      ? Date.parse(activeLatestTurn.completedAt)
      : NaN;
    const lastVisitedMs = Math.max(
      Number.isNaN(storedVisitMs) ? -Infinity : storedVisitMs,
      Number.isNaN(completedAtMs) ? -Infinity : completedAtMs,
    );
    return lastVisitedMs < wokeAtMs;
  }, [
    activeLatestTurn?.completedAt,
    activeThreadLastVisitedAt,
    activeThreadChangeRequest,
    activeThreadShell,
    activeThreadWokeAt,
    autoSettleOnMerge,
  ]);
  const activeThreadSettled = useMemo(() => {
    if (activeThreadShell === null || !supportsSettlement) return false;
    return effectiveSettled(activeThreadShell, {
      now: `${nowMinute}:00.000Z`,
      autoSettleAfterDays,
      autoSettleOnMerge,
      changeRequest: activeThreadChangeRequest,
    });
  }, [
    activeThreadChangeRequest,
    activeThreadShell,
    autoSettleAfterDays,
    autoSettleOnMerge,
    changeRequestSnapshotByKey,
    nowMinute,
    supportsSettlement,
  ]);
  const unsettleThreadMutation = useAtomCommand(threadEnvironment.unsettle, {
    reportFailure: false,
  });
  // Keyed by thread, not a boolean: the pending state must follow the thread
  // it belongs to across navigation, and a request resolving for thread A
  // must never clear (or re-enable) thread B's button.
  const [unsettlingThreadKey, setUnsettlingThreadKey] = useState<string | null>(null);
  const isUnsettling = unsettlingThreadKey !== null && unsettlingThreadKey === activeThreadKey;
  const handleUnsettleActiveThread = useCallback(async () => {
    if (!activeThreadRef) return;
    const threadKey = scopedThreadKey(activeThreadRef);
    setUnsettlingThreadKey(threadKey);
    try {
      const result = await unsettleThreadMutation({
        environmentId: activeThreadRef.environmentId,
        input: { threadId: activeThreadRef.threadId, reason: "user" },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to un-settle thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    } finally {
      setUnsettlingThreadKey((current) => (current === threadKey ? null : current));
    }
  }, [activeThreadRef, unsettleThreadMutation]);
  const unsnoozeThreadMutation = useAtomCommand(threadEnvironment.unsnooze, {
    reportFailure: false,
  });
  const [unsnoozingThreadKey, setUnsnoozingThreadKey] = useState<string | null>(null);
  const isUnsnoozing = unsnoozingThreadKey !== null && unsnoozingThreadKey === activeThreadKey;
  const handleUnsnoozeActiveThread = useCallback(async () => {
    if (!activeThreadRef) return;
    const threadKey = scopedThreadKey(activeThreadRef);
    setUnsnoozingThreadKey(threadKey);
    try {
      const result = await unsnoozeThreadMutation({
        environmentId: activeThreadRef.environmentId,
        input: { threadId: activeThreadRef.threadId, reason: "user" },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to wake thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    } finally {
      setUnsnoozingThreadKey((current) => (current === threadKey ? null : current));
    }
  }, [activeThreadRef, unsnoozeThreadMutation]);
  const [isRestoringThreadBranch, setIsRestoringThreadBranch] = useState(false);
  const [branchRestoreConfirmOpen, setBranchRestoreConfirmOpen] = useState(false);
  // Once revealed for a given mismatch, the banner stays mounted until the
  // mismatch changes or resolves, so clearing the draft doesn't flicker it.
  const [revealedBranchMismatchKey, setRevealedBranchMismatchKey] = useState<string | null>(null);
  // Dismissal lives in a module-level set (survives remounts); this tick just
  // forces a re-render so the banner leaves immediately.
  const [, setBranchMismatchDismissTick] = useState(0);
  const composerHasDraftContent = useComposerDraftStore((store) => {
    const draft = store.getComposerDraft(composerDraftTarget);
    return Boolean(
      draft &&
      (draft.prompt.trim().length > 0 ||
        draft.images.length > 0 ||
        draft.terminalContexts.length > 0 ||
        draft.elementContexts.length > 0 ||
        draft.previewAnnotations.length > 0 ||
        draft.reviewComments.length > 0),
    );
  });
  const activeBranchMismatchKey = branchMismatchKey(
    activeThread?.id ?? null,
    localCheckoutBranchMismatch,
  );
  const showBranchMismatchBanner = shouldShowBranchMismatchBanner({
    hasMismatch: localCheckoutBranchMismatch !== null,
    isDismissed: isBranchMismatchDismissedForSession(activeBranchMismatchKey),
    composerHasContent: composerHasDraftContent,
    wasShownForCurrentMismatch:
      revealedBranchMismatchKey !== null && revealedBranchMismatchKey === activeBranchMismatchKey,
  });
  useEffect(() => {
    setRevealedBranchMismatchKey((revealed) => {
      if (showBranchMismatchBanner) {
        return activeBranchMismatchKey;
      }
      // Hysteresis is scoped to an uninterrupted mismatch: reset when the
      // mismatch resolves or changes so a recurrence re-gates on intent.
      return revealed !== null && revealed !== activeBranchMismatchKey ? null : revealed;
    });
  }, [activeBranchMismatchKey, showBranchMismatchBanner]);
  const handleSwitchCheckoutToThread = useCallback(async () => {
    if (
      !activeProjectCwd ||
      !activeThread ||
      !localCheckoutBranchMismatch ||
      isRestoringThreadBranch
    ) {
      return;
    }
    setIsRestoringThreadBranch(true);
    const checkoutResult = await switchGitRef({
      environmentId,
      input: {
        cwd: activeProjectCwd,
        refName: localCheckoutBranchMismatch.threadBranch,
      },
    });
    if (checkoutResult._tag === "Failure") {
      setIsRestoringThreadBranch(false);
      if (!isAtomCommandInterrupted(checkoutResult)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to switch checkout",
            description: chatActionErrorMessage(squashAtomCommandFailure(checkoutResult)),
          }),
        );
      }
      return;
    }

    const nextBranch = checkoutResult.value.refName ?? localCheckoutBranchMismatch.threadBranch;
    if (nextBranch !== activeThread.branch) {
      const updateResult = await updateThreadMetadata({
        environmentId,
        input: { threadId: activeThread.id, branch: nextBranch, worktreePath: null },
      });
      if (updateResult._tag === "Failure") {
        setIsRestoringThreadBranch(false);
        if (!isAtomCommandInterrupted(updateResult)) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Checkout switched, but the thread could not be updated",
              description: chatActionErrorMessage(squashAtomCommandFailure(updateResult)),
            }),
          );
        }
        gitStatusQuery.refresh();
        return;
      }
    }
    gitStatusQuery.refresh();
    setIsRestoringThreadBranch(false);
    scheduleComposerFocus();
  }, [
    activeProjectCwd,
    activeThread,
    environmentId,
    gitStatusQuery,
    isRestoringThreadBranch,
    localCheckoutBranchMismatch,
    scheduleComposerFocus,
    switchGitRef,
    updateThreadMetadata,
  ]);
  // Background work (subagent fleets, workflow runs, watch loops) can outlive
  // the turn; once it settles, the composer stop button is gone, so this
  // banner is the only visible stop affordance. Stop routes through the
  // stop-everything interrupt: it kills every live background task before
  // interrupting, and works by session, so no active turn is needed.
  const activeBackgroundLiveness =
    !isWorking && activeThread ? (activeThreadShell?.backgroundLiveness ?? null) : null;
  const [isStoppingBackgroundWork, setIsStoppingBackgroundWork] = useState(false);
  const backgroundStopRequestSequenceRef = useRef(0);
  useEffect(() => {
    // "Stopping..." holds until the liveness clears; the interrupt command
    // returning only means the request was accepted.
    if (activeBackgroundLiveness === null) {
      setIsStoppingBackgroundWork(false);
    }
  }, [activeBackgroundLiveness]);
  useEffect(() => {
    // Per-thread state: switching threads while A's stop is pending must not
    // disable B's Stop button (review finding).
    backgroundStopRequestSequenceRef.current += 1;
    setIsStoppingBackgroundWork(false);
  }, [activeThreadKey]);
  const handleStopBackgroundWork = useCallback(async () => {
    if (!activeThread) return;
    const requestSequence = ++backgroundStopRequestSequenceRef.current;
    setIsStoppingBackgroundWork(true);
    const result = await interruptThreadTurn({
      environmentId,
      input: buildThreadTurnInterruptInput(activeThread),
    });
    if (result._tag === "Failure") {
      // Every failure clears the pending state — an interrupted command
      // never reached the server, so liveness would hold "Stopping..."
      // forever. A stale completion cannot clear a newer thread's request.
      if (
        isLatestRequestSequence({
          currentSequence: backgroundStopRequestSequenceRef.current,
          requestSequence,
        })
      ) {
        setIsStoppingBackgroundWork(false);
      }
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setThreadError(
          activeThread.id,
          error instanceof Error ? error.message : "Failed to stop background work.",
        );
      }
    }
  }, [activeThread, environmentId, interruptThreadTurn, setThreadError]);
  const backgroundLivenessBannerItem = useMemo<ComposerBannerStackItem | null>(() => {
    if (activeBackgroundLiveness === null || !activeThread) {
      return null;
    }
    const working = activeBackgroundLiveness === "working";
    const liveCount = agentPanelModel.liveCount;
    return {
      id: `background-liveness:${activeThread.id}`,
      variant: "default",
      icon: (
        <span
          className={cn("size-1.5 rounded-full bg-foreground", working && "animate-status-pulse")}
          aria-hidden="true"
        />
      ),
      title: working
        ? liveCount > 0
          ? `${liveCount} ${liveCount === 1 ? "agent" : "agents"} working in the background`
          : "Background work running"
        : "Monitoring in the background",
      actions: (
        <Button
          size="xs"
          variant="outline"
          disabled={isStoppingBackgroundWork}
          onClick={() => void handleStopBackgroundWork()}
        >
          {isStoppingBackgroundWork ? "Stopping..." : "Stop"}
        </Button>
      ),
    };
  }, [
    activeBackgroundLiveness,
    activeThread,
    agentPanelModel.liveCount,
    handleStopBackgroundWork,
    isStoppingBackgroundWork,
  ]);
  // A woken thread announces itself in the open view, not just the sidebar
  // pill. Dismissing marks the wake as seen (same acknowledgment as the
  // pill); sending a message clears it as a side effect of the send path.
  const wokeThreadBannerItem = useMemo<ComposerBannerStackItem | null>(() => {
    if (!activeThreadWokeVisible) {
      return null;
    }
    return {
      id: `thread-woke:${activeThread?.id ?? "unknown"}`,
      variant: "info",
      icon: <AlarmClockIcon />,
      title: "This thread woke from snooze",
      description: "Dismiss to clear the Woke indicator, or send a message to keep going.",
      dismissLabel: "Dismiss Woke notification",
      onDismiss: acknowledgeActiveThreadWoke,
    };
  }, [acknowledgeActiveThreadWoke, activeThread?.id, activeThreadWokeVisible]);
  // The stack renders items[0] front-most and tucks the rest behind hover, so
  // ordering is priority: urgent system banners (error/warning variants plus
  // calm-styled live states flagged `urgent`, like update progress), then
  // background liveness — its Stop button is the only stop affordance for
  // settled turns, so a passive "update available" notice must not cover it —
  // then calm system banners, the woke and branch-mismatch notices, and the
  // informational parked-thread banner last — it must never cover another.
  const parkedThreadBannerItem = useMemo<ComposerBannerStackItem | null>(() => {
    if (!activeThreadSnoozed && !activeThreadSettled) {
      return null;
    }
    const isSnoozed = activeThreadSnoozed;
    return {
      id: `thread-${isSnoozed ? "snoozed" : "settled"}:${activeThread?.id ?? "unknown"}`,
      variant: "info",
      icon: isSnoozed ? <AlarmClockIcon /> : <CheckCircle2Icon />,
      title: `This thread is ${isSnoozed ? "snoozed" : "settled"}`,
      description: isSnoozed
        ? "Sending a message wakes it and moves it back to Active in the sidebar."
        : "Sending a message moves it back to Active in the sidebar.",
      actions: (
        <Button
          size="xs"
          variant="outline"
          disabled={isSnoozed ? isUnsnoozing : isUnsettling}
          onClick={() =>
            void (isSnoozed ? handleUnsnoozeActiveThread() : handleUnsettleActiveThread())
          }
        >
          {isSnoozed
            ? isUnsnoozing
              ? "Waking..."
              : "Wake now"
            : isUnsettling
              ? "Un-settling..."
              : "Un-settle"}
        </Button>
      ),
    };
  }, [
    activeThread?.id,
    activeThreadSettled,
    activeThreadSnoozed,
    handleUnsnoozeActiveThread,
    handleUnsettleActiveThread,
    isUnsnoozing,
    isUnsettling,
  ]);
  const handleRestoreThreadBranch = useCallback(() => {
    if (gitStatusQuery.data?.hasWorkingTreeChanges) {
      setBranchRestoreConfirmOpen(true);
      return;
    }
    void handleSwitchCheckoutToThread();
  }, [gitStatusQuery.data?.hasWorkingTreeChanges, handleSwitchCheckoutToThread]);
  const composerBannerItems = useMemo<ComposerBannerStackItem[]>(() => {
    const isUrgentSystemItem = (item: ComposerBannerStackItem) =>
      item.urgent === true || item.variant === "error" || item.variant === "warning";
    const urgentSystemItems = systemComposerBannerItems.filter(isUrgentSystemItem);
    const calmSystemItems = systemComposerBannerItems.filter((item) => !isUrgentSystemItem(item));
    const backgroundLivenessItems =
      backgroundLivenessBannerItem === null ? [] : [backgroundLivenessBannerItem];
    const wokeThreadItems = wokeThreadBannerItem === null ? [] : [wokeThreadBannerItem];
    const parkedThreadItems = parkedThreadBannerItem === null ? [] : [parkedThreadBannerItem];
    if (!localCheckoutBranchMismatch || !showBranchMismatchBanner || !activeBranchMismatchKey) {
      return [
        ...urgentSystemItems,
        ...backgroundLivenessItems,
        ...calmSystemItems,
        ...wokeThreadItems,
        ...parkedThreadItems,
      ];
    }
    return [
      ...urgentSystemItems,
      ...backgroundLivenessItems,
      ...calmSystemItems,
      ...wokeThreadItems,
      {
        id: `branch-mismatch:${activeBranchMismatchKey}`,
        variant: "info",
        icon: <GitBranchIcon />,
        title: (
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="shrink-0 font-normal text-muted-foreground">Branch changed — was</span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <code className="min-w-0 truncate font-medium text-foreground">
                    {localCheckoutBranchMismatch.threadBranch}
                  </code>
                }
              />
              <TooltipPopup side="top" className="max-w-80">
                This thread last ran on {localCheckoutBranchMismatch.threadBranch}. Sending will
                continue on {localCheckoutBranchMismatch.currentBranch}.
              </TooltipPopup>
            </Tooltip>
          </span>
        ),
        className: "dark:shadow-none",
        actions: (
          <Button
            size="xs"
            variant="ghost"
            disabled={isRestoringThreadBranch}
            onClick={handleRestoreThreadBranch}
          >
            {isRestoringThreadBranch ? "Restoring..." : "Restore branch"}
          </Button>
        ),
        dismissLabel: "Dismiss branch change notice",
        onDismiss: () => {
          dismissBranchMismatchForSession(activeBranchMismatchKey);
          setBranchMismatchDismissTick((tick) => tick + 1);
        },
      },
      ...parkedThreadItems,
    ];
  }, [
    activeBranchMismatchKey,
    backgroundLivenessBannerItem,
    handleRestoreThreadBranch,
    isRestoringThreadBranch,
    localCheckoutBranchMismatch,
    parkedThreadBannerItem,
    showBranchMismatchBanner,
    systemComposerBannerItems,
    wokeThreadBannerItem,
  ]);

  useEffect(() => {
    setPendingServerThreadEnvMode(null);
    setPendingServerThreadBranch(undefined);
  }, [activeThread?.id]);

  useEffect(() => {
    if (canOverrideServerThreadEnvMode) {
      return;
    }
    setPendingServerThreadEnvMode(null);
    setPendingServerThreadBranch(undefined);
  }, [canOverrideServerThreadEnvMode]);

  useEffect(() => {
    if (!activeThreadId) {
      setTerminalUiLaunchContext(null);
      return;
    }
    setTerminalUiLaunchContext((current) => {
      if (!current) return current;
      if (current.threadId === activeThreadId) return current;
      return null;
    });
  }, [activeThreadId]);

  useEffect(() => {
    if (!activeThreadId || !activeProjectCwd) {
      return;
    }
    setTerminalUiLaunchContext((current) => {
      if (!current || current.threadId !== activeThreadId) {
        return current;
      }
      const settledCwd = projectScriptCwd({
        project: { cwd: activeProjectCwd },
        worktreePath: activeThreadWorktreePath,
      });
      if (
        settledCwd === current.cwd &&
        (activeThreadWorktreePath ?? null) === current.worktreePath
      ) {
        return null;
      }
      return current;
    });
  }, [activeProjectCwd, activeThreadId, activeThreadWorktreePath]);

  useEffect(() => {
    if (terminalUiState.terminalOpen) {
      return;
    }
    setTerminalUiLaunchContext((current) =>
      current?.threadId === activeThreadId ? null : current,
    );
  }, [activeThreadId, terminalUiState.terminalOpen]);

  useEffect(() => {
    if (!activeThreadKey) return;
    const previous = terminalUiOpenByThreadRef.current[activeThreadKey] ?? false;
    const current = Boolean(terminalUiState.terminalOpen);

    if (!previous && current) {
      terminalUiOpenByThreadRef.current[activeThreadKey] = current;
      setTerminalFocusRequestId((value) => value + 1);
      return;
    } else if (previous && !current) {
      terminalUiOpenByThreadRef.current[activeThreadKey] = current;
      const frame = window.requestAnimationFrame(() => {
        focusComposer();
      });
      return () => {
        window.cancelAnimationFrame(frame);
      };
    }

    terminalUiOpenByThreadRef.current[activeThreadKey] = current;
  }, [activeThreadKey, focusComposer, terminalUiState.terminalOpen]);

  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      if (preventRepeatedTerminalCloseShortcut(event, keybindings)) {
        event.stopPropagation();
        return;
      }
      // While a close confirmation is open, terminal focus has moved to the
      // dialog, so a deliberate second close shortcut would otherwise fall
      // through to the native window/tab close accelerator.
      if (isTerminalCloseConfirmPending() && preventTerminalCloseShortcut(event, keybindings)) {
        event.stopPropagation();
        return;
      }
      if (!activeThreadId || isCommandPaletteOpen()) {
        return;
      }
      const terminalFocusOwner = getTerminalFocusOwner();
      if (event.defaultPrevented && terminalFocusOwner === null) {
        return;
      }
      const shortcutContext = {
        terminalFocus: terminalFocusOwner !== null,
        terminalOpen: Boolean(terminalUiState.terminalOpen),
        modelPickerOpen: composerRef.current?.isModelPickerOpen() ?? false,
      };

      if (
        !shortcutContext.terminalFocus &&
        !shortcutContext.modelPickerOpen &&
        shouldTypeToFocusComposer(event)
      ) {
        if (composerRef.current?.insertTextAtEnd(event.key)) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }

      const command = resolveShortcutCommand(event, keybindings, {
        context: shortcutContext,
      });
      if (!command) return;
      if (!terminalEnabled && isTerminalKeybindingCommand(command)) {
        return;
      }

      if (command === "terminal.toggle") {
        event.preventDefault();
        event.stopPropagation();
        toggleTerminalVisibility();
        return;
      }

      if (command === "rightPanel.toggle") {
        event.preventDefault();
        event.stopPropagation();
        toggleRightPanel();
        return;
      }

      if (command === "rightPanel.toggleMaximized") {
        event.preventDefault();
        event.stopPropagation();
        toggleRightPanelMaximized();
        return;
      }

      if (command === "terminal.split") {
        event.preventDefault();
        event.stopPropagation();
        if (terminalFocusOwner === "right-panel") {
          splitPanelTerminal();
          return;
        }
        if (!terminalUiState.terminalOpen) {
          setTerminalOpen(true);
        }
        splitTerminal();
        return;
      }

      if (command === "terminal.splitVertical") {
        event.preventDefault();
        event.stopPropagation();
        if (terminalFocusOwner === "right-panel") {
          splitPanelTerminal("vertical");
          return;
        }
        if (!terminalUiState.terminalOpen) {
          setTerminalOpen(true);
        }
        splitTerminal("vertical");
        return;
      }

      if (command === "terminal.close") {
        event.preventDefault();
        event.stopPropagation();
        if (terminalFocusOwner === "right-panel" && activeRightPanelSurface?.kind === "terminal") {
          requestClosePanelTerminal(activeRightPanelSurface.activeTerminalId);
          return;
        }
        if (!terminalUiState.terminalOpen) return;
        requestCloseTerminal(terminalUiState.activeTerminalId);
        return;
      }

      if (command === "terminal.new") {
        event.preventDefault();
        event.stopPropagation();
        if (terminalFocusOwner === "right-panel") {
          addTerminalSurface();
          return;
        }
        if (!terminalUiState.terminalOpen) {
          setTerminalOpen(true);
        }
        createNewTerminal();
        return;
      }

      if (command === "diff.toggle") {
        event.preventDefault();
        event.stopPropagation();
        onToggleDiff();
        return;
      }

      if (command === "modelPicker.toggle") {
        event.preventDefault();
        event.stopPropagation();
        composerRef.current?.toggleModelPicker();
        return;
      }

      const scriptId = projectScriptIdFromCommand(command);
      if (!scriptId || !activeProject) return;
      const script = activeProject.scripts.find((entry) => entry.id === scriptId);
      if (!script) return;
      event.preventDefault();
      event.stopPropagation();
      void runProjectScript(script);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [
    activeProject,
    activeRightPanelSurface,
    addTerminalSurface,
    terminalUiState.terminalOpen,
    terminalUiState.activeTerminalId,
    activeThreadId,
    requestCloseTerminal,
    requestClosePanelTerminal,
    createNewTerminal,
    setTerminalOpen,
    runProjectScript,
    splitTerminal,
    splitPanelTerminal,
    keybindings,
    onToggleDiff,
    toggleRightPanel,
    toggleRightPanelMaximized,
    toggleTerminalVisibility,
    composerRef,
    terminalEnabled,
  ]);

  const onRevertToTurnCount = useCallback(
    async (turnCount: number) => {
      const localApi = readLocalApi();
      if (!localApi || !activeThread || isRevertingCheckpoint) return;

      if (activeEnvironmentUnavailable && activeEnvironmentUnavailableLabel) {
        setThreadError(
          activeThread.id,
          `Reconnect ${activeEnvironmentUnavailableLabel} before reverting checkpoints.`,
        );
        return;
      }
      if (phase === "running" || isSendBusy || isConnecting) {
        setThreadError(activeThread.id, "Interrupt the current turn before reverting checkpoints.");
        return;
      }
      const confirmed = await localApi.dialogs.confirm(
        [
          `Revert this thread to checkpoint ${turnCount}?`,
          "This will discard newer messages and turn diffs in this thread.",
          "This action cannot be undone.",
        ].join("\n"),
        { variant: "destructive" },
      );
      if (!confirmed) {
        return;
      }

      setIsRevertingCheckpoint(true);
      setThreadError(activeThread.id, null);
      const result = await revertThreadCheckpoint({
        environmentId,
        input: {
          threadId: activeThread.id,
          turnCount,
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setThreadError(
          activeThread.id,
          error instanceof Error ? error.message : "Failed to revert thread state.",
        );
      }
      setIsRevertingCheckpoint(false);
    },
    [
      activeThread,
      activeEnvironmentUnavailable,
      activeEnvironmentUnavailableLabel,
      environmentId,
      isConnecting,
      isRevertingCheckpoint,
      isSendBusy,
      phase,
      revertThreadCheckpoint,
      setThreadError,
    ],
  );

  const onSend = async (
    e?: { preventDefault: () => void },
    submissionIntent: ComposerSubmissionIntent = "foreground",
    directAnnotation?: {
      annotation: PreviewAnnotationPayload;
      image: ComposerImageAttachment | null;
    },
  ) => {
    e?.preventDefault();
    const notifyDirectAnnotationAttached = () => {
      if (!directAnnotation) return;
      toastManager.add(
        stackedThreadToast({
          type: "info",
          title: "Annotation attached to draft",
          description: "Sending is unavailable right now. Finish the current action, then send.",
        }),
      );
    };
    if (
      !activeThread ||
      isSendBusy ||
      isConnecting ||
      threadDetailLoading ||
      sendInFlightRef.current ||
      feedbackUploadsInFlightRef.current.has(routeThreadKey)
    ) {
      notifyDirectAnnotationAttached();
      return;
    }
    if (activeEnvironmentUnavailable) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Not connected: message not sent",
          description: "Reconnecting to the environment. Try again once it is connected.",
        }),
      );
      return;
    }
    if (activePendingProgress) {
      if (directAnnotation) {
        notifyDirectAnnotationAttached();
        return;
      }
      onAdvanceActivePendingUserInput();
      return;
    }
    const sendCtx = composerRef.current?.getSendContext();
    if (!sendCtx?.providerAvailable) {
      notifyDirectAnnotationAttached();
      return;
    }
    const {
      images: sendContextImages,
      terminalContexts: composerTerminalContexts,
      elementContexts: composerElementContexts,
      previewAnnotations: sendContextPreviewAnnotations,
      reviewComments: composerReviewComments,
      selectedProvider: ctxSelectedProvider,
      selectedModel: ctxSelectedModel,
      selectedProviderModels: ctxSelectedProviderModels,
      selectedPromptEffort: ctxSelectedPromptEffort,
      selectedModelSelection: ctxSelectedModelSelection,
    } = sendCtx;
    const composerImages =
      directAnnotation?.image &&
      !sendContextImages.some((image) => image.id === directAnnotation.image?.id)
        ? [...sendContextImages, directAnnotation.image]
        : sendContextImages;
    const composerPreviewAnnotations =
      directAnnotation &&
      !sendContextPreviewAnnotations.some(
        (annotation) => annotation.id === directAnnotation.annotation.id,
      )
        ? [
            ...sendContextPreviewAnnotations,
            {
              ...directAnnotation.annotation,
              screenshot: directAnnotation.annotation.screenshot
                ? { ...directAnnotation.annotation.screenshot, dataUrl: "" }
                : null,
            },
          ]
        : sendContextPreviewAnnotations;
    const promptForSend = promptRef.current;
    const magiArmSnapshot = composerMagiArm;
    const {
      trimmedPrompt: trimmed,
      sendableTerminalContexts: sendableComposerTerminalContexts,
      expiredTerminalContextCount,
      hasSendableContent,
    } = deriveComposerSendState({
      prompt: promptForSend,
      imageCount: composerImages.length,
      terminalContexts: composerTerminalContexts,
      elementContextCount:
        composerElementContexts.length +
        composerPreviewAnnotations.length +
        composerReviewComments.length,
    });
    const feedbackCommand =
      ctxSelectedProvider === "codex" &&
      composerImages.length === 0 &&
      sendableComposerTerminalContexts.length === 0 &&
      composerElementContexts.length === 0 &&
      composerPreviewAnnotations.length === 0 &&
      composerReviewComments.length === 0
        ? parseCodexFeedbackCommand(trimmed)
        : null;
    if (feedbackCommand) {
      if (!isServerThread || activeThread.session === null) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Start a Codex thread first",
            description: "Send a message before you submit feedback.",
          }),
        );
        return;
      }
      feedbackUploadsInFlightRef.current.add(routeThreadKey);
      const result = await submitCodexFeedback({
        submission: {
          id: newMessageId(),
          command: trimmed,
          createdAt: new Date().toISOString(),
        },
        clearDraft: () => {
          promptRef.current = "";
          clearComposerDraftContent(composerDraftTarget);
          composerRef.current?.resetCursorState();
          scrollToEnd();
        },
        onUpdate: (submission) => {
          setFeedbackSubmissionsByThreadKey((current) => {
            const existing = current[routeThreadKey] ?? [];
            const found = existing.some((entry) => entry.id === submission.id);
            return {
              ...current,
              [routeThreadKey]: found
                ? existing.map((entry) => (entry.id === submission.id ? submission : entry))
                : [...existing, submission],
            };
          });
        },
        upload: () =>
          uploadThreadFeedback({
            environmentId,
            input: {
              threadId: activeThread.id,
              ...feedbackCommand,
            },
          }),
      }).finally(() => {
        feedbackUploadsInFlightRef.current.delete(routeThreadKey);
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not send feedback to OpenAI",
              description: chatActionErrorMessage(squashAtomCommandFailure(result)),
            }),
          );
        }
        return;
      }
      const feedbackId = result.value.feedbackId;
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: "Feedback sent to OpenAI",
          description: `Thread ID: ${feedbackId}`,
          timeout: 0,
          actionProps: {
            children: "Copy ID",
            onClick: () => {
              void writeTextToClipboard(feedbackId, "Codex feedback thread ID").catch(
                (error: unknown) => {
                  toastManager.add(
                    stackedThreadToast({
                      type: "error",
                      title: "Could not copy thread ID",
                      description: chatActionErrorMessage(error),
                    }),
                  );
                },
              );
            },
          },
        }),
      );
      return;
    }
    if (!directAnnotation && showPlanFollowUpPrompt && activeProposedPlan) {
      const followUp = resolvePlanFollowUpSubmission({
        draftText: trimmed,
        planMarkdown: activeProposedPlan.planMarkdown,
      });
      const outgoingFollowUpText = formatOutgoingPrompt({
        provider: ctxSelectedProvider,
        model: ctxSelectedModel,
        models: ctxSelectedProviderModels,
        effort: ctxSelectedPromptEffort,
        text: followUp.text.trim(),
      });
      if (composerRef.current?.validateProviderInput(outgoingFollowUpText) === false) {
        return;
      }
      promptRef.current = "";
      clearComposerDraftContent(composerDraftTarget);
      composerRef.current?.resetCursorState();
      await onSubmitPlanFollowUp({
        text: followUp.text,
        interactionMode: followUp.interactionMode,
      });
      return;
    }
    // Legacy plan mode: /plan and /default only act when the beta flag is on;
    // otherwise they send as plain text like any other message.
    const standaloneSlashCommand =
      settings.planModeEnabled &&
      composerImages.length === 0 &&
      sendableComposerTerminalContexts.length === 0 &&
      composerElementContexts.length === 0 &&
      composerPreviewAnnotations.length === 0 &&
      composerReviewComments.length === 0
        ? parseStandaloneComposerSlashCommand(trimmed)
        : null;
    if (standaloneSlashCommand) {
      handleInteractionModeChange(standaloneSlashCommand);
      promptRef.current = "";
      clearComposerDraftContent(composerDraftTarget);
      composerRef.current?.resetCursorState();
      return;
    }
    if (!hasSendableContent) {
      if (expiredTerminalContextCount > 0) {
        const toastCopy = buildExpiredTerminalContextToastCopy(
          expiredTerminalContextCount,
          "empty",
        );
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: toastCopy.title,
            description: toastCopy.description,
          }),
        );
      }
      return;
    }
    if (!activeProject) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Choose a project first",
          description: "This draft no longer points to an available project.",
        }),
      );
      return;
    }
    const threadIdForSend = activeThread.id;
    const isFirstMessage = !isServerThread || activeThread.messages.length === 0;
    const baseBranchForWorktree =
      isFirstMessage && sendEnvMode === "worktree" && !activeThread.worktreePath
        ? activeThreadBranch
        : null;

    // In worktree mode, require an explicit base branch so we don't silently
    // fall back to local execution when branch selection is missing.
    const shouldCreateWorktree =
      isFirstMessage && sendEnvMode === "worktree" && !activeThread.worktreePath;
    if (shouldCreateWorktree && !activeThreadBranch) {
      setThreadError(threadIdForSend, "Select a base branch before sending in New worktree mode.");
      return;
    }

    const composerImagesSnapshot = [...composerImages];
    const composerTerminalContextsSnapshot = [...sendableComposerTerminalContexts];
    const composerElementContextsSnapshot = [...composerElementContexts];
    const composerPreviewAnnotationsSnapshot = [...composerPreviewAnnotations];
    const composerReviewCommentsSnapshot: ReviewCommentContext[] = [...composerReviewComments];
    const messageTextWithContexts = appendElementContextsToPrompt(
      appendTerminalContextsToPrompt(promptForSend, composerTerminalContextsSnapshot),
      composerElementContextsSnapshot,
    );
    const messageTextWithPreviewAnnotations = composerPreviewAnnotationsSnapshot.reduce(
      (text, annotation) => appendPreviewAnnotationPrompt(text, annotation),
      messageTextWithContexts,
    );
    const messageTextForSend = appendReviewCommentsToPrompt(
      messageTextWithPreviewAnnotations,
      composerReviewCommentsSnapshot,
    );
    const outgoingMessageText = formatOutgoingPrompt({
      provider: ctxSelectedProvider,
      model: ctxSelectedModel,
      models: ctxSelectedProviderModels,
      effort: ctxSelectedPromptEffort,
      text: messageTextForSend || IMAGE_ONLY_BOOTSTRAP_PROMPT,
    });
    if (composerRef.current?.validateProviderInput(outgoingMessageText) === false) {
      return;
    }

    sendInFlightRef.current = true;
    if (isDraftHeroState && activeThreadKey) {
      let resolveDockStarted: (() => void) | undefined;
      const dockStarted = new Promise<void>((resolve) => {
        resolveDockStarted = resolve;
      });
      const dockTransition = runMobileComposerTransition(() => {
        flushSync(() => {
          captureDraftHeroComposerRect();
          setDockedDraftHeroThreadKey(activeThreadKey);
        });
        resolveDockStarted?.();
      });
      void dockTransition.catch(() => resolveDockStarted?.());
      await dockStarted;
    }
    const messageIdForSend = newMessageId();
    beginMessageDispatch(messageIdForSend, {
      preparingWorktree: Boolean(baseBranchForWorktree),
      submissionIntent,
    });
    const messageCreatedAt = new Date().toISOString();
    const turnAttachmentsPromise = Promise.all(
      composerImagesSnapshot.map(async (image) => ({
        type: "image" as const,
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        dataUrl: await readFileAsDataUrl(image.file),
      })),
    );
    const optimisticAttachments = composerImagesSnapshot.map((image) => ({
      type: "image" as const,
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      previewUrl: image.previewUrl,
    }));
    // Sending always returns to the live edge. The new row becomes the
    // anchored end-space target so it lands near the top while the response
    // streams into the reserved space below it.
    isAtEndRef.current = true;
    timelineScrollModeRef.current = "anchoring-new-turn";
    liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current;
    setTimelineLiveFollowEnabled(true);
    pendingTimelineAnchorRef.current = messageIdForSend;
    activeTimelineAnchorIndexRef.current = null;
    clearPendingTimelineAnchorScrollRestore();
    showScrollDebouncer.current.cancel();
    setShowScrollToBottom(false);
    const timelineAnchorThreadKey = scopedThreadKey(
      scopeThreadRef(activeThread.environmentId, threadIdForSend),
    );
    setTimelineAnchor({
      threadKey: timelineAnchorThreadKey,
      messageId: messageIdForSend,
    });
    setOptimisticUserMessages((existing) => [
      ...existing,
      {
        id: messageIdForSend,
        role: "user",
        text: outgoingMessageText,
        ...(optimisticAttachments.length > 0 ? { attachments: optimisticAttachments } : {}),
        turnId: null,
        createdAt: messageCreatedAt,
        updatedAt: messageCreatedAt,
        streaming: false,
      },
    ]);
    setThreadError(threadIdForSend, null);
    if (expiredTerminalContextCount > 0) {
      const toastCopy = buildExpiredTerminalContextToastCopy(
        expiredTerminalContextCount,
        "omitted",
      );
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: toastCopy.title,
          description: toastCopy.description,
        }),
      );
    }
    promptRef.current = "";
    clearComposerDraftContent(composerDraftTarget);
    composerRef.current?.resetCursorState();

    let firstComposerImageName: string | null = null;
    if (composerImagesSnapshot.length > 0) {
      const firstComposerImage = composerImagesSnapshot[0];
      if (firstComposerImage) {
        firstComposerImageName = firstComposerImage.name;
      }
    }
    let titleSeed = trimmed;
    if (!titleSeed) {
      if (firstComposerImageName) {
        titleSeed = `Image: ${firstComposerImageName}`;
      } else if (composerTerminalContextsSnapshot.length > 0) {
        titleSeed = formatTerminalContextLabel(composerTerminalContextsSnapshot[0]!);
      } else if (composerElementContextsSnapshot.length > 0) {
        titleSeed = formatElementContextLabel(composerElementContextsSnapshot[0]!);
      } else {
        titleSeed = "New thread";
      }
    }
    const title = truncate(titleSeed);
    const threadCreateModelSelection = createModelSelection(
      ctxSelectedModelSelection.instanceId,
      ctxSelectedModel || activeProject.defaultModelSelection?.model || DEFAULT_MODEL,
      ctxSelectedModelSelection.options,
    );

    let failure: AtomCommandResult<unknown, unknown> | null = null;
    // Auto-title from first message
    if (isFirstMessage && isServerThread) {
      const titleResult = await updateThreadMetadata({
        environmentId,
        input: {
          threadId: threadIdForSend,
          title,
        },
      });
      if (titleResult._tag === "Failure") {
        failure = titleResult;
      }
    }

    if (failure === null && isServerThread) {
      const settingsResult = await persistThreadSettingsForNextTurn({
        threadId: threadIdForSend,
        createdAt: messageCreatedAt,
        ...(ctxSelectedModel ? { modelSelection: ctxSelectedModelSelection } : {}),
        ...(localCheckoutBranchMismatch
          ? { branch: localCheckoutBranchMismatch.currentBranch }
          : {}),
        runtimeMode,
        interactionMode,
      });
      if (settingsResult._tag === "Failure") {
        failure = settingsResult;
      }
    }

    const turnAttachmentsResult = await settlePromise(() => turnAttachmentsPromise);
    if (failure === null && turnAttachmentsResult._tag === "Failure") {
      failure = turnAttachmentsResult;
    }

    let turnStartSucceeded = false;
    if (failure === null && turnAttachmentsResult._tag === "Success") {
      const bootstrap =
        isLocalDraftThread || baseBranchForWorktree
          ? {
              ...(isLocalDraftThread
                ? {
                    createThread: {
                      projectId: activeProject.id,
                      title,
                      modelSelection: threadCreateModelSelection,
                      runtimeMode,
                      interactionMode,
                      branch: activeThreadBranch,
                      worktreePath: activeThread.worktreePath,
                      createdAt: activeThread.createdAt,
                    },
                    ...(magiArmSnapshot ? { magiArm: magiArmSnapshot } : {}),
                  }
                : {}),
              ...(baseBranchForWorktree
                ? {
                    prepareWorktree: {
                      projectCwd: activeProject.workspaceRoot,
                      baseBranch: baseBranchForWorktree,
                      branch: buildTemporaryWorktreeBranchName(randomHex),
                      ...(startFromOrigin ? { startFromOrigin: true } : {}),
                    },
                    runSetupScript: true,
                  }
                : {}),
            }
          : undefined;
      beginMessageDispatch(messageIdForSend, { preparingWorktree: false });
      const startResult = await startThreadTurn({
        environmentId,
        input: {
          threadId: threadIdForSend,
          message: {
            messageId: messageIdForSend,
            role: "user",
            text: outgoingMessageText,
            attachments: turnAttachmentsResult.value,
          },
          modelSelection: ctxSelectedModelSelection,
          titleSeed: title,
          runtimeMode,
          interactionMode,
          ...(bootstrap ? { bootstrap } : {}),
          createdAt: messageCreatedAt,
        },
      });
      if (startResult._tag === "Failure") {
        failure = startResult;
      } else {
        turnStartSucceeded = true;
        acknowledgeActiveThreadWoke();
      }
    }

    if (failure !== null) {
      clearFailedTimelineAnchor(timelineAnchorThreadKey, messageIdForSend);
      if (
        promptRef.current.length === 0 &&
        composerImagesRef.current.length === 0 &&
        composerTerminalContextsRef.current.length === 0 &&
        composerElementContextsRef.current.length === 0 &&
        (useComposerDraftStore.getState().getComposerDraft(composerDraftTarget)?.previewAnnotations
          .length ?? 0) === 0 &&
        (useComposerDraftStore.getState().getComposerDraft(composerDraftTarget)?.reviewComments
          .length ?? 0) === 0
      ) {
        setOptimisticUserMessages((existing) => {
          const removed = existing.filter((message) => message.id === messageIdForSend);
          for (const message of removed) {
            revokeUserMessagePreviewUrls(message);
          }
          const next = existing.filter((message) => message.id !== messageIdForSend);
          return next.length === existing.length ? existing : next;
        });
        promptRef.current = promptForSend;
        const retryComposerImages = composerImagesSnapshot.map(cloneComposerImageForRetry);
        composerImagesRef.current = retryComposerImages;
        composerTerminalContextsRef.current = composerTerminalContextsSnapshot;
        composerElementContextsRef.current = composerElementContextsSnapshot;
        setComposerDraftPrompt(composerDraftTarget, promptForSend);
        addComposerDraftImages(composerDraftTarget, retryComposerImages);
        setComposerDraftTerminalContexts(composerDraftTarget, composerTerminalContextsSnapshot);
        setComposerDraftElementContexts(composerDraftTarget, composerElementContextsSnapshot);
        setComposerDraftPreviewAnnotations(composerDraftTarget, composerPreviewAnnotationsSnapshot);
        setComposerDraftReviewComments(composerDraftTarget, composerReviewCommentsSnapshot);
        if (magiArmSnapshot) setComposerDraftMagiArm(composerDraftTarget, magiArmSnapshot);
        composerRef.current?.resetCursorState({
          cursor: collapseExpandedComposerCursor(promptForSend, promptForSend.length),
          prompt: promptForSend,
          detectTrigger: true,
        });
      }
      if (!isAtomCommandInterrupted(failure)) {
        const error = squashAtomCommandFailure(failure);
        setThreadError(
          threadIdForSend,
          error instanceof Error ? error.message : "Failed to send message.",
        );
      }
    }
    sendInFlightRef.current = false;
    if (!turnStartSucceeded) {
      setDockedDraftHeroThreadKey((currentThreadKey) =>
        currentThreadKey === activeThreadKey ? null : currentThreadKey,
      );
      resetLocalDispatch();
    }
  };

  const onInterrupt = async () => {
    if (!activeThread) return;
    const interruptedThreadId = activeThread.id;
    setPendingSubagentStopThreadId(interruptedThreadId);
    try {
      const result = await interruptThreadTurn({
        environmentId,
        input: buildThreadTurnInterruptInput(activeThread),
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setThreadError(
          interruptedThreadId,
          error instanceof Error ? error.message : "Failed to interrupt the current turn.",
        );
      }
    } finally {
      setPendingSubagentStopThreadId((current) =>
        current === interruptedThreadId ? null : current,
      );
    }
  };

  const onRespondToApproval = useCallback(
    async (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => {
      if (!activeThreadId) return;

      setRespondingRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      const result = await respondToThreadApproval({
        environmentId,
        input: {
          threadId: activeThreadId,
          requestId,
          decision,
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setThreadError(
          activeThreadId,
          error instanceof Error ? error.message : "Failed to submit approval decision.",
        );
      }
      setRespondingRequestIds((existing) => existing.filter((id) => id !== requestId));
      return result;
    },
    [activeThreadId, environmentId, respondToThreadApproval, setThreadError],
  );

  const onRespondToUserInput = useCallback(
    async (requestId: ApprovalRequestId, answers: Record<string, unknown>) => {
      if (!activeThreadId) return;

      setRespondingUserInputRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      const result = await respondToThreadUserInput({
        environmentId,
        input: {
          threadId: activeThreadId,
          requestId,
          answers,
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setThreadError(
          activeThreadId,
          error instanceof Error ? error.message : "Failed to submit user input.",
        );
      }
      setRespondingUserInputRequestIds((existing) => existing.filter((id) => id !== requestId));
      return result;
    },
    [activeThreadId, environmentId, respondToThreadUserInput, setThreadError],
  );

  const setActivePendingUserInputQuestionIndex = useCallback(
    (nextQuestionIndex: number) => {
      if (!activePendingUserInput) {
        return;
      }
      setPendingUserInputQuestionIndexByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: nextQuestionIndex,
      }));
    },
    [activePendingUserInput],
  );

  const onSelectActivePendingUserInputOption = useCallback(
    (questionId: string, optionLabel: string) => {
      if (!activePendingUserInput) {
        return;
      }
      setPendingUserInputAnswersByRequestId((existing) => {
        const question =
          (activePendingProgress?.activeQuestion?.id === questionId
            ? activePendingProgress.activeQuestion
            : undefined) ??
          activePendingUserInput.questions.find((entry) => entry.id === questionId);
        if (!question) {
          return existing;
        }

        return {
          ...existing,
          [activePendingUserInput.requestId]: {
            ...existing[activePendingUserInput.requestId],
            [questionId]: togglePendingUserInputOptionSelection(
              question,
              existing[activePendingUserInput.requestId]?.[questionId],
              optionLabel,
            ),
          },
        };
      });
      promptRef.current = "";
      composerRef.current?.resetCursorState({ cursor: 0 });
    },
    [activePendingProgress?.activeQuestion, activePendingUserInput, composerRef],
  );

  const onChangeActivePendingUserInputCustomAnswer = useCallback(
    (
      questionId: string,
      value: string,
      nextCursor: number,
      expandedCursor: number,
      _cursorAdjacentToMention: boolean,
    ) => {
      if (!activePendingUserInput) {
        return;
      }
      promptRef.current = value;
      setPendingUserInputAnswersByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: {
          ...existing[activePendingUserInput.requestId],
          [questionId]: setPendingUserInputCustomAnswer(
            existing[activePendingUserInput.requestId]?.[questionId],
            value,
          ),
        },
      }));
      const snapshot = composerRef.current?.readSnapshot();
      if (
        snapshot?.value !== value ||
        snapshot.cursor !== nextCursor ||
        snapshot.expandedCursor !== expandedCursor
      ) {
        composerRef.current?.focusAt(nextCursor);
      }
    },
    [activePendingUserInput, composerRef],
  );

  const onAdvanceActivePendingUserInput = useCallback(() => {
    if (!activePendingUserInput || !activePendingProgress) {
      return;
    }
    if (activePendingProgress.isLastQuestion) {
      if (activePendingResolvedAnswers) {
        void onRespondToUserInput(activePendingUserInput.requestId, activePendingResolvedAnswers);
      }
      return;
    }
    setActivePendingUserInputQuestionIndex(activePendingProgress.questionIndex + 1);
  }, [
    activePendingProgress,
    activePendingResolvedAnswers,
    activePendingUserInput,
    onRespondToUserInput,
    setActivePendingUserInputQuestionIndex,
  ]);

  const onPreviousActivePendingUserInputQuestion = useCallback(() => {
    if (!activePendingProgress) {
      return;
    }
    setActivePendingUserInputQuestionIndex(Math.max(activePendingProgress.questionIndex - 1, 0));
  }, [activePendingProgress, setActivePendingUserInputQuestionIndex]);

  const onSubmitPlanFollowUp = useCallback(
    async ({
      text,
      interactionMode: nextInteractionMode,
    }: {
      text: string;
      interactionMode: "default" | "plan";
    }) => {
      if (
        !activeThread ||
        !isServerThread ||
        isSendBusy ||
        isConnecting ||
        sendInFlightRef.current
      ) {
        return;
      }

      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }

      const sendCtx = composerRef.current?.getSendContext();
      if (!sendCtx?.providerAvailable) {
        return;
      }
      const {
        selectedProvider: ctxSelectedProvider,
        selectedModel: ctxSelectedModel,
        selectedProviderModels: ctxSelectedProviderModels,
        selectedPromptEffort: ctxSelectedPromptEffort,
        selectedModelSelection: ctxSelectedModelSelection,
      } = sendCtx;

      const threadIdForSend = activeThread.id;
      const messageIdForSend = newMessageId();
      const messageCreatedAt = new Date().toISOString();
      const outgoingMessageText = formatOutgoingPrompt({
        provider: ctxSelectedProvider,
        model: ctxSelectedModel,
        models: ctxSelectedProviderModels,
        effort: ctxSelectedPromptEffort,
        text: trimmed,
      });

      sendInFlightRef.current = true;
      beginMessageDispatch(messageIdForSend, { preparingWorktree: false });
      setThreadError(threadIdForSend, null);

      // Position this sent row once LegendList has measured the anchored tail.
      isAtEndRef.current = true;
      timelineScrollModeRef.current = "anchoring-new-turn";
      liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current;
      setTimelineLiveFollowEnabled(true);
      pendingTimelineAnchorRef.current = messageIdForSend;
      activeTimelineAnchorIndexRef.current = null;
      clearPendingTimelineAnchorScrollRestore();
      showScrollDebouncer.current.cancel();
      setShowScrollToBottom(false);
      const timelineAnchorThreadKey = scopedThreadKey(
        scopeThreadRef(activeThread.environmentId, threadIdForSend),
      );
      setTimelineAnchor({
        threadKey: timelineAnchorThreadKey,
        messageId: messageIdForSend,
      });

      setOptimisticUserMessages((existing) => [
        ...existing,
        {
          id: messageIdForSend,
          role: "user",
          text: outgoingMessageText,
          turnId: null,
          createdAt: messageCreatedAt,
          updatedAt: messageCreatedAt,
          streaming: false,
        },
      ]);

      const settingsResult = await persistThreadSettingsForNextTurn({
        threadId: threadIdForSend,
        createdAt: messageCreatedAt,
        modelSelection: ctxSelectedModelSelection,
        ...(localCheckoutBranchMismatch
          ? { branch: localCheckoutBranchMismatch.currentBranch }
          : {}),
        runtimeMode,
        interactionMode: nextInteractionMode,
      });
      let failure: AtomCommandResult<unknown, unknown> | null =
        settingsResult._tag === "Failure" ? settingsResult : null;

      if (failure === null) {
        // Keep the mode toggle and plan-follow-up banner in sync immediately
        // while the same-thread implementation turn is starting.
        setComposerDraftInteractionMode(
          scopeThreadRef(activeThread.environmentId, threadIdForSend),
          nextInteractionMode,
        );

        const startResult = await startThreadTurn({
          environmentId,
          input: {
            threadId: threadIdForSend,
            message: {
              messageId: messageIdForSend,
              role: "user",
              text: outgoingMessageText,
              attachments: [],
            },
            modelSelection: ctxSelectedModelSelection,
            titleSeed: activeThread.title,
            runtimeMode,
            interactionMode: nextInteractionMode,
            ...(nextInteractionMode === "default" && activeProposedPlan
              ? {
                  sourceProposedPlan: {
                    threadId: activeThread.id,
                    planId: activeProposedPlan.id,
                  },
                }
              : {}),
            createdAt: messageCreatedAt,
          },
        });
        failure = startResult._tag === "Failure" ? startResult : null;
      }

      if (failure === null) {
        acknowledgeActiveThreadWoke();
        sendInFlightRef.current = false;
        return;
      }

      clearFailedTimelineAnchor(timelineAnchorThreadKey, messageIdForSend);
      setOptimisticUserMessages((existing) =>
        existing.filter((message) => message.id !== messageIdForSend),
      );
      if (!isAtomCommandInterrupted(failure)) {
        const error = squashAtomCommandFailure(failure);
        setThreadError(
          threadIdForSend,
          error instanceof Error ? error.message : "Failed to send plan follow-up.",
        );
      }
      sendInFlightRef.current = false;
      resetLocalDispatch();
    },
    [
      activeThread,
      activeProposedPlan,
      acknowledgeActiveThreadWoke,
      beginMessageDispatch,
      clearFailedTimelineAnchor,
      clearPendingTimelineAnchorScrollRestore,
      isConnecting,
      isSendBusy,
      isServerThread,
      localCheckoutBranchMismatch,
      persistThreadSettingsForNextTurn,
      resetLocalDispatch,
      runtimeMode,
      setComposerDraftInteractionMode,
      showScrollDebouncer,
      setThreadError,
      startThreadTurn,
      environmentId,
      composerRef,
    ],
  );

  const onImplementPlanInNewThread = useCallback(async () => {
    if (
      !activeThread ||
      !activeProject ||
      !activeProposedPlan ||
      !isServerThread ||
      isSendBusy ||
      isConnecting ||
      activeEnvironmentUnavailable ||
      sendInFlightRef.current
    ) {
      return;
    }

    const sendCtx = composerRef.current?.getSendContext();
    if (!sendCtx?.providerAvailable) {
      return;
    }
    const {
      selectedProvider: ctxSelectedProvider,
      selectedModel: ctxSelectedModel,
      selectedProviderModels: ctxSelectedProviderModels,
      selectedPromptEffort: ctxSelectedPromptEffort,
      selectedModelSelection: ctxSelectedModelSelection,
    } = sendCtx;

    const createdAt = new Date().toISOString();
    const nextThreadId = newThreadId();
    const planMarkdown = activeProposedPlan.planMarkdown;
    const implementationPrompt = buildPlanImplementationPrompt(planMarkdown);
    const outgoingImplementationPrompt = formatOutgoingPrompt({
      provider: ctxSelectedProvider,
      model: ctxSelectedModel,
      models: ctxSelectedProviderModels,
      effort: ctxSelectedPromptEffort,
      text: implementationPrompt,
    });
    if (composerRef.current?.validateProviderInput(outgoingImplementationPrompt) === false) {
      return;
    }
    const nextThreadTitle = truncate(buildPlanImplementationThreadTitle(planMarkdown));
    const nextThreadModelSelection: ModelSelection = ctxSelectedModelSelection;

    sendInFlightRef.current = true;
    beginNewThreadBusyState();
    const finish = () => {
      sendInFlightRef.current = false;
      resetLocalDispatch();
    };

    const createResult = await createThread({
      environmentId,
      input: {
        threadId: nextThreadId,
        projectId: activeProject.id,
        title: nextThreadTitle,
        modelSelection: nextThreadModelSelection,
        runtimeMode,
        interactionMode: "default",
        branch: activeThreadBranch,
        worktreePath: activeThread.worktreePath,
        createdAt,
      },
    });
    let failure: AtomCommandResult<unknown, unknown> | null =
      createResult._tag === "Failure" ? createResult : null;

    if (failure === null) {
      const startResult = await startThreadTurn({
        environmentId,
        input: {
          threadId: nextThreadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: outgoingImplementationPrompt,
            attachments: [],
          },
          modelSelection: ctxSelectedModelSelection,
          titleSeed: nextThreadTitle,
          runtimeMode,
          interactionMode: "default",
          sourceProposedPlan: {
            threadId: activeThread.id,
            planId: activeProposedPlan.id,
          },
          createdAt,
        },
      });
      failure = startResult._tag === "Failure" ? startResult : null;
    }

    if (failure === null) {
      const startedResult = await settlePromise(() =>
        waitForStartedServerThread(scopeThreadRef(activeThread.environmentId, nextThreadId)),
      );
      failure = startedResult._tag === "Failure" ? startedResult : null;
    }

    if (failure === null) {
      const navigateResult = await settlePromise(() =>
        navigate({
          to: "/$environmentId/$threadId",
          params: {
            environmentId: activeThread.environmentId,
            threadId: nextThreadId,
          },
        }),
      );
      failure = navigateResult._tag === "Failure" ? navigateResult : null;
    }

    if (failure !== null) {
      const cleanupResult = await deleteThread({
        environmentId,
        input: {
          threadId: nextThreadId,
        },
      });
      if (cleanupResult._tag === "Failure" && !isAtomCommandInterrupted(cleanupResult)) {
        console.warn(
          "Failed to clean up implementation thread after start failure.",
          squashAtomCommandFailure(cleanupResult),
        );
      }
      if (!isAtomCommandInterrupted(failure)) {
        const error = squashAtomCommandFailure(failure);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not start implementation thread",
            description:
              error instanceof Error
                ? error.message
                : "An error occurred while creating the new thread.",
          }),
        );
      }
    }
    finish();
  }, [
    activeProject,
    activeProposedPlan,
    activeThreadBranch,
    activeThread,
    beginNewThreadBusyState,
    activeEnvironmentUnavailable,
    createThread,
    deleteThread,
    isConnecting,
    isSendBusy,
    isServerThread,
    navigate,
    resetLocalDispatch,
    runtimeMode,
    startThreadTurn,
    environmentId,
    composerRef,
  ]);

  const getModelDisabledReason = useCallback(
    (instanceId: ProviderInstanceId, model: string): string | null => {
      if (!activeThread) {
        return null;
      }
      const reason = getStartedThreadModelChangeBlockReason({
        providers: providerStatuses,
        hasStartedSession: activeThread.session !== null,
        currentModelSelection: activeThread.modelSelection,
        currentProviderInstanceId: activeThread.session?.providerInstanceId ?? null,
        nextModelSelection: { instanceId, model },
      });
      return reason ? `${reason.description} Start a new thread to use this model.` : null;
    },
    [activeThread, providerStatuses],
  );

  const onProviderModelSelect = useCallback(
    (instanceId: ProviderInstanceId, model: string) => {
      if (!activeThread) return;
      // Look up the configured instance so model normalization and custom
      // model lookup stay scoped to that exact instance. Unknown instance ids
      // are rejected by returning early; the server remains authoritative too.
      const entry = providerStatuses.find((snapshot) => snapshot.instanceId === instanceId);
      const resolvedDriverKind = entry?.driver ?? null;
      if (
        lockedProvider !== null &&
        resolvedDriverKind !== null &&
        resolvedDriverKind !== lockedProvider
      ) {
        scheduleComposerFocus();
        return;
      }
      if (lockedProvider !== null && activeThread.session?.providerInstanceId) {
        const currentEntry = providerStatuses.find(
          (snapshot) => snapshot.instanceId === activeThread.session?.providerInstanceId,
        );
        if (
          currentEntry?.continuation?.groupKey &&
          entry?.continuation?.groupKey &&
          currentEntry.continuation.groupKey !== entry.continuation.groupKey
        ) {
          scheduleComposerFocus();
          return;
        }
      }
      const resolvedModel = resolveAppModelSelectionForInstance(
        instanceId,
        settings,
        providerStatuses,
        model,
      );
      if (!resolvedModel) {
        scheduleComposerFocus();
        return;
      }
      const nextModelSelection: ModelSelection = {
        instanceId,
        model: resolvedModel,
      };
      const modelChangeBlockReason = getStartedThreadModelChangeBlockReason({
        providers: providerStatuses,
        hasStartedSession: activeThread.session !== null,
        currentModelSelection: activeThread.modelSelection,
        currentProviderInstanceId: activeThread.session?.providerInstanceId ?? null,
        nextModelSelection,
      });
      if (modelChangeBlockReason) {
        toastManager.add({
          type: "warning",
          title: modelChangeBlockReason.title,
          description: modelChangeBlockReason.description,
        });
        scheduleComposerFocus();
        return;
      }
      setComposerDraftModelSelection(
        scopeThreadRef(activeThread.environmentId, activeThread.id),
        nextModelSelection,
      );
      setStickyComposerModelSelection(nextModelSelection);
      scheduleComposerFocus();
    },
    [
      activeThread,
      lockedProvider,
      scheduleComposerFocus,
      setComposerDraftModelSelection,
      setStickyComposerModelSelection,
      providerStatuses,
      settings,
    ],
  );
  const onEnvModeChange = useCallback(
    (mode: DraftThreadEnvMode) => {
      if (canOverrideServerThreadEnvMode) {
        setPendingServerThreadEnvMode(mode);
        scheduleComposerFocus();
        return;
      }
      if (isLocalDraftThread) {
        setDraftThreadContext(composerDraftTarget, {
          envMode: mode,
          startFromOrigin: resolveNewDraftStartFromOrigin({
            envMode: mode,
            newWorktreesStartFromOrigin: primaryServerSettings.newWorktreesStartFromOrigin,
          }),
          ...(mode === "worktree" && draftThread?.worktreePath ? { worktreePath: null } : {}),
        });
      }
      scheduleComposerFocus();
    },
    [
      canOverrideServerThreadEnvMode,
      composerDraftTarget,
      draftThread?.worktreePath,
      isLocalDraftThread,
      primaryServerSettings.newWorktreesStartFromOrigin,
      setPendingServerThreadEnvMode,
      scheduleComposerFocus,
      setDraftThreadContext,
    ],
  );

  const onStartFromOriginChange = (nextStartFromOrigin: boolean) => {
    if (canOverrideServerThreadEnvMode && activeThread) {
      setPendingServerThreadStartFromOriginByThreadId((current) =>
        current[activeThread.id] === nextStartFromOrigin
          ? current
          : { ...current, [activeThread.id]: nextStartFromOrigin },
      );
      return;
    }
    if (isLocalDraftThread) {
      setDraftThreadContext(composerDraftTarget, {
        startFromOrigin: nextStartFromOrigin,
      });
    }
  };

  const onExpandTimelineImage = useCallback((preview: ExpandedImagePreview) => {
    setExpandedImage(preview);
  }, []);
  const onOpenTurnDiff = useCallback(
    (turnId: TurnId, filePath?: string) => {
      if (!isServerThread || !activeThreadRef) return;
      useDiffPanelStore.getState().selectTurn(activeThreadRef, turnId, filePath);
      useRightPanelStore.getState().open(activeThreadRef, "diff");
      onDiffPanelOpen?.();
    },
    [activeThreadRef, isServerThread, onDiffPanelOpen],
  );
  // Both the Map and the revert handler are read from refs at call-time so
  // the callback reference is fully stable and never busts context identity.
  const revertTurnCountRef = useRef(revertTurnCountByUserMessageId);
  revertTurnCountRef.current = revertTurnCountByUserMessageId;
  const onRevertToTurnCountRef = useRef(onRevertToTurnCount);
  onRevertToTurnCountRef.current = onRevertToTurnCount;
  const onRevertUserMessage = useCallback((messageId: MessageId) => {
    const targetTurnCount = revertTurnCountRef.current.get(messageId);
    if (typeof targetTurnCount !== "number") {
      return;
    }
    void onRevertToTurnCountRef.current(targetTurnCount);
  }, []);

  // Empty state: no active thread
  if (!activeThread) {
    return <NoActiveThreadState />;
  }

  const panelToggleControls = (
    <PanelLayoutControls
      terminalAvailable={terminalAvailable}
      terminalOpen={terminalUiState.terminalOpen}
      terminalShortcutLabel={shortcutLabelForCommand(keybindings, "terminal.toggle")}
      rightPanelAvailable={hasActiveProject}
      rightPanelOpen={rightPanelOpen}
      rightPanelShortcutLabel={shortcutLabelForCommand(keybindings, "rightPanel.toggle")}
      // Suppressed while the Agents surface is visible: the roster itself is
      // on screen, so the toggle badge would be pointing at nothing.
      liveAgentCount={
        rightPanelOpen && activeRightPanelSurface?.kind === "agents" ? 0 : agentPanelModel.liveCount
      }
      onToggleTerminal={toggleTerminalVisibility}
      onToggleRightPanel={toggleRightPanel}
    />
  );
  const panelLayoutControls = (
    <div
      className={cn(
        // One inset in both states: the controls move between containers when
        // the right panel opens, and a different right offset made them jump
        // sideways on every toggle.
        "absolute top-[var(--workspace-controls-top)] right-[var(--workspace-controls-right)] z-50 mr-px flex h-[var(--workspace-topbar-height)] items-center gap-1 [-webkit-app-region:no-drag]",
      )}
      data-workspace-titlebar-controls
    >
      {rightPanelOpen && !shouldUseRightPanelSheet ? (
        <RightPanelMaximizeControl
          maximized={rightPanelMaximized}
          onToggle={toggleRightPanelMaximized}
        />
      ) : null}
      {panelToggleControls}
    </div>
  );
  const rightPanelContent = activeThreadRef ? (
    visibleActiveRightPanelSurface?.kind === "preview" ? (
      <Suspense fallback={null}>
        <PreviewPanel
          mode="embedded"
          threadRef={activeThreadRef}
          tabId={visibleActiveRightPanelSurface.resourceId}
          configuredUrls={configuredPreviewUrls}
          visible
          onSendAnnotation={(annotation, image) => {
            void onSend(undefined, "foreground", { annotation, image });
          }}
        />
      </Suspense>
    ) : visibleActiveRightPanelSurface?.kind === "terminal" ? (
      <PersistentThreadTerminalPanel
        threadRef={activeThreadRef}
        surface={visibleActiveRightPanelSurface}
        launchContext={activeTerminalLaunchContext ?? null}
        focusRequestId={terminalFocusRequestId}
        keybindings={keybindings}
        onAddTerminalContext={addTerminalContextToDraft}
        onSplitTerminal={splitPanelTerminal}
        onSplitTerminalVertical={splitPanelTerminalVertical}
        onNewTerminal={addTerminalSurface}
        onActiveTerminalChange={activatePanelTerminal}
        onCloseTerminal={closePanelTerminal}
        splitShortcutLabel={splitTerminalShortcutLabel ?? undefined}
        splitVerticalShortcutLabel={splitTerminalVerticalShortcutLabel ?? undefined}
        newShortcutLabel={newTerminalShortcutLabel ?? undefined}
        closeShortcutLabel={closeTerminalShortcutLabel ?? undefined}
      />
    ) : visibleActiveRightPanelSurface?.kind === "diff" ? (
      <Suspense fallback={null}>
        <DiffPanel
          key={`${activeThreadKey}:${diffPanelGitStatusResolutionKey}`}
          mode="embedded"
          composerDraftTarget={composerDraftTarget}
          initialGitScope={initialDiffPanelGitScope}
        />
      </Suspense>
    ) : sourceControlPanelTarget ? (
      <Suspense fallback={null}>
        <SourceControlPanel
          key={`${sourceControlPanelTarget.environmentId}:${sourceControlPanelTarget.threadId}:${sourceControlPanelTarget.cwd}`}
          environmentId={sourceControlPanelTarget.environmentId}
          threadId={sourceControlPanelTarget.threadId}
          cwd={sourceControlPanelTarget.cwd}
          worktreePath={activeThreadWorktreePath}
          environments={logicalProjectEnvironments}
          keybindings={keybindings}
          onRunProjectScript={runSourceControlProjectScript}
          onAddProjectScript={saveProjectScriptForTarget}
          onUpdateProjectScript={updateProjectScriptForTarget}
          onDeleteProjectScript={deleteProjectScriptForTarget}
          onThreadRefChange={handleSourceControlThreadRefChange}
        />
      </Suspense>
    ) : visibleActiveRightPanelSurface?.kind === "pull-request" && !pullRequestsCapabilityKnown ? (
      <PullRequestDetailGhost />
    ) : visibleActiveRightPanelSurface?.kind === "pull-request" && !supportsPullRequests ? (
      <PullRequestsUnavailableState
        title="Pull requests unavailable"
        error="Update this environment's T3 Code server to browse pull requests."
      />
    ) : visibleActiveRightPanelSurface?.kind === "pull-request" ? (
      // No onClose: the surface tab's own X owns closing here, and a second X in the header
      // would be the same action twice. The thread context also drops the checkout button, so it
      // is only right for the thread's own pull request, whose branch is already under the
      // reader's feet. A link the agent wrote can open any other one here, and that one has to be
      // checkable out like it is anywhere else.
      <PullRequestDetailPanel
        key={`${visibleActiveRightPanelSurface.repository}#${visibleActiveRightPanelSurface.number}`}
        environmentId={activeThread.environmentId}
        reference={{
          projectId: visibleActiveRightPanelSurface.projectId as ProjectId,
          repository: visibleActiveRightPanelSurface.repository,
          number: visibleActiveRightPanelSurface.number,
        }}
        context={
          isThreadOwnPullRequest(
            {
              projectId: activeProject?.id ?? null,
              repository: threadRepository,
              number: activeThreadPr?.number ?? null,
            },
            {
              projectId: visibleActiveRightPanelSurface.projectId,
              repository: visibleActiveRightPanelSurface.repository,
              number: visibleActiveRightPanelSurface.number,
            },
          )
            ? "thread"
            : "page"
        }
        composerDraftTarget={composerDraftTarget}
        onStateChange={handlePullRequestTabStatusChange}
      />
    ) : visibleActiveRightPanelSurface?.kind === "magi" ? (
      <MagiPanel
        environmentId={activeThreadRef.environmentId}
        threadId={activeThreadRef.threadId}
        isVisible={rightPanelOpen}
        activeRun={activeThreadShell?.activeMagiRun ?? null}
        providers={providerStatuses}
        settings={settings}
        {...(isLocalDraftThread
          ? {
              draftArm: composerMagiArm,
              onDraftArmChange: (config) => setComposerDraftMagiArm(composerDraftTarget, config),
            }
          : {})}
      />
    ) : visibleActiveRightPanelSurface?.kind === "agents" ? (
      <AgentsPanel
        model={agentPanelModel}
        environmentId={activeThreadRef.environmentId}
        threadId={activeThreadRef.threadId}
        titleByAgentId={childTitleByAgentId}
        onOpenAgent={subagentConversationVisibilityEnabled ? openAgentConversation : null}
      />
    ) : (visibleActiveRightPanelSurface?.kind === "files" ||
        visibleActiveRightPanelSurface?.kind === "file") &&
      activeProject &&
      activeWorkspaceRoot ? (
      <Suspense fallback={null}>
        <FilePreviewPanel
          key={`${activeProject.environmentId}:${activeFileSurface?.cwd ?? activeWorkspaceRoot}`}
          environmentId={activeProject.environmentId}
          cwd={activeFileSurface?.cwd ?? activeWorkspaceRoot}
          projectName={activeProject.title}
          threadRef={activeThreadRef}
          composerDraftTarget={composerDraftTarget}
          keybindings={keybindings}
          availableEditors={availableEditors}
          relativePath={
            visibleActiveRightPanelSurface.kind === "file"
              ? visibleActiveRightPanelSurface.relativePath
              : null
          }
          revealLine={activeFileSurface?.revealLine ?? null}
          revealRequestId={activeFileSurface?.revealRequestId ?? 0}
          onOpenFile={openFileSurface}
          onPendingChange={handleFilePendingChange}
        />
      </Suspense>
    ) : null
  ) : null;

  const workspaceFileDropHandlers = makeWorkspaceFileDropHandlers({
    setDragActive: setIsWorkspaceFileDragActive,
    addFiles: (files) => composerRef.current?.addDroppedFiles(files),
  });

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background">
      {rightPanelOpen && !shouldUseRightPanelSheet ? panelLayoutControls : null}
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-col overflow-x-hidden",
          rightPanelMaximized ? "w-0 flex-none" : "flex-1",
        )}
        data-chat-column-maximized-away={rightPanelMaximized ? "true" : "false"}
      >
        {/* Top bar */}
        <WorkspacePageHeader
          data-chat-header
          electron={isElectron}
          reserveNativeControls={reserveTitleBarControlInset && !inlineRightPanelOwnsTitleBar}
          className="relative bg-background"
        >
          {!rightPanelOpen ? panelLayoutControls : null}
          <ChatHeader
            {...(!supportsPullRequests || threadRepository === null
              ? {}
              : { onOpenPullRequest: openThreadPullRequest })}
            activeThreadEnvironmentId={activeThread.environmentId}
            activeThreadId={activeThread.id}
            {...(routeKind === "draft" && draftId ? { draftId } : {})}
            activeThreadTitle={activeThread.title}
            isServerThread={isServerThread}
            changeRequest={activeThreadChangeRequest}
            activeProjectName={activeProject?.title}
            activeProjectCwd={activeProject?.workspaceRoot ?? null}
            activeProjectFaviconPath={activeProject?.faviconPath ?? null}
            openInCwd={gitCwd}
            activeProjectScripts={activeProject?.scripts}
            preferredScriptId={
              activeProject ? (lastInvokedScriptByProjectId[activeProject.id] ?? null) : null
            }
            keybindings={keybindings}
            availableEditors={availableEditors}
            rightPanelOpen={rightPanelOpen}
            gitCwd={gitCwd}
            {...(activeThreadParentRef ? { onOpenParentThread: openActiveThreadParent } : {})}
            onNewThreadInProject={handleNewThreadInActiveProject}
            onRunProjectScript={runProjectScript}
            onAddProjectScript={saveProjectScript}
            onUpdateProjectScript={updateProjectScript}
            onDeleteProjectScript={deleteProjectScript}
          />
        </WorkspacePageHeader>

        <ThreadErrorBanner error={visibleThreadError} onDismiss={dismissThreadError} />
        {/* Main content area with optional plan sidebar */}
        <div className="flex min-h-0 min-w-0 flex-1">
          {/* Chat column */}
          <div
            className="relative flex min-h-0 min-w-0 flex-1 flex-col"
            data-chat-workspace-drop-target="true"
            onDragEnter={workspaceFileDropHandlers.onDragEnter}
            onDragOver={workspaceFileDropHandlers.onDragOver}
            onDragLeave={workspaceFileDropHandlers.onDragLeave}
            onDrop={workspaceFileDropHandlers.onDrop}
          >
            {isWorkspaceFileDragActive ? (
              <div
                className="pointer-events-none absolute inset-2 z-40 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/60 bg-primary/[0.035]"
                data-chat-workspace-drop-overlay="true"
              >
                <div
                  role="status"
                  className="flex items-center gap-2 rounded-full border border-primary/25 bg-background/95 px-4 py-2.5 text-sm font-medium text-foreground shadow-lg"
                >
                  <PaperclipIcon className="size-4 text-primary" aria-hidden="true" />
                  Drop files to attach
                </div>
              </div>
            ) : null}
            {/* Provider status overlays the timeline without changing its content height. */}
            <div className="pointer-events-none absolute inset-x-0 top-0 z-20">
              <ProviderStatusBanner
                status={visibleProviderStatus}
                onDismiss={() => setDismissedProviderStatusBannerKey(providerStatusBannerKey)}
              />
            </div>
            {/* Messages Wrapper */}
            <div className="relative flex min-h-0 flex-1 flex-col">
              {/* Messages — LegendList handles virtualization and scrolling internally */}
              <MessagesTimeline
                agentPanelModel={agentPanelModel}
                onOpenAgents={addAgentsSurface}
                activeMagiRun={activeThreadShell?.activeMagiRun ?? null}
                onOpenMagi={addMagiSurface}
                key={activeThread.id}
                isWorking={isWorking}
                workingStepLabel={workingStepLabel}
                activeTurnInProgress={isWorking || !latestTurnSettled}
                activeTurnStartedAt={activeWorkStartedAt}
                listRef={legendListRef}
                timelineEntries={timelineEntries}
                latestTurn={activeLatestTurn}
                runningTurnId={
                  activeThread.session?.status === "running"
                    ? activeThread.session.activeTurnId
                    : null
                }
                turnDiffSummaryByAssistantMessageId={turnDiffSummaryByAssistantMessageId}
                activeThreadEnvironmentId={activeThread.environmentId}
                routeThreadKey={routeThreadKey}
                onOpenTurnDiff={onOpenTurnDiff}
                revertTurnCountByUserMessageId={revertTurnCountByUserMessageId}
                onRevertUserMessage={onRevertUserMessage}
                isRevertingCheckpoint={isRevertingCheckpoint}
                onImageExpand={onExpandTimelineImage}
                markdownCwd={gitCwd ?? undefined}
                resolvedTheme={resolvedTheme}
                timestampFormat={timestampFormat}
                workspaceRoot={activeWorkspaceRoot}
                skills={activeProviderStatus?.skills ?? []}
                anchorMessageId={timelineAnchorMessageId}
                onAnchorReady={onTimelineAnchorReady}
                contentInsetEndAdjustment={composerOverlayHeight}
                liveFollowEnabled={timelineLiveFollowEnabled}
                onIsAtEndChange={onIsAtEndChange}
                onManualNavigation={cancelTimelineLiveFollowForUserNavigation}
                hideEmptyPlaceholder={isDraftHeroState || threadDetailLoading}
                topFadeEnabled={!hasTimelineTopBanner}
                loadEarlier={loadEarlierTurns}
              />

              {/* scroll to end pill — shown when user has scrolled away from the live edge */}
              {showScrollToBottom && (
                <div
                  className="pointer-events-none absolute left-1/2 z-30 flex -translate-x-1/2 justify-center py-1.5"
                  style={{ bottom: composerOverlayHeight + 4 }}
                >
                  <Button
                    aria-label="Scroll to end"
                    onClick={() => scrollToEnd(true)}
                    className="pointer-events-auto gap-1.5 rounded-full px-3 text-muted-foreground hover:text-foreground"
                    size="xs"
                    variant="glass"
                  >
                    <ChevronDownIcon className="size-3.5" />
                    Scroll to end
                  </Button>
                </div>
              )}
            </div>

            {/* Input bar — centered hero while a draft has no messages, docked at the bottom otherwise */}
            <div
              ref={setComposerOverlayElement}
              data-chat-composer-overlay="true"
              className={
                isDraftHeroState
                  ? "pointer-events-none absolute inset-0 z-20 flex items-center"
                  : "pointer-events-none absolute inset-x-0 bottom-0 z-20 pt-1.5 sm:pt-2"
              }
            >
              <div
                ref={attachDraftHeroTransitionGroupRef}
                className="w-full ps-[calc(env(safe-area-inset-left)+0.75rem)] pe-[calc(env(safe-area-inset-right)+0.75rem)] sm:ps-[calc(env(safe-area-inset-left)+1.25rem)] sm:pe-[calc(env(safe-area-inset-right)+1.25rem)]"
              >
                <div className="pointer-events-auto relative z-10">
                  {isDraftHeroState ? (
                    <div className="absolute inset-x-0 bottom-full z-0">
                      <div
                        className="pb-8"
                        style={
                          forceExpandedMobileComposer
                            ? {
                                viewTransitionName: MOBILE_DRAFT_HEADLINE_VIEW_TRANSITION_NAME,
                              }
                            : undefined
                        }
                      >
                        <DraftHeroHeadline
                          activeProjectRef={activeProjectRef}
                          activeProjectTitle={activeProject?.title ?? null}
                        />
                      </div>
                      <ComposerBannerStack className="relative z-0" items={composerBannerItems} />
                    </div>
                  ) : (
                    <ComposerBannerStack className="relative z-0" items={composerBannerItems} />
                  )}
                  {threadSyncPhase && !activeEnvironmentUnavailable ? (
                    <ThreadSyncStatusPill phase={threadSyncPhase} />
                  ) : null}
                  <div
                    className="relative"
                    style={
                      forceExpandedMobileComposer
                        ? { viewTransitionName: MOBILE_COMPOSER_VIEW_TRANSITION_NAME }
                        : undefined
                    }
                  >
                    <div
                      className={cn(
                        "chat-composer-glass-shell relative mx-auto w-full max-w-3xl",
                        showComposerContextStrip && "chat-composer-glass-shell-with-context",
                      )}
                    >
                      <div className="chat-composer-glass-host relative z-10 w-full rounded-[22px]">
                        <div ref={attachDraftHeroComposerAnchorRef} className="relative z-10">
                          {activeThreadSubagentRelation ? (
                            <SubagentControlBar
                              title={activeThread.title}
                              status={activeThreadSubagentRelation.status}
                              startedAt={activeThreadSubagentRelation.startedAt}
                              completedAt={activeThreadSubagentRelation.completedAt}
                              stopping={
                                isConnecting || pendingSubagentStopThreadId === activeThread.id
                              }
                              onStop={onInterrupt}
                            />
                          ) : (
                            <ChatComposer
                              composerRef={composerRef}
                              composerDraftTarget={composerDraftTarget}
                              environmentId={environmentId}
                              routeKind={routeKind}
                              routeThreadRef={routeThreadRef}
                              draftId={draftId}
                              activeThreadId={activeThreadId}
                              activeThreadEnvironmentId={activeThread?.environmentId}
                              activeThread={activeThread}
                              isServerThread={isServerThread}
                              isLocalDraftThread={isLocalDraftThread}
                              forceExpandedOnMobile={
                                forceExpandedMobileComposer && isDraftHeroState
                              }
                              projectSelectionRequired={
                                isLocalDraftThread && activeProject === null
                              }
                              phase={phase}
                              isConnecting={isConnecting}
                              isSendBusy={isSendBusy}
                              sendDisabledReason={
                                feedbackUploading
                                  ? "Sending feedback"
                                  : threadDetailLoading
                                    ? "Messages loading"
                                    : null
                              }
                              isPreparingWorktree={isPreparingWorktree}
                              environmentUnavailable={activeEnvironmentUnavailableState}
                              activePendingApproval={activePendingApproval}
                              pendingApprovals={pendingApprovals}
                              pendingUserInputs={pendingUserInputs}
                              activePendingProgress={activePendingProgress}
                              activePendingResolvedAnswers={activePendingResolvedAnswers}
                              activePendingIsResponding={activePendingIsResponding}
                              activePendingDraftAnswers={activePendingDraftAnswers}
                              activePendingQuestionIndex={activePendingQuestionIndex}
                              respondingRequestIds={respondingRequestIds}
                              showPlanFollowUpPrompt={showPlanFollowUpPrompt}
                              activeProposedPlan={activeProposedPlan}
                              runtimeMode={runtimeMode}
                              interactionMode={interactionMode}
                              lockedProvider={lockedProvider}
                              providerStatuses={providerStatuses as ServerProvider[]}
                              activeProjectDefaultModelSelection={
                                activeProject?.defaultModelSelection
                              }
                              activeThreadModelSelection={activeThread?.modelSelection}
                              activeThreadActivities={activeThread?.activities}
                              resolvedTheme={resolvedTheme}
                              settings={settings}
                              keybindings={keybindings}
                              terminalOpen={Boolean(terminalUiState.terminalOpen)}
                              gitCwd={gitCwd}
                              promptRef={promptRef}
                              composerImagesRef={composerImagesRef}
                              composerTerminalContextsRef={composerTerminalContextsRef}
                              composerElementContextsRef={composerElementContextsRef}
                              onSend={onSend}
                              onInterrupt={onInterrupt}
                              onImplementPlanInNewThread={onImplementPlanInNewThread}
                              onRespondToApproval={onRespondToApproval}
                              onSelectActivePendingUserInputOption={
                                onSelectActivePendingUserInputOption
                              }
                              onAdvanceActivePendingUserInput={onAdvanceActivePendingUserInput}
                              onPreviousActivePendingUserInputQuestion={
                                onPreviousActivePendingUserInputQuestion
                              }
                              onChangeActivePendingUserInputCustomAnswer={
                                onChangeActivePendingUserInputCustomAnswer
                              }
                              onProviderModelSelect={onProviderModelSelect}
                              getModelDisabledReason={getModelDisabledReason}
                              toggleInteractionMode={toggleInteractionMode}
                              handleRuntimeModeChange={handleRuntimeModeChange}
                              handleInteractionModeChange={handleInteractionModeChange}
                              focusComposer={focusComposer}
                              scheduleComposerFocus={scheduleComposerFocus}
                              setThreadError={setThreadError}
                              onExpandImage={onExpandTimelineImage}
                            />
                          )}
                        </div>
                      </div>
                      <div className="min-h-0">
                        <div
                          data-terminal-open={terminalUiState.terminalOpen ? "true" : undefined}
                          className="relative z-0"
                        >
                          {showComposerContextStrip && (
                            <div className="pointer-events-auto">
                              <BranchToolbar
                                environmentId={activeThread.environmentId}
                                threadId={activeThread.id}
                                showGitControls={isGitRepo}
                                {...(routeKind === "draft" && draftId ? { draftId } : {})}
                                onEnvModeChange={onEnvModeChange}
                                startFromOrigin={startFromOrigin}
                                onStartFromOriginChange={onStartFromOriginChange}
                                {...(canOverrideServerThreadEnvMode
                                  ? { effectiveEnvModeOverride: envMode }
                                  : {})}
                                {...(canOverrideServerThreadEnvMode
                                  ? {
                                      activeThreadBranchOverride: activeThreadBranch,
                                      onActiveThreadBranchOverrideChange:
                                        setPendingServerThreadBranch,
                                    }
                                  : {})}
                                envLocked={envLocked}
                                onComposerFocusRequest={scheduleComposerFocus}
                                {...(canCheckoutPullRequestIntoThread
                                  ? { onCheckoutPullRequestRequest: openPullRequestDialog }
                                  : {})}
                                {...(hasMultipleEnvironments ? { onEnvironmentChange } : {})}
                                availableEnvironments={logicalProjectEnvironments}
                              />
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                    <div
                      aria-hidden
                      className="h-[calc(env(safe-area-inset-bottom)+1rem)] sm:h-[calc(env(safe-area-inset-bottom)+1.25rem)]"
                    />
                  </div>
                </div>
              </div>
            </div>

            {activeThreadRef && activePreviewMiniPlayer ? (
              <ThreadPreviewMiniPlayer
                key={`${activeThreadKey}:${activePreviewMiniPlayer.tabId}`}
                threadRef={activeThreadRef}
                tabId={activePreviewMiniPlayer.tabId}
                bottomInset={isDraftHeroState ? 0 : composerOverlayHeight}
              />
            ) : null}

            <AlertDialog open={branchRestoreConfirmOpen} onOpenChange={setBranchRestoreConfirmOpen}>
              <AlertDialogPopup>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    Switch to{" "}
                    <code className="font-medium">
                      {localCheckoutBranchMismatch?.threadBranch ?? ""}
                    </code>
                    ?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    You have uncommitted changes. They'll carry over to the other branch, or block
                    the switch if they conflict.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
                  <Button
                    variant="default"
                    onClick={() => {
                      setBranchRestoreConfirmOpen(false);
                      void handleSwitchCheckoutToThread();
                    }}
                  >
                    Switch branch
                  </Button>
                </AlertDialogFooter>
              </AlertDialogPopup>
            </AlertDialog>

            {pullRequestDialogState ? (
              <PullRequestThreadDialog
                key={pullRequestDialogState.key}
                open
                environmentId={activeThread.environmentId}
                threadId={activeThread.id}
                cwd={activeProject?.workspaceRoot ?? null}
                initialReference={pullRequestDialogState.initialReference}
                onOpenChange={(open) => {
                  if (!open) {
                    closePullRequestDialog();
                  }
                }}
                onPrepared={handlePreparedPullRequestThread}
              />
            ) : null}
          </div>
          {/* end chat column */}
        </div>
        {/* end horizontal flex container */}

        {terminalEnabled
          ? mountedTerminalThreadRefs.map(
              ({ key: mountedThreadKey, threadRef: mountedThreadRef }) => (
                <PersistentThreadTerminalDrawer
                  key={mountedThreadKey}
                  threadRef={mountedThreadRef}
                  threadId={mountedThreadRef.threadId}
                  visible={mountedThreadKey === activeThreadKey && terminalUiState.terminalOpen}
                  launchContext={
                    mountedThreadKey === activeThreadKey
                      ? (activeTerminalLaunchContext ?? null)
                      : null
                  }
                  focusRequestId={mountedThreadKey === activeThreadKey ? terminalFocusRequestId : 0}
                  splitShortcutLabel={splitTerminalShortcutLabel ?? undefined}
                  splitVerticalShortcutLabel={splitTerminalVerticalShortcutLabel ?? undefined}
                  newShortcutLabel={newTerminalShortcutLabel ?? undefined}
                  closeShortcutLabel={closeTerminalShortcutLabel ?? undefined}
                  keybindings={keybindings}
                  onAddTerminalContext={addTerminalContextToDraft}
                />
              ),
            )
          : null}
      </div>

      {!shouldUseRightPanelSheet && rightPanelOpen && activeThreadRef ? (
        <RightPanelTabs
          mode="inline"
          maximized={rightPanelMaximized}
          surfaces={visibleRightPanelSurfaces}
          activeSurfaceId={visibleActiveRightPanelSurface?.id ?? null}
          pendingSurfaceIds={pendingFileSurfaceIds}
          previewSessions={activePreviewState.sessions}
          desktopByTabId={activePreviewState.desktopByTabId}
          previewRuntimeTabId={resolvePreviewRuntimeTabId}
          terminalLabelsById={activeTerminalLabelsById}
          onActivate={activateRightPanelSurface}
          onCloseSurface={closeRightPanelSurface}
          onCloseOtherSurfaces={closeOtherRightPanelSurfaces}
          onCloseSurfacesToRight={closeRightPanelSurfacesToRight}
          onCloseAllSurfaces={closeAllRightPanelSurfaces}
          onCopyFilePath={copyRightPanelFilePath}
          onAddBrowser={createBrowserSurface}
          onAddTerminal={addTerminalSurface}
          onAddDiff={addDiffSurface}
          onAddFiles={addFilesSurface}
          onAddSourceControl={addSourceControlSurface}
          onAddPullRequest={addPullRequestSurface}
          onAddAgents={addAgentsSurface}
          onAddMagi={addMagiSurface}
          browserAvailable={isPreviewSupportedInRuntime()}
          terminalAvailable={activeProject !== null}
          diffAvailable={isServerThread && isGitRepo}
          filesAvailable={hasActiveProject}
          sourceControlAvailable={sourceControlAvailable}
          pullRequestAvailable={pullRequestSurfaceAvailable}
          agentsAvailable
          magiAvailable={
            serverConfig?.environment.capabilities.magi === true &&
            (isServerThread || isLocalDraftThread)
          }
          pullRequestStatuses={pullRequestTabStatuses}
          liveAgentCount={agentPanelModel.liveCount}
        >
          {rightPanelContent}
        </RightPanelTabs>
      ) : null}
      {shouldUseRightPanelSheet && rightPanelOpen && activeThreadRef ? (
        <RightPanelSheet open onClose={closePreviewPanel}>
          <RightPanelTabs
            mode="sheet"
            // Same effective inset as the closed-state titlebar controls
            // (pr-3 in the tab bar plus this pixel equals the absolute
            // right inset plus mr-px), so the cluster does not creep when
            // the sheet opens.
            layoutControls={<div className="mr-px flex items-center">{panelToggleControls}</div>}
            surfaces={visibleRightPanelSurfaces}
            activeSurfaceId={visibleActiveRightPanelSurface?.id ?? null}
            pendingSurfaceIds={pendingFileSurfaceIds}
            previewSessions={activePreviewState.sessions}
            desktopByTabId={activePreviewState.desktopByTabId}
            previewRuntimeTabId={resolvePreviewRuntimeTabId}
            terminalLabelsById={activeTerminalLabelsById}
            onActivate={activateRightPanelSurface}
            onCloseSurface={closeRightPanelSurface}
            onCloseOtherSurfaces={closeOtherRightPanelSurfaces}
            onCloseSurfacesToRight={closeRightPanelSurfacesToRight}
            onCloseAllSurfaces={closeAllRightPanelSurfaces}
            onCopyFilePath={copyRightPanelFilePath}
            onAddBrowser={createBrowserSurface}
            onAddTerminal={addTerminalSurface}
            onAddDiff={addDiffSurface}
            onAddFiles={addFilesSurface}
            onAddSourceControl={addSourceControlSurface}
            onAddPullRequest={addPullRequestSurface}
            onAddAgents={addAgentsSurface}
            onAddMagi={addMagiSurface}
            browserAvailable={isPreviewSupportedInRuntime()}
            terminalAvailable={activeProject !== null}
            diffAvailable={isServerThread && isGitRepo}
            filesAvailable={hasActiveProject}
            sourceControlAvailable={sourceControlAvailable}
            pullRequestAvailable={pullRequestSurfaceAvailable}
            agentsAvailable
            magiAvailable={
              serverConfig?.environment.capabilities.magi === true &&
              (isServerThread || isLocalDraftThread)
            }
            pullRequestStatuses={pullRequestTabStatuses}
            liveAgentCount={agentPanelModel.liveCount}
          >
            {rightPanelContent}
          </RightPanelTabs>
        </RightPanelSheet>
      ) : null}

      {expandedImage && (
        <ExpandedImageDialog
          key={`${expandedImage.images[expandedImage.index]?.src ?? "image"}:${expandedImage.index}`}
          preview={expandedImage}
          onClose={closeExpandedImage}
        />
      )}
    </div>
  );
}

export default function ChatView(props: ChatViewProps) {
  return (
    <DiffWorkerPoolProvider>
      <ChatViewContent {...props} />
    </DiffWorkerPoolProvider>
  );
}
