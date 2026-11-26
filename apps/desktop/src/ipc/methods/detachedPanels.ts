import {
  DesktopDetachedPanelSyncInputSchema,
  DesktopDetachedPanelWindowNameSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";

/** Only the main renderer drives detached panel windows. */
const fromMainRenderer = Effect.fn("desktop.ipc.detachedPanels.fromMainRenderer")(function* (
  event: DesktopIpc.DesktopIpcInvokeEvent | undefined,
) {
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const main = yield* electronWindow.main;
  return (
    event !== undefined &&
    Option.isSome(main) &&
    !main.value.isDestroyed() &&
    main.value.webContents.id === event.sender.id
  );
});

export const sync = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DETACHED_PANELS_SYNC_CHANNEL,
  payload: DesktopDetachedPanelSyncInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.detachedPanels.sync")(function* (input, event) {
    if (!(yield* fromMainRenderer(event))) return;
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    yield* desktopWindow.detachedPanels.sync(input.visible);
  }),
});

const makeNamedMethod = (
  channel: string,
  run: (
    detachedPanels: DesktopWindow.DesktopWindow["Service"]["detachedPanels"],
    name: string,
  ) => Effect.Effect<void>,
) =>
  DesktopIpc.makeIpcMethod({
    channel,
    payload: DesktopDetachedPanelWindowNameSchema,
    result: Schema.Void,
    handler: Effect.fn("desktop.ipc.detachedPanels.named")(function* (name, event) {
      if (!(yield* fromMainRenderer(event))) return;
      const desktopWindow = yield* DesktopWindow.DesktopWindow;
      yield* run(desktopWindow.detachedPanels, name);
    }),
  });

export const reveal = makeNamedMethod(IpcChannels.DETACHED_PANELS_REVEAL_CHANNEL, (panels, name) =>
  panels.reveal(name),
);
export const focus = makeNamedMethod(IpcChannels.DETACHED_PANELS_FOCUS_CHANNEL, (panels, name) =>
  panels.focus(name),
);
export const close = makeNamedMethod(IpcChannels.DETACHED_PANELS_CLOSE_CHANNEL, (panels, name) =>
  panels.close(name),
);
