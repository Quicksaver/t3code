# T3 Code for VS Code

T3 Code is a minimal web GUI for coding agents (currently Codex, Claude, and OpenCode, more coming soon), packaged as a VS Code extension.

The extension starts a local T3 backend for your active VS Code workspace and opens the T3 Code UI inside VS Code.

## Installation

> [!WARNING]
> T3 Code currently supports Codex, Claude, and OpenCode.
> Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`

Install the latest VS Code extension build from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), then use VS Code's "Install from VSIX..." command.

## VS Code UI

- `t3code.sidebarView`: the T3 Code Activity Bar panel. Use it to open the workspace-scoped T3 Code chat UI inside VS Code.
- `t3code.conversationEditor`: the T3 Code thread editor used to open T3 Code threads in editor tabs.

The extension hides T3 Code controls that duplicate VS Code-native surfaces by default, including the open/reveal picker, checkout indicator, branch selector, and embedded terminal drawer. These can be restored with the settings below.

## Commands

- `T3 Code: Open` (`t3code.open`): focuses the T3 Code Activity Bar panel.
- `T3 Code: New Thread` (`t3code.newThread`): opens a new T3 Code thread in an editor.
- `T3 Code: Restart Backend` (`t3code.restartBackend`): restarts the extension-owned local T3 backend.
- `T3 Code: Clean Virtual Workspace Cache` (`t3code.cleanVirtualWorkspaceCache`): removes inactive T3-owned virtual workspace checkouts.

## Settings

- `t3code.home`: optional T3 home directory. Defaults to `~/.t3`, matching the desktop app.
- `t3code.server.command`: optional executable used to start the T3 backend. When unset, the extension uses its bundled backend or a development checkout.
- `t3code.server.args`: additional arguments for `t3code.server.command`.
- `t3code.server.cwd`: optional working directory for `t3code.server.command`.
- `t3code.ui.showOpenInPicker`: show the T3 Code open/reveal picker inside VS Code webviews. Defaults to `false`.
- `t3code.ui.showCheckoutModeIndicator`: show the T3 Code checkout mode indicator inside VS Code webviews. Defaults to `false`.
- `t3code.ui.showBranchSelector`: show the T3 Code branch/ref selector inside VS Code webviews. Defaults to `false`.
- `t3code.ui.enableTerminal`: enable the T3 Code terminal drawer, terminal actions, and terminal keybindings inside VS Code webviews. Defaults to `false`.
- `t3code.ui.restoreDefaultTheme`: use T3 Code's default app theme instead of matching the active VS Code theme and fonts. Defaults to `false`.

## Some notes

> [!NOTE]
> T3 Code is very early. Expect bugs.

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
