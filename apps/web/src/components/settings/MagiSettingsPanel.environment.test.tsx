import type { ReactElement } from "react";
import {
  DEFAULT_MAGI_SETTINGS,
  EnvironmentId,
  MagiPersonalityId,
  type MagiSettings,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const atoms = vi.hoisted(() => ({
  settingsAtom: Symbol("magi-settings"),
  updateSettings: Symbol("magi-update-settings"),
  resetSettings: Symbol("magi-reset-settings"),
  settings: null as MagiSettings | null,
  environmentIds: [] as EnvironmentId[],
}));

const commands = vi.hoisted(() => ({
  update: vi.fn(),
  reset: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useEffect: (effect: () => void | (() => void)) => {
      effect();
    },
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () =>
    atoms.settings === null ? AsyncResult.initial() : AsyncResult.success(atoms.settings),
}));

vi.mock("../../state/magi", () => ({
  magiEnvironment: {
    settings: ({ environmentId }: { environmentId: EnvironmentId }) => {
      atoms.environmentIds.push(environmentId);
      return atoms.settingsAtom;
    },
    updateSettings: atoms.updateSettings,
    resetSettings: atoms.resetSettings,
  },
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (atom: symbol) =>
    atom === atoms.updateSettings ? commands.update : commands.reset,
}));

vi.mock("../../rpc/atomRegistry", () => ({
  appAtomRegistry: { refresh: commands.refresh },
}));

import { EnvironmentMagiSettings } from "./MagiSettingsPanel";
import { SettingsListDetail, SettingsListDetailRow } from "./SettingsListDetail";

const remoteEnvironmentId = EnvironmentId.make("remote-device");
const firstPersonalityId = MagiPersonalityId.make("skeptic");
const secondPersonalityId = MagiPersonalityId.make("builder");

function renderPanel(readOnly = false): ReactElement<Record<string, unknown>> {
  hooks.beginRender();
  return EnvironmentMagiSettings({
    environmentId: remoteEnvironmentId,
    environmentLabel: "Remote device",
    readOnly,
  }) as ReactElement<Record<string, unknown>>;
}

function renderLoadedPanel(readOnly = false): ReactElement<Record<string, unknown>> {
  renderPanel(readOnly);
  return renderPanel(readOnly);
}

describe("EnvironmentMagiSettings routing", () => {
  beforeEach(() => {
    hooks.reset();
    atoms.environmentIds = [];
    atoms.settings = {
      ...DEFAULT_MAGI_SETTINGS,
      personalities: [
        {
          id: firstPersonalityId,
          name: "Skeptic",
          prompt: "Challenge the assumptions.",
          included: true,
        },
        {
          id: secondPersonalityId,
          name: "Builder",
          prompt: "Find the smallest useful implementation.",
          included: false,
        },
      ],
    };
    commands.update.mockReset().mockResolvedValue({ _tag: "Success" });
    commands.reset.mockReset().mockResolvedValue({ _tag: "Success" });
    commands.refresh.mockReset();
  });

  it("reads and writes Magi settings through the selected environment", async () => {
    const panel = renderLoadedPanel();
    expect(atoms.environmentIds).toEqual([remoteEnvironmentId, remoteEnvironmentId]);

    const diagnosticsSwitch = visitElements(
      panel,
      (element) => element.props["aria-label"] === "Show details and diagnostics for Magi runs",
    );
    (diagnosticsSwitch?.props.onCheckedChange as ((checked: boolean) => void) | undefined)?.(true);
    await Promise.resolve();

    expect(commands.update).toHaveBeenCalledWith({
      environmentId: remoteEnvironmentId,
      input: { showRunDetailsAndDiagnostics: true },
    });
    expect(commands.refresh).toHaveBeenCalledWith(atoms.settingsAtom);
  });

  it("uses the shared provider list-detail frame and selection row for participants", () => {
    let panel = renderLoadedPanel();
    const frame = visitElements(panel, (element) => element.type === SettingsListDetail);
    expect(frame?.props.listLabel).toBe("Participant");
    expect(frame?.props.controlLabel).toBe("On");

    const builderRow = visitElements(
      panel,
      (element) => element.type === SettingsListDetailRow && element.props.title === "Builder",
    );
    expect(builderRow?.props.selected).toBe(false);
    (builderRow?.props.onSelect as (() => void) | undefined)?.();

    panel = renderPanel();
    const selectedBuilderRow = visitElements(
      panel,
      (element) => element.type === SettingsListDetailRow && element.props.title === "Builder",
    );
    expect(selectedBuilderRow?.props.selected).toBe(true);
  });

  it("keeps participant selection available while making writes read only", () => {
    const panel = renderLoadedPanel(true);
    const builderRow = visitElements(
      panel,
      (element) => element.type === SettingsListDetailRow && element.props.title === "Builder",
    );
    expect(builderRow?.props.onSelect).toBeTypeOf("function");

    const enableSwitch = visitElements(
      builderRow,
      (element) => element.props["aria-label"] === "Enable Builder",
    );
    expect(enableSwitch?.props.disabled).toBe(true);
    expect(
      visitElements(panel, (element) => element.props.children === "Add participant"),
    ).toBeNull();
    expect(visitElements(panel, (element) => element.props.inert === true)).not.toBeNull();
  });

  it("keeps local instructions until a new settings snapshot arrives", () => {
    vi.useFakeTimers();
    try {
      const instructions = (panel: ReactElement<Record<string, unknown>>) =>
        visitElements(panel, (element) => element.props["aria-label"] === "Skeptic instructions");
      const editor = instructions(renderLoadedPanel());
      if (!editor) throw new Error("Missing participant instructions editor");
      (editor.props.onChange as (event: { target: { value: string } }) => void)({
        target: { value: "Check the evidence first." },
      });

      renderPanel();
      expect(instructions(renderPanel())?.props.value).toBe("Check the evidence first.");

      atoms.settings = {
        ...DEFAULT_MAGI_SETTINGS,
        personalities: [
          {
            id: firstPersonalityId,
            name: "Skeptic",
            prompt: "Instructions from the server.",
            included: true,
          },
        ],
      };
      expect(instructions(renderLoadedPanel())?.props.value).toBe("Instructions from the server.");
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
