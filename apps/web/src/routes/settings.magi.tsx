import { createFileRoute } from "@tanstack/react-router";

import { MagiSettingsPanel } from "../components/settings/MagiSettingsPanel";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";

function SettingsMagiRoute() {
  const { environment, scope } = useSettingsScope();
  if (!environment) {
    return (
      <p className="p-8 text-sm text-muted-foreground">
        {scope.kind === "environment"
          ? `Reconnect ${scope.label} to configure Magi.`
          : "Connect an environment to configure Magi."}
      </p>
    );
  }
  return <MagiSettingsPanel environmentId={environment.environmentId} />;
}

export const Route = createFileRoute("/settings/magi")({
  component: SettingsMagiRoute,
});
