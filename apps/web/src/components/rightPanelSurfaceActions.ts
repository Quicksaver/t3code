import { PullRequestGlyph } from "./pullRequest/pullRequestIcons";
import {
  FileDiff,
  Files,
  GitBranch,
  Smartphone,
  Globe2,
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
  | "device";

export type AddPanelSurfacePlacement = "empty-state" | "menu";

export interface AddPanelSurfaceActionProps {
  readonly onAddBrowser: () => void;
  readonly onAddTerminal: () => void;
  readonly onAddDiff: () => void;
  readonly onAddFiles: () => void;
  readonly onAddSourceControl: () => void;
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
export const ADD_PANEL_SURFACE_DESCRIPTORS = [
  {
    id: "source-control",
    label: "Version Control",
    icon: GitBranch,
    shortcut: "V",
    availability: "sourceControlAvailable",
    activation: "onAddSourceControl",
    order: { "empty-state": 4, menu: 4 },
    disabledReason: "Version Control is only available when a project is open in a Git repository.",
    unavailableHint: "Available for Git repositories.",
  },
  {
    id: "browser",
    label: "Browser",
    icon: Globe2,
    shortcut: "B",
    availability: "browserAvailable",
    activation: "onAddBrowser",
    order: { "empty-state": 0, menu: 0 },
    disabledReason: "Browser previews are only available in the T3 Code desktop app.",
    unavailableHint: "Only available in the desktop app.",
  },
  {
    id: "terminal",
    label: "Terminal",
    icon: TerminalSquare,
    shortcut: "T",
    availability: "terminalAvailable",
    activation: "onAddTerminal",
    order: { "empty-state": 1, menu: 1 },
    disabledReason: "Terminal surfaces are only available from a project thread.",
    unavailableHint: "Available when a project is open.",
  },
  {
    id: "files",
    label: "Files",
    icon: Files,
    shortcut: "F",
    availability: "filesAvailable",
    activation: "onAddFiles",
    order: { "empty-state": 2, menu: 2 },
    disabledReason: "Files are only available when a project is open.",
    unavailableHint: "Available when a project is open.",
  },
  {
    id: "diff",
    label: "Diff",
    icon: FileDiff,
    shortcut: "D",
    availability: "diffAvailable",
    activation: "onAddDiff",
    order: { "empty-state": 3, menu: 3 },
    disabledReason: "Diff is only available for server threads in Git repositories.",
    unavailableHint: "Available for Git repositories.",
  },
  {
    id: "pull-request",
    label: "Pull request",
    icon: PullRequestGlyph.pullRequest,
    shortcut: "P",
    availability: "pullRequestAvailable",
    activation: "onAddPullRequest",
    order: { "empty-state": 5, menu: 5 },
    disabledReason: "This thread's branch has no pull request yet.",
    unavailableHint: "No pull request on this branch yet.",
  },
  {
    id: "pull-requests",
    label: "Linked pull requests",
    icon: PullRequestGlyph.link,
    shortcut: "L",
    availability: "pullRequestsAvailable",
    activation: "onAddPullRequests",
    order: { "empty-state": 6, menu: 6 },
    disabledReason: "No linked pull requests are available for this thread.",
    unavailableHint: "No linked pull requests available.",
  },
  {
    id: "device",
    label: "Device",
    icon: Smartphone,
    shortcut: "M",
    availability: "deviceAvailable",
    activation: "onAddDevice",
    order: { "empty-state": 7, menu: 7 },
    disabledReason: "Devices are only available from a thread.",
    unavailableHint: "Available from a thread.",
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
  return ADD_PANEL_SURFACE_DESCRIPTORS.map((descriptor) => ({
    id: descriptor.id,
    label: descriptor.label,
    icon: descriptor.icon,
    shortcut: descriptor.shortcut,
    available: props[descriptor.availability],
    // The empty-state launcher shows the short hint; the add menu tooltip has room for the reason.
    disabledReason:
      placement === "empty-state" ? descriptor.unavailableHint : descriptor.disabledReason,
    onClick: props[descriptor.activation],
    order: descriptor.order[placement],
  }))
    .sort((left, right) => left.order - right.order)
    .map(({ order: _order, ...action }) => action);
}

type SurfaceShortcutEvent = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "defaultPrevented" | "isComposing" | "key" | "metaKey"
>;

export function surfaceShortcutActionForKey<
  const Action extends { available: boolean; shortcut: string },
>(actions: readonly Action[], event: SurfaceShortcutEvent): Action | null {
  if (event.defaultPrevented || event.isComposing) return null;
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  return (
    actions.find(
      (action) => action.available && action.shortcut.toLowerCase() === event.key.toLowerCase(),
    ) ?? null
  );
}
