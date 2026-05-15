interface LocationSnapshot {
  readonly href: string;
  readonly pathname: string;
}

let lastNonSettingsHref = "/";

export function rememberSettingsBackTarget(location: LocationSnapshot): void {
  if (location.pathname.startsWith("/settings")) {
    return;
  }
  lastNonSettingsHref = location.href || location.pathname || "/";
}

export function getSettingsBackTargetHref(): string {
  return lastNonSettingsHref;
}

export function navigateToSettingsBackTarget(history: { push: (href: string) => void }): void {
  history.push(lastNonSettingsHref);
}

export function resetSettingsBackTargetForTests(): void {
  lastNonSettingsHref = "/";
}
