# Codex CLI installation-aware updates

The fork chooses the Codex update command from the resolved CLI installation instead of treating every unclassified `codex` command as an npm install.

## Current behavior

- Codex installations resolved through Vite+, Bun, pnpm, npm, or Homebrew use that package manager's update command.
- npm detection includes canonical npm module paths, `%APPDATA%\npm` shims in both the default profile and `%APPDATA%`-redirected profiles, and direct `.cmd` or `.ps1` shims under `C:\Program Files\nodejs` and `C:\Program Files (x86)\nodejs`.
- Other Codex installations use the Codex `update` subcommand. Default commands, unresolved bare commands, and bare commands whose resolved path matches no package-manager classifier—including the `~/.local/bin/codex` and `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin` install-script paths—use `codex update`. Explicit unclassified paths use `<configured-path> update`.
- Displayed update commands use PowerShell quoting on Windows and POSIX-shell quoting elsewhere, covering the executable and every argument. One-click updates continue to execute the original structured executable and argument values directly.
- Provider status snapshots persist the selected command in `<t3-home>/caches/codex.json`.
- Package-managed provider definitions may omit `fallbackUpdate`. Omission keeps the standard resolver behavior: a missing binary path and any bare command that no classifier matches—resolved or not—use npm, while explicit unclassified paths have no one-click update. Codex opts into its self-update fallback. Claude and OpenCode use the standard behavior.

## Integration notes

- `packages/shared/src/shell.ts` owns platform-aware display-command rendering. Keep display quoting separate from structured execution values.
- `apps/server/src/provider/providerMaintenance.ts` owns installation classification, optional fallback updates, and update-command selection. Keep recognized native and package-manager installations ahead of the fallback.
- `apps/server/src/provider/Drivers/CodexDriver.ts` supplies the Codex-specific `update` fallback. Keep bare commands on `codex update` and target the configured executable only for explicit paths.
- `apps/server/src/provider/Drivers/ClaudeDriver.ts` and `apps/server/src/provider/Drivers/OpenCodeDriver.ts` need no fork-specific fallback setting. Both omit `fallbackUpdate` and retain the standard resolver behavior.
- `apps/server/src/provider/providerMaintenance.test.ts` covers resolver precedence, omitted fallback behavior, npm shim classification, and command rendering. `apps/server/src/provider/Drivers/CodexDriver.test.ts` covers Codex-specific selection.

## Development ports

- Web: `5746`
- Server/WebSocket: `13786`
