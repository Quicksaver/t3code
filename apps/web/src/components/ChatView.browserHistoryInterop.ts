import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";

import { useBrowserHistoryStore } from "../browserHistoryStore";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKey,
  type ProjectGroupingSettings,
} from "../logicalProject";
import { buildPhysicalToLogicalProjectKeyMap } from "../sidebarProjectGrouping";
import type { Project } from "../types";

export function registerChatViewThreadProject(input: {
  threadRef: ScopedThreadRef;
  activeProject: Project;
  projects: ReadonlyArray<Project>;
  settings: ProjectGroupingSettings;
  primaryEnvironmentId: EnvironmentId | null;
}): void {
  const logicalKeyByPhysicalKey = buildPhysicalToLogicalProjectKeyMap({
    projects: input.projects,
    settings: input.settings,
    primaryEnvironmentId: input.primaryEnvironmentId,
  });
  useBrowserHistoryStore
    .getState()
    .registerThreadProject(
      input.threadRef,
      logicalKeyByPhysicalKey.get(derivePhysicalProjectKey(input.activeProject)) ??
        deriveLogicalProjectKeyFromSettings(input.activeProject, input.settings),
    );
}
