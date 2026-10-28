import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { AuthSettingsWriteScope, type EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
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
import { toastManager } from "~/components/ui/toast";

import {
  EnvironmentSettingsPanel,
  EnvironmentSettingsPlaceholder,
} from "./EnvironmentSettingsPanel";
import { createMagiSettingsAutosave } from "./magiSettingsSaveScheduling";
import { searchableSetting } from "./settingsSearch";
import { SettingsGroup } from "./SettingsGroup";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";

const fieldClass =
  "w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-inset focus:ring-ring";

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

function EnvironmentMagiSettings({
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
  const [restoreOpen, setRestoreOpen] = useState(false);
  const update = useAtomCommand(magiEnvironment.updateSettings, { reportFailure: false });
  const reset = useAtomCommand(magiEnvironment.resetSettings, { reportFailure: false });

  // The final flush stays bound to the environment this editor was mounted for.
  const [autosave] = useState(() =>
    createMagiSettingsAutosave({
      delayMs: 400,
      schedule: (run, delayMs) => setTimeout(run, delayMs),
      clear: (timer) => clearTimeout(timer),
      save: async (value: string) => {
        const result = await update({
          environmentId,
          input: { arbitratorPrompt: value },
        });
        if (result._tag === "Success") appAtomRegistry.refresh(queryAtom);
        else reportMagiSettingsFailure("Could not save Magi settings", result);
        return result;
      },
      onSettled: (result) => {
        if (result._tag === "Success") setArbitratorPrompt(result.value.arbitratorPrompt);
        else {
          setAppliedRemote(null);
          appAtomRegistry.refresh(queryAtom);
        }
      },
    }),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Flush the environment-bound pending save when this editor unmounts.
  useEffect(() => () => autosave.flush(), [autosave]);

  if (remote !== appliedRemote) {
    setAppliedRemote(remote);
    if (remote && !autosave.isDirty()) setArbitratorPrompt(remote.arbitratorPrompt);
  }

  const restore = async () => {
    autosave.discard();
    const result = await reset({ environmentId, input: {} });
    if (result._tag !== "Success") {
      reportMagiSettingsFailure("Could not restore Magi instructions", result);
      setAppliedRemote(null);
      appAtomRegistry.refresh(queryAtom);
      return;
    }
    setRestoreOpen(false);
    setArbitratorPrompt(result.value.arbitratorPrompt);
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

  return (
    <>
      <SettingsSection id="magi" variant="plain" title="Magi">
        <SettingsGroup>
          {readOnly ? (
            <SettingsRow
              title="Limited permissions"
              description={`This session can view ${environmentLabel}'s Magi settings, but its credential does not allow changing them.`}
            />
          ) : null}
          <SettingsRow
            {...searchableSetting("magi-arbitrator-prompt")}
            title="Arbitrator instructions"
            description="Added to the active conversation when a Magi run starts. Changes save automatically."
            resetAction={
              readOnly ? null : (
                <SettingResetButton
                  label="arbitrator instructions"
                  onClick={() => setRestoreOpen(true)}
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
                  autosave.edit(next.trim() ? next : null);
                }}
              />
            </div>
          </SettingsRow>
        </SettingsGroup>
      </SettingsSection>
      <AlertDialog open={restoreOpen} onOpenChange={setRestoreOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore built-in arbitrator instructions?</AlertDialogTitle>
            <AlertDialogDescription>
              Your arbitrator instructions will be replaced by the bundled default.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button variant="destructive" onClick={() => void restore()}>
              Restore instructions
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
