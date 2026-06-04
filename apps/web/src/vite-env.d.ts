/// <reference types="vite-plus/client" />

import type { DesktopBridge, LocalApi, T3HostBridge } from "@t3tools/contracts";

interface ImportMetaEnv {
  readonly VITE_HTTP_URL: string;
  readonly VITE_WS_URL: string;
  readonly VITE_HOSTED_APP_URL: string;
  readonly VITE_HOSTED_APP_CHANNEL: string;
  readonly APP_VERSION: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare global {
  interface Window {
    nativeApi?: LocalApi;
    desktopBridge?: DesktopBridge;
    t3HostBridge?: T3HostBridge;
    __T3_IS_VSCODE_WEBVIEW?: boolean;
  }
}
