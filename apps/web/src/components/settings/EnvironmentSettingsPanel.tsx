import { connectionStatusTitle } from "@t3tools/client-runtime/connection";
import { resolveEnvironmentMachineKind, type EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";
import { isElectron } from "../../env";
import { usePrimarySessionState } from "../../environments/primary";
import {
  useEnvironments,
  usePrimaryEnvironmentId,
  type EnvironmentPresentation,
} from "../../state/environments";
import { useEnvironmentSessionState } from "../../state/session";
import {
  ConnectionStatusDot,
  connectionPhaseDotClassName,
  connectionPhasePingClassName,
} from "../ConnectionStatusDot";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import type { WorkspacePageWidth } from "../WorkspacePageContainer";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  buildEnvironmentOptions,
  classifyEnvironmentSettingsAccess,
  isEnvironmentSettingsAvailable,
  type EnvironmentOperateAccess,
  type EnvironmentSettingsAccess,
  resolvePrimaryOperateAccess,
  resolveRemoteOperateAccess,
  resolveSelectedEnvironmentId,
} from "./EnvironmentSettingsPanel.logic";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { ExpandableText } from "./ExpandableText";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useSettingsSearchTargetId,
} from "./settingsLayout";

export interface EnvironmentSettingsContentProps {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly environmentTabs?: ReactNode;
  readonly readOnly: boolean;
}

interface EnvironmentSettingsPanelProps {
  readonly title: string;
  readonly width?: WorkspacePageWidth;
  readonly emptyDescription: string;
  readonly searchTargetIds?: ReadonlyArray<string>;
  readonly targetEnvironmentId?: EnvironmentId;
  readonly targetUnavailableDescription?: string;
  readonly renderEnvironment: (props: EnvironmentSettingsContentProps) => ReactNode;
}

const EMPTY_SEARCH_TARGET_IDS: ReadonlyArray<string> = [];

function environmentDetail(environment: EnvironmentPresentation): string {
  if (environment.entry.target._tag === "PrimaryConnectionTarget") return "Primary device";
  if (environment.relayManaged) return "T3 Connect";
  if (environment.entry.target._tag === "SshConnectionTarget") return "SSH";
  if (isDesktopLocalConnectionTarget(environment.entry.target)) return "Local device";
  return environment.displayUrl ?? "Remote device";
}

function EnvironmentTabs({
  environments,
  selectedEnvironmentId,
  onSelect,
}: {
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly onSelect: (environmentId: EnvironmentId) => void;
}) {
  const onlyPrimaryDevice =
    environments.length === 1 && environments[0]?.entry.target._tag === "PrimaryConnectionTarget";
  if (onlyPrimaryDevice || environments.length === 0) return null;

  return (
    <ScrollArea hideScrollbars scrollFade className="mx-3 h-11 min-w-0 rounded-none sm:mx-4">
      <ToggleGroup
        aria-label="Devices"
        variant="segmented"
        className="my-2"
        value={selectedEnvironmentId ? [selectedEnvironmentId] : []}
        onValueChange={(next) => {
          const environment = environments.find((entry) => entry.environmentId === next[0]);
          if (environment) onSelect(environment.environmentId);
        }}
      >
        {environments.map((environment) => {
          const machine = resolveEnvironmentMachineKind(environment.serverConfig);
          const detail = environmentDetail(environment);
          const statusText = connectionStatusTitle(environment.connection);
          return (
            <Tooltip key={environment.environmentId}>
              <TooltipTrigger
                render={
                  <Toggle value={environment.environmentId} className="gap-2 text-left">
                    <EnvironmentMachineIcon
                      kind={machine}
                      className="size-3.5 shrink-0"
                      aria-hidden
                    />
                    <span className="max-w-40 truncate">{environment.label}</span>
                    {environment.connection.phase !== "connected" ? (
                      <ConnectionStatusDot
                        dotClassName={connectionPhaseDotClassName(environment.connection.phase)}
                        pingClassName={connectionPhasePingClassName(environment.connection.phase)}
                      />
                    ) : null}
                    <span className="sr-only">
                      {detail}, {statusText}
                    </span>
                  </Toggle>
                }
              />
              <TooltipPopup side="top">
                {detail} · {statusText}
              </TooltipPopup>
            </Tooltip>
          );
        })}
      </ToggleGroup>
    </ScrollArea>
  );
}

function UnavailableEnvironmentSettings({
  title,
  environment,
  access,
  environmentTabs,
}: {
  readonly title: string;
  readonly environment: EnvironmentPresentation;
  readonly access: Exclude<EnvironmentSettingsAccess, { kind: "editable" | "read-only" }>;
  readonly environmentTabs?: ReactNode;
}) {
  const isLoading = access.kind === "loading";
  const rowTitle = isLoading
    ? `Loading ${title.toLocaleLowerCase()} settings`
    : access.kind === "error"
      ? "Could not connect to this device"
      : `${title} settings are unavailable`;
  const description = isLoading
    ? access.reason === "permissions"
      ? "Checking what this session is allowed to change."
      : `Waiting for ${environment.label}'s configuration.`
    : connectionStatusTitle(environment.connection);

  return (
    <SettingsSection title={title}>
      {environmentTabs}
      <SettingsRow title={rowTitle} description={description} />
      {!isLoading && environment.connection.error ? (
        <ExpandableText
          key={environment.environmentId}
          text={environment.connection.error}
          className="px-3 text-left font-mono text-xs leading-relaxed text-muted-foreground sm:px-4"
        />
      ) : null}
    </SettingsSection>
  );
}

function AccessGatedEnvironmentSettings({
  title,
  environment,
  operateAccess,
  environmentTabs,
  renderEnvironment,
}: {
  readonly title: string;
  readonly environment: EnvironmentPresentation;
  readonly operateAccess: EnvironmentOperateAccess;
  readonly environmentTabs?: ReactNode;
  readonly renderEnvironment: EnvironmentSettingsPanelProps["renderEnvironment"];
}) {
  const access = classifyEnvironmentSettingsAccess({
    connectionPhase: environment.connection.phase,
    hasServerConfig: environment.serverConfig !== null,
    operateAccess,
  });
  if (access.kind !== "editable" && access.kind !== "read-only") {
    return (
      <UnavailableEnvironmentSettings
        title={title}
        environment={environment}
        access={access}
        environmentTabs={environmentTabs}
      />
    );
  }
  return renderEnvironment({
    environmentId: environment.environmentId,
    environmentLabel: environment.label,
    environmentTabs,
    readOnly: access.kind === "read-only",
  });
}

function PrimaryEnvironmentSettings(
  props: Omit<Parameters<typeof AccessGatedEnvironmentSettings>[0], "operateAccess">,
) {
  const primarySessionState = usePrimarySessionState();
  const operateAccess = resolvePrimaryOperateAccess({
    isPrimary: true,
    hasDesktopBridge: false,
    session: primarySessionState.data,
    isPending: primarySessionState.isPending,
    hasError: primarySessionState.error !== null,
  });
  return <AccessGatedEnvironmentSettings {...props} operateAccess={operateAccess} />;
}

function RemoteEnvironmentSettings(
  props: Omit<Parameters<typeof AccessGatedEnvironmentSettings>[0], "operateAccess">,
) {
  const sessionState = useEnvironmentSessionState(props.environment.environmentId);
  const operateAccess = resolveRemoteOperateAccess({
    session: sessionState.data,
    isPending: sessionState.isPending,
    hasError: sessionState.hasError,
  });
  return <AccessGatedEnvironmentSettings {...props} operateAccess={operateAccess} />;
}

function SelectedEnvironmentSettings(
  props: Omit<Parameters<typeof AccessGatedEnvironmentSettings>[0], "operateAccess">,
) {
  if (props.environment.entry.target._tag !== "PrimaryConnectionTarget") {
    return <RemoteEnvironmentSettings {...props} />;
  }
  if (isElectron) {
    return <AccessGatedEnvironmentSettings {...props} operateAccess="granted" />;
  }
  return <PrimaryEnvironmentSettings {...props} />;
}

export function EnvironmentSettingsPanel({
  title,
  width,
  emptyDescription,
  searchTargetIds = EMPTY_SEARCH_TARGET_IDS,
  targetEnvironmentId,
  targetUnavailableDescription = "Reconnect this device, or select another device.",
  renderEnvironment,
}: EnvironmentSettingsPanelProps) {
  const { environments, isReady } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const searchTargetId = useSettingsSearchTargetId();
  const options = useMemo(
    () => buildEnvironmentOptions(environments, primaryEnvironmentId),
    [environments, primaryEnvironmentId],
  );
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(
    targetEnvironmentId ?? primaryEnvironmentId,
  );
  const targetEnvironmentMissing =
    targetEnvironmentId !== undefined &&
    selectedEnvironmentId === targetEnvironmentId &&
    !options.some((environment) => environment.environmentId === targetEnvironmentId);
  const effectiveEnvironmentId = targetEnvironmentMissing
    ? targetEnvironmentId
    : resolveSelectedEnvironmentId(options, selectedEnvironmentId, primaryEnvironmentId);
  const selectedEnvironment =
    options.find((environment) => environment.environmentId === effectiveEnvironmentId) ?? null;
  const selectedEnvironmentCanRenderSettings =
    selectedEnvironment !== null &&
    isEnvironmentSettingsAvailable({
      connectionPhase: selectedEnvironment.connection.phase,
      hasServerConfig: selectedEnvironment.serverConfig !== null,
    });
  const searchableEnvironmentId = options.find((environment) =>
    isEnvironmentSettingsAvailable({
      connectionPhase: environment.connection.phase,
      hasServerConfig: environment.serverConfig !== null,
    }),
  )?.environmentId;

  useEffect(() => {
    if (
      searchTargetId !== null &&
      searchTargetIds.includes(searchTargetId) &&
      !selectedEnvironmentCanRenderSettings &&
      searchableEnvironmentId !== undefined
    ) {
      setSelectedEnvironmentId(searchableEnvironmentId);
    }
  }, [
    searchTargetId,
    searchTargetIds,
    searchableEnvironmentId,
    selectedEnvironmentCanRenderSettings,
  ]);
  const environmentTabs = (
    <EnvironmentTabs
      environments={options}
      selectedEnvironmentId={effectiveEnvironmentId}
      onSelect={setSelectedEnvironmentId}
    />
  );

  return (
    <SettingsPageContainer className="gap-8" {...(width === undefined ? {} : { width })}>
      {targetEnvironmentMissing ? (
        <SettingsSection title={title}>
          {environmentTabs}
          <SettingsRow title="Device unavailable" description={targetUnavailableDescription} />
        </SettingsSection>
      ) : null}
      {options.length === 0 && !targetEnvironmentMissing ? (
        <SettingsSection title={title}>
          <SettingsRow
            title={isReady ? "No connected devices" : "Loading devices"}
            description={isReady ? emptyDescription : "Reading connected execution environments."}
          />
        </SettingsSection>
      ) : null}

      {selectedEnvironment ? (
        <SelectedEnvironmentSettings
          key={selectedEnvironment.environmentId}
          title={title}
          environment={selectedEnvironment}
          environmentTabs={environmentTabs}
          renderEnvironment={renderEnvironment}
        />
      ) : null}
    </SettingsPageContainer>
  );
}
