export function resolveThreadSidebarOpen(input: {
  readonly isDesktopHost: boolean;
  readonly savedThreadSidebarOpen: boolean | undefined;
}): boolean {
  // Electron forces the desktop sidebar open; other hosts default to open until
  // a persisted preference exists.
  if (input.isDesktopHost) {
    return true;
  }

  return input.savedThreadSidebarOpen ?? true;
}

export function shouldPersistThreadSidebarOpenChange(input: {
  readonly currentOpen: boolean;
  readonly isDesktopHost: boolean;
  readonly nextOpen: boolean;
}): boolean {
  // Desktop sidebar state is controlled by the host layout, not client settings.
  if (input.isDesktopHost) {
    return false;
  }

  return input.currentOpen !== input.nextOpen;
}
