import type { SignOptions } from "@electron/osx-sign";

import sign from "./sign-macos.ts";

/** Sign during packaging, before either the DMG or updater ZIP is created. */
export default async function signLocalMac(options: SignOptions): Promise<void> {
  const identity = process.env.T3CODE_MACOS_LOCAL_SIGNING_IDENTITY;
  if (!identity || !/^[A-F0-9]{40}$/u.test(identity)) {
    throw new Error(
      "Local macOS signing requires the certificate selected by the build preflight.",
    );
  }
  await sign({ ...options, identity, type: "development" });
}
