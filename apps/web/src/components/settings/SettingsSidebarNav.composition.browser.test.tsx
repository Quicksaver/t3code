import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useLocation,
} from "@tanstack/react-router";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { AppRouteModal } from "../AppRouteModal";
import { Input } from "../ui/input";
import { SidebarProvider } from "../ui/sidebar";
import { SettingsPageContainer, useSettingsSearchTarget } from "./settingsLayout";
import { SettingsSidebarNav } from "./SettingsSidebarNav";
import { settingsNavGroups, SETTINGS_SECTION_LABELS } from "./settingsSearch";

vi.mock("./useAvailableSettingsSearchItems", () => ({
  useAvailableSettingsSearchItems: () => [
    { id: "theme", title: "Theme", to: "/settings/appearance" },
    { id: "archive", title: "Archived threads", to: "/settings/archived" },
  ],
  useHasSecretProvidersEnvironment: () => false,
}));
vi.mock("../chat/GlobalVoiceInputIndicator", () => ({ GlobalVoiceInputIndicator: () => null }));

function createSettingsSearchRouter(initialPath: string, loadGeneral?: () => Promise<void>) {
  function SettingsRoute() {
    const pathname = useLocation({ select: (location) => location.pathname });
    return (
      <AppRouteModal label="Settings">
        <SidebarProvider defaultOpen>
          <SettingsSidebarNav pathname={pathname} />
          <Outlet />
        </SidebarProvider>
      </AppRouteModal>
    );
  }

  function ArchiveSearch() {
    const target = useSettingsSearchTarget<HTMLInputElement>("archive");
    return (
      <Input
        ref={target}
        id="archive"
        nativeInput
        type="search"
        aria-label="Search archived conversations"
      />
    );
  }

  const root = createRootRoute({ component: SettingsRoute });
  return createRouter({
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/settings/general",
        ...(loadGeneral && { loader: loadGeneral }),
      }),
      createRoute({
        getParentRoute: () => root,
        path: "/settings/archived",
        component: () => (
          <SettingsPageContainer>
            <ArchiveSearch />
          </SettingsPageContainer>
        ),
      }),
    ]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
}

it.each(["keyboard", "pointer"])(
  "keeps focus in Archive after %s search selection",
  async (input) => {
    const router = createSettingsSearchRouter("/settings/general");
    await page.viewport(1280, 800);
    // Exercise the real navigation and hash removal with both Settings routes registered.
    await using _screen = await render(<RouterProvider router={router} />, { router: false });
    await expect.element(page.getByRole("dialog", { name: "Settings" })).toHaveFocus();
    await page.getByRole("combobox", { name: "Search settings" }).fill("archive");
    const result = page.getByRole("option", { name: /Archived threads/ });
    await expect.element(result).toBeVisible();
    if (input === "keyboard") {
      await userEvent.keyboard("{Enter}");
    } else {
      await result.click();
    }

    await vi.waitFor(() => expect(router.state.resolvedLocation?.href).toBe("/settings/archived"));
    await expect
      .element(page.getByRole("searchbox", { name: "Search archived conversations" }))
      .toHaveFocus();
  },
);

it("keeps focus in Archive when Back cancels a pending route load", async () => {
  const pendingGeneral = Promise.withResolvers<void>();
  const router = createSettingsSearchRouter("/settings/archived", () => pendingGeneral.promise);
  await page.viewport(1280, 800);
  // Use registered routes so the pending location can differ from the active match.
  await using _screen = await render(<RouterProvider router={router} />, { router: false });
  using _load = { [Symbol.dispose]: () => pendingGeneral.resolve() };
  await expect.element(page.getByRole("dialog", { name: "Settings" })).toHaveFocus();

  void router.navigate({ to: "/settings/general" });
  await expect
    .element(page.getByRole("button", { name: "General" }))
    .toHaveAttribute("aria-current", "page");
  const search = page.getByRole("searchbox", { name: "Search archived conversations" });
  const originalSearch = search.element() as HTMLInputElement;
  originalSearch.focus();
  await expect.element(search).toHaveFocus();
  router.history.back();

  await expect
    .element(page.getByRole("button", { name: "Archive", exact: true }))
    .toHaveAttribute("aria-current", "page");
  expect(search.element()).toBe(originalSearch);
  await expect.element(search).toHaveFocus();
});

it("ignores composing keys in the search", async () => {
  await using screen = await render(
    <SidebarProvider defaultOpen>
      <SettingsSidebarNav pathname="/settings/general" />
    </SidebarProvider>,
    { router: "/settings/general" },
  );
  const search = page.getByRole("combobox", { name: "Search settings" });
  await search.fill("theme");
  await expect.element(page.getByRole("option", { name: /Theme/ })).toBeVisible();

  for (const composition of [
    { key: "Enter", isComposing: true, keyCode: 13 },
    { key: "Enter", isComposing: false, keyCode: 229 },
    { key: "Escape", isComposing: true, keyCode: 27 },
    { key: "Escape", isComposing: false, keyCode: 229 },
    { key: "ArrowDown", isComposing: true, keyCode: 40 },
    { key: "ArrowUp", isComposing: true, keyCode: 38 },
  ]) {
    const event = new KeyboardEvent("keydown", { ...composition, bubbles: true, cancelable: true });
    await act(() => search.element().dispatchEvent(event));
    expect(event.defaultPrevented, JSON.stringify(composition)).toBe(false);
    expect(screen.router?.state.location.pathname).toBe("/settings/general");
    await expect.element(search).toHaveValue("theme");
  }

  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() =>
    expect(screen.router?.state.location.pathname).toBe("/settings/appearance"),
  );
});

it("Esc clears a search of spaces and a held Esc keeps Settings open", async () => {
  await using _screen = await render(
    <AppRouteModal label="Settings">
      <SidebarProvider defaultOpen>
        <SettingsSidebarNav pathname="/settings/general" />
      </SidebarProvider>
    </AppRouteModal>,
    { router: "/settings/general" },
  );
  const settings = page.getByRole("dialog", { name: "Settings" });
  const search = page.getByRole("combobox", { name: "Search settings" });
  await expect.element(settings).toHaveFocus();

  for (const text of ["theme", "   "]) {
    await search.fill(text);
    await userEvent.keyboard("{Escape}");
    await expect.element(search).toHaveValue("");
    await expect.element(search).toHaveFocus();
    await act(() =>
      search.element().dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          repeat: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    await expect.element(settings).toHaveAttribute("data-open");
  }

  await userEvent.keyboard("{Escape}");
  await expect.element(settings).not.toBeInTheDocument();
});

function renderNav() {
  return render(
    <SidebarProvider defaultOpen>
      <SettingsSidebarNav pathname="/settings/general" />
    </SidebarProvider>,
    { router: "/settings/general" },
  );
}

it("opens search from the physical Slash and F keys on non-US layouts", async () => {
  await using _screen = await renderNav();
  const search = page.getByRole("combobox", { name: "Search settings" });

  for (const { init, opens } of [
    { init: { key: "/", code: "Digit7", shiftKey: true }, opens: true }, // German Shift+7
    { init: { key: ".", code: "Slash" }, opens: true }, // Russian Slash key
    { init: { key: "а", code: "KeyF", ctrlKey: true }, opens: true }, // Russian Ctrl+F
    { init: { key: "?", code: "Slash", shiftKey: true }, opens: false },
  ]) {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const event = new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true });
    await act(() => document.body.dispatchEvent(event));
    expect(event.defaultPrevented, JSON.stringify(init)).toBe(opens);
    if (opens) await expect.element(search).toHaveFocus();
  }
});

it("moves Tab through every settings section", async () => {
  await page.viewport(1280, 800);
  await using _screen = await renderNav();
  await userEvent.click(page.getByRole("combobox", { name: "Search settings" }));

  const sections = settingsNavGroups(false)
    .flatMap((group) => group.paths)
    .map((to) => SETTINGS_SECTION_LABELS[to]);
  const tabbed: string[] = [];
  for (let step = 0; step < sections.length; step += 1) {
    await userEvent.tab();
    const section = document.activeElement?.closest("[data-settings-section]");
    if (!section) break;
    tabbed.push(section.textContent ?? "");
  }
  expect(tabbed).toEqual(sections);
});

it.each([1280, 390])("names each group by a heading outside it at %ipx wide", async (width) => {
  await page.viewport(width, 800);
  await using _screen = await renderNav();

  for (const name of ["Agents", "Code", "Connections"]) {
    const heading = page.getByRole("heading", { name, level: 3 });
    await expect.element(heading).toBeInTheDocument();
    const group = page.getByRole("group", { name }).element();
    expect(group.getAttribute("aria-labelledby")).toBe(heading.element().id);
    expect(group.contains(heading.element()), `the ${name} heading is inside its group`).toBe(
      false,
    );
  }
  const groups = page.getByRole("group").elements();
  expect(groups).toHaveLength(settingsNavGroups(false).length);
  for (const group of groups) {
    const first = group.querySelector("[data-settings-section]")?.textContent;
    const heading = document.getElementById(group.getAttribute("aria-labelledby") ?? "");
    expect(heading?.tagName, `the group starting at ${first} has no heading`).toBe("H3");
  }
  expect(page.getByRole("tree").query()).toBeNull();
});
