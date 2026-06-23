export function resolveThreadSidebarOpen(input: {
  readonly isDesktopHost: boolean;
  readonly savedThreadSidebarOpen: boolean | undefined;
}): boolean {
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
  if (input.isDesktopHost) {
    return false;
  }

  return input.currentOpen !== input.nextOpen;
}
