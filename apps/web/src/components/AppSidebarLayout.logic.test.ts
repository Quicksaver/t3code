import { describe, expect, it } from "vite-plus/test";

import {
  resolveThreadSidebarOpen,
  shouldPersistThreadSidebarOpenChange,
} from "./AppSidebarLayout.logic";

describe("resolveThreadSidebarOpen", () => {
  it("defaults the thread sidebar to open", () => {
    expect(
      resolveThreadSidebarOpen({ isDesktopHost: false, savedThreadSidebarOpen: undefined }),
    ).toBe(true);
  });

  it("honors a persisted closed preference", () => {
    expect(resolveThreadSidebarOpen({ isDesktopHost: false, savedThreadSidebarOpen: false })).toBe(
      false,
    );
  });

  it("honors a persisted open preference", () => {
    expect(resolveThreadSidebarOpen({ isDesktopHost: false, savedThreadSidebarOpen: true })).toBe(
      true,
    );
  });

  it("keeps the desktop host sidebar fixed open", () => {
    expect(resolveThreadSidebarOpen({ isDesktopHost: true, savedThreadSidebarOpen: false })).toBe(
      true,
    );
  });
});

describe("shouldPersistThreadSidebarOpenChange", () => {
  it("persists when the sidebar state changes", () => {
    expect(
      shouldPersistThreadSidebarOpenChange({
        currentOpen: true,
        isDesktopHost: false,
        nextOpen: false,
      }),
    ).toBe(true);
  });

  it("persists when the sidebar reopens", () => {
    expect(
      shouldPersistThreadSidebarOpenChange({
        currentOpen: false,
        isDesktopHost: false,
        nextOpen: true,
      }),
    ).toBe(true);
  });

  it("skips redundant writes when the sidebar state is unchanged", () => {
    expect(
      shouldPersistThreadSidebarOpenChange({
        currentOpen: false,
        isDesktopHost: false,
        nextOpen: false,
      }),
    ).toBe(false);
  });

  it("does not persist any desktop host toggle attempts", () => {
    expect(
      shouldPersistThreadSidebarOpenChange({
        currentOpen: true,
        isDesktopHost: true,
        nextOpen: false,
      }),
    ).toBe(false);
    expect(
      shouldPersistThreadSidebarOpenChange({
        currentOpen: false,
        isDesktopHost: true,
        nextOpen: true,
      }),
    ).toBe(false);
  });
});
