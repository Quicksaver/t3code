import { useAtomValue } from "@effect/atom-react";
import { MagiPersonalityId, type EnvironmentId, type MagiPersonality } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { PlusIcon, Trash2Icon, UserRoundIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { magiEnvironment } from "~/state/magi";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import { EnvironmentSettingsPanel } from "./EnvironmentSettingsPanel";
import {
  canSaveMagiPersonalities,
  replacePendingMagiSettingsSave,
} from "./magiSettingsSaveScheduling";
import { searchableSetting } from "./settingsSearch";
import { SettingsListDetail, SettingsListDetailRow } from "./SettingsListDetail";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";

const fieldClass =
  "w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring";
const MAGI_ENVIRONMENT_SEARCH_TARGET_IDS = [
  searchableSetting("magi-run-details-diagnostics").id,
  searchableSetting("magi-arbitrator-prompt").id,
  searchableSetting("magi-personalities").id,
] as const;

export function MagiSettingsPanel() {
  return (
    <EnvironmentSettingsPanel
      title="Magi"
      emptyDescription="Connect an execution environment before configuring Magi."
      searchTargetIds={MAGI_ENVIRONMENT_SEARCH_TARGET_IDS}
      renderEnvironment={(props) => (
        <EnvironmentMagiSettings
          environmentId={props.environmentId}
          environmentLabel={props.environmentLabel}
          readOnly={props.readOnly}
          environmentTabs={props.environmentTabs}
        />
      )}
    />
  );
}

export function EnvironmentMagiSettings({
  environmentId,
  environmentLabel,
  environmentTabs,
  readOnly = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly environmentTabs?: ReactNode;
  readonly readOnly?: boolean;
}) {
  const queryAtom = magiEnvironment.settings({ environmentId, input: {} });
  const result = useAtomValue(queryAtom);
  const remote = Option.getOrNull(AsyncResult.value(result));
  const [arbitratorPrompt, setArbitratorPrompt] = useState("");
  const [personalities, setPersonalities] = useState<ReadonlyArray<MagiPersonality>>([]);
  const [showRunDetailsAndDiagnostics, setShowRunDetailsAndDiagnostics] = useState(false);
  const [selectedPersonalityId, setSelectedPersonalityId] = useState<MagiPersonalityId | null>(
    null,
  );
  const [restoreTarget, setRestoreTarget] = useState<
    "arbitrator-prompt" | "included-personalities" | null
  >(null);
  const promptSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const personalitiesSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const update = useAtomCommand(magiEnvironment.updateSettings, { reportFailure: false });
  const reset = useAtomCommand(magiEnvironment.resetSettings, { reportFailure: false });

  useEffect(() => {
    if (!remote) return;
    setArbitratorPrompt(remote.arbitratorPrompt);
    setPersonalities(remote.personalities);
    setShowRunDetailsAndDiagnostics(remote.showRunDetailsAndDiagnostics);
    setSelectedPersonalityId((current) =>
      current && remote.personalities.some((personality) => personality.id === current)
        ? current
        : (remote.personalities[0]?.id ?? null),
    );
  }, [remote]);

  useEffect(
    () => () => {
      if (promptSaveTimerRef.current) clearTimeout(promptSaveTimerRef.current);
      if (personalitiesSaveTimerRef.current) clearTimeout(personalitiesSaveTimerRef.current);
    },
    [],
  );

  const save = async (patch: Parameters<typeof update>[0]["input"]) => {
    const saved = await update({ environmentId, input: patch });
    if (saved._tag === "Success") {
      appAtomRegistry.refresh(queryAtom);
    }
  };
  const updatePendingPromptSave = (prompt: string | null) => {
    promptSaveTimerRef.current = replacePendingMagiSettingsSave({
      current: promptSaveTimerRef.current,
      shouldSchedule: prompt !== null,
      clear: clearTimeout,
      schedule: () =>
        setTimeout(() => {
          promptSaveTimerRef.current = null;
          if (prompt !== null) void save({ arbitratorPrompt: prompt });
        }, 400),
    });
  };
  const updatePendingPersonalitiesSave = (next: ReadonlyArray<MagiPersonality> | null) => {
    personalitiesSaveTimerRef.current = replacePendingMagiSettingsSave({
      current: personalitiesSaveTimerRef.current,
      shouldSchedule: next !== null,
      clear: clearTimeout,
      schedule: () =>
        setTimeout(() => {
          personalitiesSaveTimerRef.current = null;
          if (next !== null) void save({ personalities: next });
        }, 400),
    });
  };
  const updatePersonalities = (next: ReadonlyArray<MagiPersonality>, immediate = false) => {
    setPersonalities(next);
    if (immediate) {
      if (personalitiesSaveTimerRef.current) {
        clearTimeout(personalitiesSaveTimerRef.current);
        personalitiesSaveTimerRef.current = null;
      }
      void save({ personalities: next });
    } else {
      updatePendingPersonalitiesSave(next);
    }
  };
  const updatePersonality = (id: MagiPersonalityId, patch: Partial<MagiPersonality>) => {
    const next = personalities.map((personality) =>
      personality.id === id ? { ...personality, ...patch } : personality,
    );
    setPersonalities(next);
    updatePendingPersonalitiesSave(canSaveMagiPersonalities(next) ? next : null);
  };
  const restore = async (target: "arbitrator-prompt" | "included-personalities") => {
    const saved = await reset({ environmentId, input: { target } });
    if (saved._tag === "Success") {
      setRestoreTarget(null);
      appAtomRegistry.refresh(queryAtom);
    }
  };

  if (!remote) {
    return (
      <SettingsSection title="Magi">
        {environmentTabs}
        <SettingsRow
          title="Loading Magi settings"
          description={`Reading Magi configuration from ${environmentLabel}.`}
        />
      </SettingsSection>
    );
  }

  const selectedPersonality =
    personalities.find((personality) => personality.id === selectedPersonalityId) ??
    personalities[0] ??
    null;

  const createPersonality = () => {
    const baseName = "New participant";
    let name = baseName;
    let suffix = 2;
    while (personalities.some((personality) => personality.name === name)) {
      name = `${baseName} ${suffix++}`;
    }
    const personality: MagiPersonality = {
      id: MagiPersonalityId.make(`custom-${Date.now()}-${personalities.length}`),
      name,
      prompt: "Describe the perspective this participant should apply.",
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
  };

  return (
    <>
      <SettingsSection
        id="magi"
        title="Magi"
        headerAction={
          readOnly ? null : (
            <Button size="compact" variant="outline" onClick={createPersonality}>
              <PlusIcon className="size-3.5" />
              Add participant
            </Button>
          )
        }
      >
        {environmentTabs}
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
                void save({ showRunDetailsAndDiagnostics: next });
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
                updatePendingPromptSave(next.trim() ? next : null);
              }}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          {...searchableSetting("magi-personalities")}
          title="Participants"
          description="Reusable perspectives offered in participant configuration. Changes save automatically."
          resetAction={
            readOnly ? null : (
              <SettingResetButton
                label="included participants"
                onClick={() => setRestoreTarget("included-personalities")}
              />
            )
          }
        />

        <SettingsListDetail
          listLabel="Participant"
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
                    <h3 className="truncate text-sm font-medium tracking-[-0.005em] text-foreground">
                      {selectedPersonality.name}
                    </h3>
                  </div>
                  {!readOnly ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            size="icon-micro"
                            variant="ghost"
                            className="text-muted-foreground hover:text-destructive"
                            onClick={() => deletePersonality(selectedPersonality.id)}
                            aria-label={`Delete ${selectedPersonality.name}`}
                          >
                            <Trash2Icon className="size-3" />
                          </Button>
                        }
                      />
                      <TooltipPopup side="top">Delete participant</TooltipPopup>
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
              <div className="p-6 text-sm text-muted-foreground">No participants configured.</div>
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
                : "Every custom participant and all edits to included participants will be removed."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
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
    </>
  );
}
