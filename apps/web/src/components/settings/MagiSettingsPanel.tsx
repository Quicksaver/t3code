import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthSettingsWriteScope,
  MagiPersonalityId,
  type EnvironmentId,
  type MagiPersonality,
  type MagiSettings,
  type MagiSettingsPatch,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { PlusIcon, Trash2Icon, UserRoundIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useServerConfigs } from "~/state/entities";
import { magiEnvironment } from "~/state/magi";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import {
  EnvironmentSettingsPanel,
  EnvironmentSettingsPlaceholder,
} from "./EnvironmentSettingsPanel";
import { canSaveMagiPersonalities, createMagiSettingsAutosave } from "./magiSettingsSaveScheduling";
import { searchableSetting } from "./settingsSearch";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsListDetail, SettingsListDetailRow } from "./SettingsListDetail";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";

const fieldClass =
  "w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring";

function reportMagiSettingsFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : "The Magi settings update failed.",
  });
}

export function MagiSettingsPanel({ environmentId }: { readonly environmentId: EnvironmentId }) {
  return (
    <EnvironmentSettingsPanel
      title="Magi"
      requiredScope={AuthSettingsWriteScope}
      scoped
      targetEnvironmentId={environmentId}
      emptyDescription="Connect an execution environment before configuring Magi."
      renderEnvironment={(props) => (
        <MagiCapableEnvironmentSettings
          environmentId={props.environmentId}
          environmentLabel={props.environmentLabel}
          readOnly={props.readOnly}
        />
      )}
    />
  );
}

/** Mounts the Magi settings consumer only for environments whose server supports Magi. */
function MagiCapableEnvironmentSettings(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly readOnly: boolean;
}) {
  const serverConfig = useServerConfigs().get(props.environmentId);
  if (!serverConfig) {
    return (
      <EnvironmentSettingsPlaceholder
        sectionTitle="Magi"
        title="Loading Magi settings"
        description={`Waiting for ${props.environmentLabel}'s configuration.`}
      />
    );
  }
  if (serverConfig.environment.capabilities.magi !== true) {
    return (
      <EnvironmentSettingsPlaceholder
        sectionTitle="Magi"
        title="Magi is not available on this device"
        description={`Update the T3 Code server on ${props.environmentLabel} to configure Magi.`}
      />
    );
  }
  return <EnvironmentMagiSettings {...props} />;
}

export function EnvironmentMagiSettings({
  environmentId,
  environmentLabel,
  readOnly = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly readOnly?: boolean;
}) {
  const queryAtom = magiEnvironment.settings({ environmentId, input: {} });
  const result = useAtomValue(queryAtom);
  const remote = Option.getOrNull(AsyncResult.value(result));
  const [appliedRemote, setAppliedRemote] = useState(remote);
  const [arbitratorPrompt, setArbitratorPrompt] = useState(remote?.arbitratorPrompt ?? "");
  const [personalities, setPersonalities] = useState<ReadonlyArray<MagiPersonality>>(
    remote?.personalities ?? [],
  );
  const [showRunDetailsAndDiagnostics, setShowRunDetailsAndDiagnostics] = useState(
    remote?.showRunDetailsAndDiagnostics ?? false,
  );
  const [selectedPersonalityId, setSelectedPersonalityId] = useState<MagiPersonalityId | null>(
    null,
  );
  const [restoreTarget, setRestoreTarget] = useState<
    "arbitrator-prompt" | "included-personalities" | null
  >(null);
  const [deleteTarget, setDeleteTarget] = useState<MagiPersonality | null>(null);
  const update = useAtomCommand(magiEnvironment.updateSettings, { reportFailure: false });
  const reset = useAtomCommand(magiEnvironment.resetSettings, { reportFailure: false });

  // Saves stay bound to the environment this editor was mounted for, including the
  // final flush on unmount. Failures reapply the current server snapshot.
  const [autosave] = useState(() => {
    const resyncFromServer = () => {
      setAppliedRemote(null);
      appAtomRegistry.refresh(queryAtom);
    };
    const field = <TValue,>(
      toPatch: (value: TValue) => MagiSettingsPatch,
      applySaved: (settings: MagiSettings) => void,
    ) =>
      createMagiSettingsAutosave({
        delayMs: 400,
        schedule: (run, delayMs) => setTimeout(run, delayMs),
        clear: clearTimeout,
        save: async (value: TValue) => {
          const result = await update({ environmentId, input: toPatch(value) });
          if (result._tag === "Success") appAtomRegistry.refresh(queryAtom);
          else reportMagiSettingsFailure("Could not save Magi settings", result);
          return result;
        },
        onSettled: (result) => {
          if (result._tag === "Success") applySaved(result.value);
          else resyncFromServer();
        },
      });
    return {
      resyncFromServer,
      arbitratorPrompt: field(
        (value: string) => ({ arbitratorPrompt: value }),
        (settings) => setArbitratorPrompt(settings.arbitratorPrompt),
      ),
      personalities: field(
        (value: ReadonlyArray<MagiPersonality>) => ({ personalities: value }),
        (settings) => setPersonalities(settings.personalities),
      ),
      showRunDetailsAndDiagnostics: field(
        (value: boolean) => ({ showRunDetailsAndDiagnostics: value }),
        (settings) => setShowRunDetailsAndDiagnostics(settings.showRunDetailsAndDiagnostics),
      ),
    };
  });

  useEffect(
    () => () => {
      autosave.arbitratorPrompt.flush();
      autosave.personalities.flush();
    },
    [autosave],
  );

  // A snapshot only replaces fields without unacknowledged local edits.
  if (remote !== appliedRemote) {
    setAppliedRemote(remote);
    if (remote) {
      if (!autosave.arbitratorPrompt.isDirty()) setArbitratorPrompt(remote.arbitratorPrompt);
      if (!autosave.personalities.isDirty()) setPersonalities(remote.personalities);
      if (!autosave.showRunDetailsAndDiagnostics.isDirty()) {
        setShowRunDetailsAndDiagnostics(remote.showRunDetailsAndDiagnostics);
      }
      setSelectedPersonalityId((current) =>
        current && remote.personalities.some((personality) => personality.id === current)
          ? current
          : (remote.personalities[0]?.id ?? null),
      );
    }
  }

  const updatePersonalities = (next: ReadonlyArray<MagiPersonality>, immediate = false) => {
    setPersonalities(next);
    autosave.personalities.edit(canSaveMagiPersonalities(next) ? next : null, { immediate });
  };
  const updatePersonality = (id: MagiPersonalityId, patch: Partial<MagiPersonality>) => {
    updatePersonalities(
      personalities.map((personality) =>
        personality.id === id ? { ...personality, ...patch } : personality,
      ),
    );
  };
  const restore = async (target: "arbitrator-prompt" | "included-personalities") => {
    // Drop the edit being restored so an older scheduled save cannot land after the reset.
    const field =
      target === "arbitrator-prompt" ? autosave.arbitratorPrompt : autosave.personalities;
    field.discard();
    const result = await reset({ environmentId, input: { target } });
    if (result._tag !== "Success") {
      reportMagiSettingsFailure("Could not restore Magi defaults", result);
      autosave.resyncFromServer();
      return;
    }
    setRestoreTarget(null);
    if (target === "arbitrator-prompt") setArbitratorPrompt(result.value.arbitratorPrompt);
    else setPersonalities(result.value.personalities);
    appAtomRegistry.refresh(queryAtom);
  };

  if (!remote) {
    return AsyncResult.isFailure(result) ? (
      <EnvironmentSettingsPlaceholder
        sectionTitle="Magi"
        title="Could not load Magi settings"
        description={`Magi configuration could not be read from ${environmentLabel}.`}
      >
        <Button size="compact" variant="outline" onClick={() => appAtomRegistry.refresh(queryAtom)}>
          Retry
        </Button>
      </EnvironmentSettingsPlaceholder>
    ) : (
      <EnvironmentSettingsPlaceholder
        sectionTitle="Magi"
        title="Loading Magi settings"
        description={`Reading Magi configuration from ${environmentLabel}.`}
      />
    );
  }

  const selectedPersonality =
    personalities.find((personality) => personality.id === selectedPersonalityId) ??
    personalities[0] ??
    null;

  const createPersonality = () => {
    const baseName = "New personality";
    let name = baseName;
    let suffix = 2;
    while (personalities.some((personality) => personality.name === name)) {
      name = `${baseName} ${suffix++}`;
    }
    const personality: MagiPersonality = {
      id: MagiPersonalityId.make(`custom-${Date.now()}-${personalities.length}`),
      name,
      prompt: "Describe the perspective this personality should apply.",
      included: true,
    };
    updatePersonalities([...personalities, personality], true);
    setSelectedPersonalityId(personality.id);
  };

  const deletePersonality = (id: MagiPersonalityId) => {
    updatePersonalities(
      personalities.filter((personality) => personality.id !== id),
      true,
    );
    setSelectedPersonalityId(null);
    setDeleteTarget(null);
  };
  const deleteTargetInRememberedPanel =
    deleteTarget !== null &&
    remote.lastPanelRoster.some((participant) => participant.personalityId === deleteTarget.id);

  return (
    <>
      <SettingsSection
        id="magi"
        variant="plain"
        title="Magi"
        headerAction={
          readOnly ? null : (
            <Button size="compact" variant="outline" onClick={createPersonality}>
              <PlusIcon className="size-3.5" />
              Add personality
            </Button>
          )
        }
      >
        <SettingsGroup>
          {readOnly ? (
            <SettingsRow
              title="Limited permissions"
              description={`This session can view ${environmentLabel}'s Magi settings, but its credential does not allow changing them.`}
            />
          ) : null}

          <SettingsRow
            {...searchableSetting("magi-run-details-diagnostics")}
            title="Show details and diagnostics for Magi runs"
            description="Loads participant transcripts, proposal records, and turn evidence when a run is opened. Disabled by default to reduce WebSocket traffic."
            control={
              <Switch
                checked={showRunDetailsAndDiagnostics}
                disabled={readOnly}
                aria-label="Show details and diagnostics for Magi runs"
                onCheckedChange={(checked) => {
                  const next = Boolean(checked);
                  setShowRunDetailsAndDiagnostics(next);
                  autosave.showRunDetailsAndDiagnostics.edit(next, { immediate: true });
                }}
              />
            }
          />

          <SettingsRow
            {...searchableSetting("magi-arbitrator-prompt")}
            title="Arbitrator instructions"
            description="Added to the active conversation when a Magi run starts. Changes save automatically."
            resetAction={
              readOnly ? null : (
                <SettingResetButton
                  label="arbitrator instructions"
                  onClick={() => setRestoreTarget("arbitrator-prompt")}
                />
              )
            }
          >
            <div className="pt-3">
              <textarea
                aria-label="Arbitrator instructions"
                readOnly={readOnly}
                className={`${fieldClass} min-h-48 resize-y leading-relaxed ${readOnly ? "opacity-50" : ""}`}
                value={arbitratorPrompt}
                onChange={(event) => {
                  const next = event.target.value;
                  setArbitratorPrompt(next);
                  autosave.arbitratorPrompt.edit(next.trim() ? next : null);
                }}
              />
            </div>
          </SettingsRow>

          <SettingsRow
            {...searchableSetting("magi-personalities")}
            title="Personalities"
            description="Reusable perspectives offered in participant configuration. Changes save automatically."
            resetAction={
              readOnly ? null : (
                <SettingResetButton
                  label="included personalities"
                  onClick={() => setRestoreTarget("included-personalities")}
                />
              )
            }
          />
        </SettingsGroup>
        <SettingsListDetail
          listLabel="Personality"
          controlLabel="On"
          items={personalities.map((personality) => (
            <div key={personality.id} className="p-1">
              <SettingsListDetailRow
                selected={selectedPersonality?.id === personality.id}
                inactive={!personality.included}
                onSelect={() => setSelectedPersonalityId(personality.id)}
                leading={
                  <UserRoundIcon className="size-5 shrink-0 text-foreground/80" aria-hidden />
                }
                title={personality.name}
                description={
                  personality.included ? "Included in new runs" : "Excluded from new runs"
                }
                descriptionIndicator={
                  <span
                    className={`size-1.5 shrink-0 rounded-full ${
                      personality.included ? "bg-success" : "bg-muted-foreground/50"
                    }`}
                  />
                }
                control={
                  <Switch
                    checked={personality.included}
                    disabled={readOnly}
                    aria-label={`Enable ${personality.name}`}
                    onCheckedChange={(checked) =>
                      updatePersonalities(
                        personalities.map((item) =>
                          item.id === personality.id
                            ? { ...item, included: Boolean(checked) }
                            : item,
                        ),
                        true,
                      )
                    }
                  />
                }
              />
            </div>
          ))}
          detail={
            selectedPersonality ? (
              <div className="min-w-0">
                <div
                  inert={readOnly}
                  aria-disabled={readOnly || undefined}
                  className={`flex min-h-16 items-center justify-between gap-3 border-b border-border/70 px-4 py-3 ${
                    readOnly ? "opacity-50 select-none" : ""
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <UserRoundIcon className="size-5 shrink-0 text-foreground/80" aria-hidden />
                    <h3 className="truncate text-sm font-medium text-foreground">
                      {selectedPersonality.name}
                    </h3>
                  </div>
                  {!readOnly ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            size="icon-micro"
                            variant="ghost-destructive"
                            onClick={() => setDeleteTarget(selectedPersonality)}
                            aria-label={`Delete ${selectedPersonality.name}`}
                          >
                            <Trash2Icon className="size-3" />
                          </Button>
                        }
                      />
                      <TooltipPopup side="top">Delete personality</TooltipPopup>
                    </Tooltip>
                  ) : null}
                </div>
                <div
                  inert={readOnly}
                  aria-disabled={readOnly || undefined}
                  className={`space-y-5 px-4 py-5 ${readOnly ? "opacity-50 select-none" : ""}`}
                >
                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium">Name</span>
                    <Input
                      value={selectedPersonality.name}
                      onChange={(event) =>
                        updatePersonality(selectedPersonality.id, { name: event.target.value })
                      }
                    />
                  </label>
                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium">Instructions</span>
                    <textarea
                      aria-label={`${selectedPersonality.name} instructions`}
                      className={`${fieldClass} min-h-48 resize-y leading-relaxed`}
                      value={selectedPersonality.prompt}
                      onChange={(event) =>
                        updatePersonality(selectedPersonality.id, { prompt: event.target.value })
                      }
                    />
                  </label>
                </div>
              </div>
            ) : (
              <div className="p-6 text-sm text-muted-foreground">No personalities configured.</div>
            )
          }
        />
      </SettingsSection>

      <AlertDialog
        open={restoreTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRestoreTarget(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore built-in Magi defaults?</AlertDialogTitle>
            <AlertDialogDescription>
              {restoreTarget === "arbitrator-prompt"
                ? "Your arbitrator instructions will be replaced by the bundled default."
                : "Every custom personality and all edits to included personalities will be removed."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              disabled={restoreTarget === null}
              onClick={() => {
                if (restoreTarget) void restore(restoreTarget);
              }}
            >
              Restore defaults
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteTarget?.name ?? "personality"}?</AlertDialogTitle>
            <AlertDialogDescription>
              New runs can no longer use this personality. Runs that already started keep their
              snapshot.
              {deleteTargetInRememberedPanel
                ? " The remembered Magi panel configuration uses it; choose another personality or No personality for that seat before the next run."
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              disabled={deleteTarget === null}
              onClick={() => {
                if (deleteTarget) deletePersonality(deleteTarget.id);
              }}
            >
              Delete personality
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
