# Device Host Discovery Reliability

**Worktree branch:** `fix/device-host-discovery`

Windows worktree: `E:/Projects/t3code.worktrees/device-host-discovery`.

SSH device hosts use one npm invocation path for connection probes and pinned tool installation. Windows runs `npm-cli.js` through the selected Node executable, checking beside Node before PATH directories and preserving paths and arguments containing spaces. Non-interactive POSIX setup appends fallback tool directories so an existing Node/npm pair keeps priority. Missing npm, launch failures, signals, and nonzero process exits retain distinct diagnostics.

Android device access does not require successful enumeration of stopped virtual devices. When `emulator -list-avds` fails, the shared service retains devices returned by the hub and reports the command, exit code, and diagnostic output alongside any hub discovery errors. Successful enumeration still adds unbooted AVDs without duplicating running or repeated entries; a successful refresh clears prior warnings. Local and SSH hosts use the same partial-discovery behavior. Web and desktop show ready-host limitations in both the Device panel and device-host settings. Mobile and agent consumers retain the existing shared device state and wire contract.

Primary files:

- `apps/server/src/device/sshDeviceScript.ts`
- `apps/server/src/device/DeviceService.ts`
- `apps/web/src/components/device/DevicePanel.tsx`
- `apps/web/src/components/settings/DeviceHostsSettings.tsx`
- `docs/user/devices.md`

Focused regression coverage:

```sh
vp test run apps/server/src/device/sshDeviceScript.test.ts apps/server/src/device/SshDeviceHost.test.ts apps/server/src/device/DeviceService.test.ts apps/server/src/device/DeviceMultiHost.test.ts
```

Native Windows subprocess coverage checks paths containing spaces, npm PATH fallback, probe and install dispatch, missing npm, and actual npm failure diagnostics. Service fixtures cover missing emulator tooling, tool failures, SSH failures during optional enumeration, preserved iOS and physical Android results, existing hub diagnostics, recovery, and AVD deduplication. POSIX-only shell and lifecycle fixtures require a POSIX host; their bodies do not execute on Windows.
