import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { projectActionThreadId } from "@t3tools/client-runtime/project-actions";
import { AuthTerminalOperateScope, type ScopedThreadRef } from "@t3tools/contracts";

import { focusDetachedPanel } from "../detachedPanels/detachedPanelActions";
import { isDetachedPanelsSupported, isSurfaceDetached } from "../detachedPanels/detachedPanelStore";
import {
  rightPanelHostRef,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../rightPanelStore";
import { readProject } from "../state/entities";
import { readEnvironmentScope } from "../state/session";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { focusTerminal, type TerminalFocusOwner } from "./terminalFocus";

export function cycleThreadTerminal(
  threadRef: ScopedThreadRef,
  owner: TerminalFocusOwner,
  direction: "previous" | "next",
  detachedSurfaceId?: string,
): boolean {
  const offset = direction === "next" ? 1 : -1;
  if (owner === "drawer") {
    const drawer = useTerminalUiStateStore.getState();
    const state = selectThreadTerminalUiState(drawer.terminalUiStateByThreadKey, threadRef);
    if (!state.terminalOpen) return false;
    const terminalOrder = new Map(state.terminalIds.map((id, index) => [id, index]));
    const groupRank = (ids: readonly string[]) =>
      Math.min(...ids.map((id) => terminalOrder.get(id) ?? Number.POSITIVE_INFINITY));
    const terminalIds = state.terminalGroups
      .toSorted((left, right) => groupRank(left.terminalIds) - groupRank(right.terminalIds))
      .flatMap((group) => group.terminalIds);
    const index = terminalIds.indexOf(state.activeTerminalId);
    if (index === -1) return false;
    const terminalId = terminalIds[(index + offset + terminalIds.length) % terminalIds.length];
    if (terminalId === undefined) return false;
    drawer.setActiveTerminal(threadRef, terminalId);
    focusTerminal(threadRef, terminalId);
    return true;
  }

  const panels = useRightPanelStore.getState();
  const panelRef = rightPanelHostRef(threadRef);
  const panel = selectThreadRightPanelState(panels.byThreadKey, panelRef);
  const sourceSurfaceId = detachedSurfaceId ?? panel.activeSurfaceId;
  if (!panel.isOpen && detachedSurfaceId === undefined) return false;
  const terminals = panel.surfaces.flatMap((surface) => {
    if (surface.kind !== "terminal") return [];
    const target = surface.actionTarget;
    const available =
      readEnvironmentScope(
        target?.environmentId ?? panelRef.environmentId,
        AuthTerminalOperateScope,
      ) &&
      (!target || readProject(scopeProjectRef(target.environmentId, target.projectId)) !== null);
    const terminalIds = available
      ? surface.terminalIds
      : surface.id === sourceSurfaceId
        ? [surface.activeTerminalId]
        : [];
    return terminalIds.map((terminalId) => ({ surface, terminalId, available }));
  });
  const index = terminals.findIndex(
    ({ surface, terminalId }) =>
      surface.id === sourceSurfaceId && terminalId === surface.activeTerminalId,
  );
  if (index === -1) return false;
  const target = terminals[(index + offset + terminals.length) % terminals.length];
  if (!target?.available) return false;
  const surfaceId = target.surface.id;
  const targetDetached = isDetachedPanelsSupported() && isSurfaceDetached(panelRef, surfaceId);
  panels.activateTerminal(panelRef, surfaceId, target.terminalId, {
    selectSurface: detachedSurfaceId === undefined || !targetDetached,
  });
  if (!targetDetached) panels.activateSurface(panelRef, surfaceId);
  if (surfaceId !== sourceSurfaceId) {
    if (targetDetached) focusDetachedPanel(panelRef, surfaceId);
    else if (detachedSurfaceId !== undefined) {
      void window.desktopBridge?.revealWindow().catch(() => undefined);
    }
  }
  const destination = target.surface.actionTarget;
  const targetRef = destination
    ? { environmentId: destination.environmentId, threadId: projectActionThreadId(destination) }
    : panelRef;
  focusTerminal(targetRef, target.terminalId);
  return true;
}
