import { normalizeThreadConversationMaxWidth } from "@t3tools/shared/displayPreferences";
import * as vscode from "vscode";

import { BackendManager, resolveT3Home } from "./backendManager.ts";
import {
  createClientSettingsPersistence,
  registerClientSettingsHostBridge,
  resolveClientSettingsPath,
} from "./clientSettingsPersistence.ts";
import { cleanVirtualWorkspaceCache } from "./virtualWorkspaceCache.ts";
import {
  renderT3Webview,
  type WebviewBackendConnection,
  type WebviewDisplayPreferences,
  type WebviewHostAppearance,
} from "./webview.ts";

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel("T3 Code");
  const backendManager = new BackendManager(context, outputChannel);
  const displayPreferences = new WebviewDisplayPreferenceBroadcaster(context);
  const hostAppearance = new WebviewHostAppearanceBroadcaster(context);
  const backendConnections = new WebviewBackendConnectionBroadcaster();

  context.subscriptions.push(outputChannel);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "t3code.sidebarView",
      new T3SidebarProvider(
        context,
        backendManager,
        outputChannel,
        displayPreferences,
        hostAppearance,
        backendConnections,
      ),
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      "t3code.conversationEditor",
      new T3ConversationEditorProvider(
        context,
        backendManager,
        outputChannel,
        displayPreferences,
        hostAppearance,
        backendConnections,
      ),
      { supportsMultipleEditorsPerDocument: true },
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("t3code.open", async () => {
      await vscode.commands.executeCommand("t3code.sidebarView.focus");
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("t3code.newThread", async () => {
      const uri = vscode.Uri.parse(`t3-code://route/local/new?ts=${Date.now()}`);
      await vscode.commands.executeCommand("vscode.openWith", uri, "t3code.conversationEditor");
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("t3code.restartBackend", async () => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Restarting T3 Code backend",
        },
        async () => {
          const connection = await backendManager.restart();
          backendConnections.broadcast(connection);
        },
      );
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("t3code.cleanVirtualWorkspaceCache", async () => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Cleaning T3 Code virtual workspace cache",
        },
        async () => {
          const activeCwd = backendManager.activeCwd;
          const result = cleanVirtualWorkspaceCache({
            t3Home: resolveT3Home(),
            activeCheckoutPaths: activeCwd ? [activeCwd] : [],
            outputChannel,
          });
          vscode.window.showInformationMessage(
            `T3 Code cleaned ${result.deleted} virtual workspace checkout(s); kept ${result.kept}.`,
          );
        },
      );
    }),
  );
  context.subscriptions.push({
    dispose: () => {
      void backendManager.stop();
    },
  });
}

export function deactivate() {}

class T3SidebarProvider implements vscode.WebviewViewProvider {
  readonly #context: vscode.ExtensionContext;
  readonly #backendManager: BackendManager;
  readonly #outputChannel: vscode.OutputChannel;
  readonly #displayPreferences: WebviewDisplayPreferenceBroadcaster;
  readonly #hostAppearance: WebviewHostAppearanceBroadcaster;
  readonly #backendConnections: WebviewBackendConnectionBroadcaster;

  constructor(
    context: vscode.ExtensionContext,
    backendManager: BackendManager,
    outputChannel: vscode.OutputChannel,
    displayPreferences: WebviewDisplayPreferenceBroadcaster,
    hostAppearance: WebviewHostAppearanceBroadcaster,
    backendConnections: WebviewBackendConnectionBroadcaster,
  ) {
    this.#context = context;
    this.#backendManager = backendManager;
    this.#outputChannel = outputChannel;
    this.#displayPreferences = displayPreferences;
    this.#hostAppearance = hostAppearance;
    this.#backendConnections = backendConnections;
  }

  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    configureWebview(webviewView.webview, this.#context.extensionUri);
    const connection = await this.#backendManager.ensureStarted();
    const bridgeDisposable = registerClientSettingsHostBridge({
      webview: webviewView.webview,
      persistence: createClientSettingsPersistence(resolveClientSettingsPath(connection.t3Home)),
      outputChannel: this.#outputChannel,
      confirm: showHostConfirmDialog,
    });
    const displayPreferencesDisposable = this.#displayPreferences.track(webviewView.webview);
    const hostAppearanceDisposable = this.#hostAppearance.track(webviewView.webview);
    const backendConnectionDisposable = this.#backendConnections.track(webviewView.webview);
    webviewView.onDidDispose(() => {
      bridgeDisposable.dispose();
      displayPreferencesDisposable.dispose();
      hostAppearanceDisposable.dispose();
      backendConnectionDisposable.dispose();
    });
    webviewView.webview.html = await renderT3Webview({
      webview: webviewView.webview,
      extensionUri: this.#context.extensionUri,
      connection,
      displayPreferences: readWebviewDisplayPreferences(),
      hostAppearance: readWebviewHostAppearance(),
      initialRoute: "/_chat/",
    });
  }
}

class T3ConversationDocument implements vscode.CustomDocument {
  readonly uri: vscode.Uri;

  constructor(uri: vscode.Uri) {
    this.uri = uri;
  }

  dispose() {}
}

class T3ConversationEditorProvider implements vscode.CustomReadonlyEditorProvider<T3ConversationDocument> {
  readonly #context: vscode.ExtensionContext;
  readonly #backendManager: BackendManager;
  readonly #outputChannel: vscode.OutputChannel;
  readonly #displayPreferences: WebviewDisplayPreferenceBroadcaster;
  readonly #hostAppearance: WebviewHostAppearanceBroadcaster;
  readonly #backendConnections: WebviewBackendConnectionBroadcaster;

  constructor(
    context: vscode.ExtensionContext,
    backendManager: BackendManager,
    outputChannel: vscode.OutputChannel,
    displayPreferences: WebviewDisplayPreferenceBroadcaster,
    hostAppearance: WebviewHostAppearanceBroadcaster,
    backendConnections: WebviewBackendConnectionBroadcaster,
  ) {
    this.#context = context;
    this.#backendManager = backendManager;
    this.#outputChannel = outputChannel;
    this.#displayPreferences = displayPreferences;
    this.#hostAppearance = hostAppearance;
    this.#backendConnections = backendConnections;
  }

  openCustomDocument(uri: vscode.Uri): T3ConversationDocument {
    return new T3ConversationDocument(uri);
  }

  async resolveCustomEditor(
    document: T3ConversationDocument,
    webviewPanel: vscode.WebviewPanel,
  ): Promise<void> {
    configureWebview(webviewPanel.webview, this.#context.extensionUri);
    const connection = await this.#backendManager.ensureStarted();
    const bridgeDisposable = registerClientSettingsHostBridge({
      webview: webviewPanel.webview,
      persistence: createClientSettingsPersistence(resolveClientSettingsPath(connection.t3Home)),
      outputChannel: this.#outputChannel,
      confirm: showHostConfirmDialog,
    });
    const displayPreferencesDisposable = this.#displayPreferences.track(webviewPanel.webview);
    const hostAppearanceDisposable = this.#hostAppearance.track(webviewPanel.webview);
    const backendConnectionDisposable = this.#backendConnections.track(webviewPanel.webview);
    webviewPanel.onDidDispose(() => {
      bridgeDisposable.dispose();
      displayPreferencesDisposable.dispose();
      hostAppearanceDisposable.dispose();
      backendConnectionDisposable.dispose();
    });
    webviewPanel.webview.html = await renderT3Webview({
      webview: webviewPanel.webview,
      extensionUri: this.#context.extensionUri,
      connection,
      displayPreferences: readWebviewDisplayPreferences(),
      hostAppearance: readWebviewHostAppearance(),
      initialRoute: routeFromUri(document.uri),
    });
  }
}

const DISPLAY_PREFERENCE_SETTINGS = [
  "t3code.ui.showOpenInPicker",
  "t3code.ui.showCheckoutModeIndicator",
  "t3code.ui.showBranchSelector",
  "t3code.ui.enableTerminal",
  "t3code.ui.threadConversationMaxWidth",
] as const;

const HOST_APPEARANCE_SETTINGS = ["t3code.ui.restoreDefaultTheme"] as const;

class WebviewDisplayPreferenceBroadcaster {
  readonly #webviews = new Set<vscode.Webview>();

  constructor(context: vscode.ExtensionContext) {
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!DISPLAY_PREFERENCE_SETTINGS.some((key) => event.affectsConfiguration(key))) {
          return;
        }
        this.#broadcast();
      }),
    );
  }

  track(webview: vscode.Webview): vscode.Disposable {
    this.#webviews.add(webview);
    return {
      dispose: () => {
        this.#webviews.delete(webview);
      },
    };
  }

  #broadcast(): void {
    const preferences = readWebviewDisplayPreferences();
    for (const webview of this.#webviews) {
      void webview["postMessage"]({
        type: "t3.displayPreferencesChanged",
        preferences,
      });
    }
  }
}

class WebviewBackendConnectionBroadcaster {
  readonly #webviews = new Set<vscode.Webview>();

  track(webview: vscode.Webview): vscode.Disposable {
    this.#webviews.add(webview);
    return {
      dispose: () => {
        this.#webviews.delete(webview);
      },
    };
  }

  broadcast(connection: WebviewBackendConnection): void {
    const webviewConnection: WebviewBackendConnection = {
      httpBaseUrl: connection.httpBaseUrl,
      wsBaseUrl: connection.wsBaseUrl,
      bootstrapToken: connection.bootstrapToken,
      bearerToken: connection.bearerToken,
    };
    for (const webview of this.#webviews) {
      void webview["postMessage"]({
        type: "t3.backendConnectionChanged",
        connection: webviewConnection,
      });
    }
  }
}

class WebviewHostAppearanceBroadcaster {
  readonly #webviews = new Set<vscode.Webview>();

  constructor(context: vscode.ExtensionContext) {
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!HOST_APPEARANCE_SETTINGS.some((key) => event.affectsConfiguration(key))) {
          return;
        }
        this.#broadcast();
      }),
    );
    context.subscriptions.push(
      vscode.window.onDidChangeActiveColorTheme(() => {
        this.#broadcast();
      }),
    );
  }

  track(webview: vscode.Webview): vscode.Disposable {
    this.#webviews.add(webview);
    return {
      dispose: () => {
        this.#webviews.delete(webview);
      },
    };
  }

  #broadcast(): void {
    const appearance = readWebviewHostAppearance();
    for (const webview of this.#webviews) {
      void webview["postMessage"]({
        type: "t3.hostAppearanceChanged",
        appearance,
      });
    }
  }
}

function readWebviewDisplayPreferences(): WebviewDisplayPreferences {
  const configuration = vscode.workspace.getConfiguration("t3code");
  return {
    showOpenInPicker: configuration.get<boolean>("ui.showOpenInPicker", false),
    showCheckoutModeIndicator: configuration.get<boolean>("ui.showCheckoutModeIndicator", false),
    showBranchSelector: configuration.get<boolean>("ui.showBranchSelector", false),
    enableTerminal: configuration.get<boolean>("ui.enableTerminal", false),
    threadConversationMaxWidthPx: normalizeThreadConversationMaxWidth(
      configuration.get<number>("ui.threadConversationMaxWidth"),
    ),
  };
}

function readWebviewHostAppearance(): WebviewHostAppearance {
  const configuration = vscode.workspace.getConfiguration("t3code");
  const restoreDefaultTheme = configuration.get<boolean>("ui.restoreDefaultTheme", false);
  return {
    themeSource: restoreDefaultTheme ? "default" : "vscode",
    colorScheme: resolveColorScheme(vscode.window.activeColorTheme.kind),
  };
}

export function resolveColorScheme(
  kind: vscode.ColorThemeKind,
): WebviewHostAppearance["colorScheme"] {
  switch (kind) {
    case vscode.ColorThemeKind.Dark:
    case vscode.ColorThemeKind.HighContrast:
      return "dark";
    case vscode.ColorThemeKind.Light:
    case vscode.ColorThemeKind.HighContrastLight:
    default:
      return "light";
  }
}

function configureWebview(webview: vscode.Webview, extensionUri: vscode.Uri) {
  webview.options = {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist", "webview")],
  };
}

async function showHostConfirmDialog(message: string): Promise<boolean> {
  const confirmLabel = "Confirm";
  const result = await vscode.window.showWarningMessage(message, { modal: true }, confirmLabel);
  return result === confirmLabel;
}

export function routeFromUri(uri: vscode.Uri): string {
  const routeParts = uri.path.split("/").filter(Boolean);
  const environmentId = routeParts.at(-2);
  const threadId = routeParts.at(-1);
  if (!environmentId || !threadId || threadId === "new") {
    return "/_chat/";
  }
  return `/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;
}
