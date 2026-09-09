import { createFileRoute } from "@tanstack/react-router";

import { MagiSettingsPanel } from "../components/settings/MagiSettingsPanel";

export const Route = createFileRoute("/settings/magi")({
  component: MagiSettingsPanel,
});
