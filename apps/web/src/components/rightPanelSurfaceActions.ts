import { msg } from "gt-react";
import { PullRequestGlyph } from "./pullRequest/pullRequestIcons";
import { surfaceShortcutKey } from "~/lib/surfaceShortcutKey";
import {
  FileDiff,
  Files,
  GitBranch,
  Smartphone,
  Globe2,
  MessagesSquare,
  type LucideIcon,
  TerminalSquare,
} from "lucide-react";

export type AddPanelSurfaceId =
  | "source-control"
  | "browser"
  | "terminal"
  | "files"
  | "diff"
  | "pull-request"
  | "pull-requests"
  | "device"
  | "side-chat";

export type AddPanelSurfacePlacement = "empty-state" | "menu";

export interface AddPanelSurfaceActionProps {
  readonly onAddBrowser: () => void;
  readonly onAddTerminal: () => void;
  readonly onAddDiff: () => void;
  readonly onAddFiles: () => void;
  readonly onAddSourceControl?: (() => void) | undefined;
  readonly onAddPullRequest: () => void;
  readonly browserAvailable: boolean;
  readonly terminalAvailable: boolean;
  readonly diffAvailable: boolean;
  readonly filesAvailable: boolean;
  readonly sourceControlAvailable: boolean;
  readonly pullRequestAvailable: boolean;
  readonly onAddPullRequests: () => void;
  readonly onAddDevice: () => void;
  readonly pullRequestsAvailable: boolean;
  readonly deviceAvailable: boolean;
  readonly onAddSideChat?: (() => void) | undefined;
  readonly sideChatAvailable?: boolean;
  readonly sideChatDisabledReason?: string | null;
}

type AvailabilityKey = keyof Pick<
  AddPanelSurfaceActionProps,
  | "browserAvailable"
  | "terminalAvailable"
  | "diffAvailable"
  | "filesAvailable"
  | "sourceControlAvailable"
  | "pullRequestAvailable"
  | "pullRequestsAvailable"
  | "deviceAvailable"
  | "sideChatAvailable"
>;

type ActivationKey = keyof Pick<
  AddPanelSurfaceActionProps,
  | "onAddBrowser"
  | "onAddTerminal"
  | "onAddDiff"
  | "onAddFiles"
  | "onAddSourceControl"
  | "onAddPullRequest"
  | "onAddPullRequests"
  | "onAddDevice"
  | "onAddSideChat"
>;

interface AddPanelSurfaceDescriptor {
  readonly id: AddPanelSurfaceId;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly shortcut: string;
  readonly availability: AvailabilityKey;
  readonly activation: ActivationKey;
  readonly order: Readonly<Record<AddPanelSurfacePlacement, number>>;
  readonly disabledReason: string;
  readonly unavailableHint: string;
}

/**
 * Canonical policy for every addable right-panel surface. Both launchers and
 * their keyboard handlers consume actions built from this table so ordering,
 * shortcuts, and unavailable copy cannot drift between placements.
 */
const ADD_PANEL_SURFACE_DESCRIPTORS = [
  {
    id: "source-control",
    label: msg("Version Control"),
    icon: GitBranch,
    shortcut: "V",
    availability: "sourceControlAvailable",
    activation: "onAddSourceControl",
    order: { "empty-state": 4, menu: 4 },
    disabledReason: msg(
      "Version Control is only available when a project is open in a Git repository.",
    ),
    unavailableHint: msg("Available for Git repositories."),
  },
  {
    id: "browser",
    label: msg("Browser"),
    icon: Globe2,
    shortcut: "B",
    availability: "browserAvailable",
    activation: "onAddBrowser",
    order: { "empty-state": 0, menu: 0 },
    disabledReason: msg("Browser previews are only available in the T3 Code desktop app."),
    unavailableHint: msg("Only available in the desktop app."),
  },
  {
    id: "terminal",
    label: msg("Terminal"),
    icon: TerminalSquare,
    shortcut: "T",
    availability: "terminalAvailable",
    activation: "onAddTerminal",
    order: { "empty-state": 1, menu: 1 },
    disabledReason: msg("Terminal surfaces are only available from a project thread."),
    unavailableHint: msg("Available when a project is open."),
  },
  {
    id: "files",
    label: msg("Files"),
    icon: Files,
    shortcut: "F",
    availability: "filesAvailable",
    activation: "onAddFiles",
    order: { "empty-state": 2, menu: 2 },
    disabledReason: msg("Files are only available when a project is open."),
    unavailableHint: msg("Available when a project is open."),
  },
  {
    id: "diff",
    label: msg("Diff"),
    icon: FileDiff,
    shortcut: "D",
    availability: "diffAvailable",
    activation: "onAddDiff",
    order: { "empty-state": 3, menu: 3 },
    disabledReason: msg("Diff is only available for server threads in Git repositories."),
    unavailableHint: msg("Available for Git repositories."),
  },
  {
    id: "pull-request",
    label: msg("Pull request"),
    icon: PullRequestGlyph.pullRequest,
    shortcut: "P",
    availability: "pullRequestAvailable",
    activation: "onAddPullRequest",
    order: { "empty-state": 5, menu: 5 },
    disabledReason: msg("This thread's branch has no pull request yet."),
    unavailableHint: msg("No pull request on this branch yet."),
  },
  {
    id: "pull-requests",
    label: msg("Linked items"),
    icon: PullRequestGlyph.link,
    shortcut: "L",
    availability: "pullRequestsAvailable",
    activation: "onAddPullRequests",
    order: { "empty-state": 6, menu: 6 },
    disabledReason: msg("This thread has no linked items."),
    unavailableHint: msg("No linked items available."),
  },
  {
    id: "device",
    label: msg("Device"),
    icon: Smartphone,
    shortcut: "M",
    availability: "deviceAvailable",
    activation: "onAddDevice",
    order: { "empty-state": 7, menu: 7 },
    disabledReason: msg("Devices are only available from a thread."),
    unavailableHint: msg("Available from a thread."),
  },
  {
    id: "side-chat",
    label: msg("Side chat"),
    icon: MessagesSquare,
    shortcut: "S",
    availability: "sideChatAvailable",
    activation: "onAddSideChat",
    order: { "empty-state": 8, menu: 8 },
    disabledReason: msg("Side chats start after the first message."),
    unavailableHint: msg("Available after the first message."),
  },
] as const satisfies readonly AddPanelSurfaceDescriptor[];

export interface AddPanelSurfaceAction {
  readonly id: AddPanelSurfaceId;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly shortcut: string;
  readonly available: boolean;
  readonly disabledReason: string;
  readonly onClick: () => void;
}

export function buildAddSurfaceActions(
  props: AddPanelSurfaceActionProps,
  placement: AddPanelSurfacePlacement = "empty-state",
): readonly AddPanelSurfaceAction[] {
  return ADD_PANEL_SURFACE_DESCRIPTORS.flatMap((descriptor) => {
    const onClick = props[descriptor.activation];
    if (!onClick) return [];
    const disabledReason = descriptor.id === "side-chat" ? props.sideChatDisabledReason : null;
    return [
      {
        id: descriptor.id,
        label: descriptor.label,
        icon: descriptor.icon,
        shortcut: descriptor.shortcut,
        available: props[descriptor.availability] === true && !disabledReason,
        // The empty-state launcher shows the short hint; the add menu tooltip has room for the reason.
        disabledReason:
          disabledReason ??
          (placement === "empty-state" ? descriptor.unavailableHint : descriptor.disabledReason),
        onClick,
        order: descriptor.order[placement],
      },
    ];
  })
    .sort((left, right) => left.order - right.order)
    .map(({ order: _order, ...action }) => action);
}

type SurfaceShortcutEvent = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "defaultPrevented" | "isComposing" | "key" | "metaKey"
> &
  Partial<Pick<KeyboardEvent, "code" | "getModifierState">>;

export function surfaceShortcutActionForKey<
  const Action extends { available: boolean; shortcut: string },
>(actions: readonly Action[], event: SurfaceShortcutEvent): Action | null {
  if (event.defaultPrevented || event.isComposing) return null;
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  const key = surfaceShortcutKey(event);
  return (
    actions.find((action) => action.available && action.shortcut.toLowerCase() === key) ?? null
  );
}
