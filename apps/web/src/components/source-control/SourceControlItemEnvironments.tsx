import type { EnvironmentId, EnvironmentMachineKind } from "@t3tools/contracts";

import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";

export interface SourceControlItemEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly machine: EnvironmentMachineKind;
  readonly active: boolean;
}

function presentElsewhere(environments: readonly SourceControlItemEnvironment[]): boolean {
  return environments.some((environment) => !environment.active);
}

/** Marks an item held by environments other than the current thread's, like sidebar threads. */
export function SourceControlItemEnvironmentIcons({
  environments,
}: {
  readonly environments: readonly SourceControlItemEnvironment[];
}) {
  if (!presentElsewhere(environments)) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-sidebar-muted-foreground/70">
      {environments
        .filter((environment) => !environment.active)
        .map((environment) => (
          <EnvironmentMachineIcon
            key={environment.environmentId}
            aria-label={environment.label}
            kind={environment.machine}
            className="size-3.5"
          />
        ))}
    </span>
  );
}

export function SourceControlItemEnvironmentRows({
  environments,
}: {
  readonly environments: readonly SourceControlItemEnvironment[];
}) {
  if (!presentElsewhere(environments)) return null;
  return (
    <div className="grid gap-1">
      {environments.map((environment) => (
        <div key={environment.environmentId} className="flex min-w-0 items-center gap-2">
          <EnvironmentMachineIcon
            aria-hidden
            kind={environment.machine}
            className="size-3 shrink-0 stroke-muted-foreground"
          />
          <span className="min-w-0 truncate text-foreground/75">{environment.label}</span>
        </div>
      ))}
    </div>
  );
}
