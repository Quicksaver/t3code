import {
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderVersionAdvisory,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { formatDisplayCommand, resolveCommandPath } from "@t3tools/shared/shell";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

const LATEST_VERSION_CACHE_TTL_MS = 60 * 60 * 1_000;
const LATEST_VERSION_TIMEOUT_MS = 4_000;
const PROVIDER_UPDATE_ACTION_TOAST_MESSAGE = "Install the update now or review provider settings.";

const compactEnv = (input: Record<string, Option.Option<string>>): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(input).flatMap(([key, value]) =>
      Option.match(value, {
        onNone: () => [],
        onSome: (resolved) => [[key, resolved]],
      }),
    ),
  );

const CommandLookupEnvConfig = Config.all({
  PATH: Config.string("PATH").pipe(Config.option),
  Path: Config.string("Path").pipe(Config.option),
  path: Config.string("path").pipe(Config.option),
  PATHEXT: Config.string("PATHEXT").pipe(Config.option),
  APPDATA: Config.string("APPDATA").pipe(Config.option),
}).pipe(Config.map(compactEnv));

const readCommandLookupEnv = CommandLookupEnvConfig.pipe(Effect.orElseSucceed(() => ({})));

export interface ProviderMaintenanceCapabilities {
  readonly provider: ProviderDriverKind;
  readonly packageName: string | null;
  readonly update: ProviderMaintenanceCommandAction | null;
}

export interface ProviderMaintenanceCommandAction {
  readonly command: string;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly lockKey: string;
}

export interface ProviderMaintenanceCapabilityResolutionOptions {
  readonly binaryPath?: string | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly resolvedCommandPath?: string | null;
  readonly realCommandPath?: string | null;
}

export interface ProviderMaintenanceCapabilitiesResolver {
  readonly resolve: (
    options: ProviderMaintenanceCapabilityResolutionOptions,
  ) => ProviderMaintenanceCapabilities;
}

export interface PackageManagedProviderMaintenanceDefinition {
  readonly provider: ProviderDriverKind;
  readonly npmPackageName: string;
  readonly homebrewFormula: string | null;
  readonly fallbackUpdate?: {
    readonly executable: string;
    readonly args: ReadonlyArray<string>;
    readonly lockKey: string;
  };
  readonly nativeUpdate: {
    readonly executable: string;
    readonly args: ReadonlyArray<string>;
    readonly lockKey: string;
    readonly isCommandPath: (commandPath: string) => boolean;
  } | null;
}

export interface ProviderVersionCacheEntry {
  readonly expiresAt: number;
  readonly version: string | null;
}

export const ProviderVersionCache = Context.Reference<Map<string, ProviderVersionCacheEntry>>(
  "@t3tools/server/providerMaintenance/ProviderVersionCache",
  {
    defaultValue: () => new Map(),
  },
);
const NpmLatestVersionResponse = Schema.Struct({
  version: Schema.optional(Schema.String),
});

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function makeProviderMaintenanceCapabilities(input: {
  readonly provider: ProviderDriverKind;
  readonly packageName: string | null;
  readonly updateExecutable: string | null;
  readonly updateArgs: ReadonlyArray<string>;
  readonly updateLockKey: string | null;
  readonly platform: NodeJS.Platform;
}): ProviderMaintenanceCapabilities {
  const update =
    input.updateExecutable === null || input.updateLockKey === null
      ? null
      : {
          command: formatDisplayCommand(input.updateExecutable, input.updateArgs, input.platform),
          executable: input.updateExecutable,
          args: input.updateArgs,
          lockKey: input.updateLockKey,
        };
  return {
    provider: input.provider,
    packageName: input.packageName,
    update,
  };
}

export function makeManualOnlyProviderMaintenanceCapabilities(input: {
  readonly provider: ProviderDriverKind;
  readonly packageName: string | null;
}): ProviderMaintenanceCapabilities {
  return {
    provider: input.provider,
    packageName: input.packageName,
    update: null,
  };
}

function makeNpmGlobalProviderMaintenanceCapabilities(
  definition: PackageManagedProviderMaintenanceDefinition,
  platform: NodeJS.Platform,
): ProviderMaintenanceCapabilities {
  return makeProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.npmPackageName,
    updateExecutable: "npm",
    // npm 12 blocks install scripts by default (empty allow-scripts allowlist)
    // and still exits 0, so a package whose postinstall finishes the install
    // (claude copies its native binary over a placeholder stub) is left broken
    // while the update reports success. Allow this one package's scripts.
    // Older npm warns about the unknown config and continues.
    updateArgs: [
      "install",
      "-g",
      `--allow-scripts=${definition.npmPackageName}`,
      `${definition.npmPackageName}@latest`,
    ],
    updateLockKey: "npm-global",
    platform,
  });
}

function makeBunGlobalProviderMaintenanceCapabilities(
  definition: PackageManagedProviderMaintenanceDefinition,
  platform: NodeJS.Platform,
): ProviderMaintenanceCapabilities {
  return makeProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.npmPackageName,
    updateExecutable: "bun",
    updateArgs: ["i", "-g", `${definition.npmPackageName}@latest`],
    updateLockKey: "bun-global",
    platform,
  });
}

function makePnpmGlobalProviderMaintenanceCapabilities(
  definition: PackageManagedProviderMaintenanceDefinition,
  platform: NodeJS.Platform,
): ProviderMaintenanceCapabilities {
  return makeProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.npmPackageName,
    updateExecutable: "pnpm",
    updateArgs: ["add", "-g", `${definition.npmPackageName}@latest`],
    updateLockKey: "pnpm-global",
    platform,
  });
}

function makeVitePlusGlobalProviderMaintenanceCapabilities(
  definition: PackageManagedProviderMaintenanceDefinition,
  platform: NodeJS.Platform,
): ProviderMaintenanceCapabilities {
  return makeProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.npmPackageName,
    updateExecutable: "vp",
    updateArgs: ["i", "-g", definition.npmPackageName],
    updateLockKey: "vite-plus-global",
    platform,
  });
}

function makeHomebrewProviderMaintenanceCapabilities(
  definition: PackageManagedProviderMaintenanceDefinition,
  platform: NodeJS.Platform,
): ProviderMaintenanceCapabilities {
  if (!definition.homebrewFormula) {
    return makeManualOnlyProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName: definition.npmPackageName,
    });
  }

  return makeProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.npmPackageName,
    updateExecutable: "brew",
    updateArgs: ["upgrade", definition.homebrewFormula],
    updateLockKey: "homebrew",
    platform,
  });
}

function makeNativeProviderMaintenanceCapabilities(
  definition: PackageManagedProviderMaintenanceDefinition,
  platform: NodeJS.Platform,
): ProviderMaintenanceCapabilities | null {
  if (!definition.nativeUpdate) {
    return null;
  }

  return makeProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.npmPackageName,
    updateExecutable: definition.nativeUpdate.executable,
    updateArgs: definition.nativeUpdate.args,
    updateLockKey: definition.nativeUpdate.lockKey,
    platform,
  });
}

function makeFallbackProviderMaintenanceCapabilities(
  definition: PackageManagedProviderMaintenanceDefinition,
  platform: NodeJS.Platform,
  updateExecutable?: string,
): ProviderMaintenanceCapabilities | null {
  if (!definition.fallbackUpdate) {
    return null;
  }

  return makeProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.npmPackageName,
    updateExecutable: updateExecutable ?? definition.fallbackUpdate.executable,
    updateArgs: definition.fallbackUpdate.args,
    updateLockKey: definition.fallbackUpdate.lockKey,
    platform,
  });
}

export function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

export function normalizeCommandPath(commandPath: string): string {
  return commandPath.replaceAll("\\", "/").toLowerCase();
}

function isBunGlobalCommandPath(commandPath: string): boolean {
  return normalizeCommandPath(commandPath).includes("/.bun/bin/");
}

function isVitePlusGlobalCommandPath(commandPath: string): boolean {
  return normalizeCommandPath(commandPath).includes("/.vite-plus/bin/");
}

function isPnpmGlobalCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.includes("/.local/share/pnpm/") ||
    normalized.includes("/library/pnpm/") ||
    normalized.includes("/local/share/pnpm/") ||
    normalized.includes("/appdata/local/pnpm/") ||
    normalized.includes("/pnpm/global/")
  );
}

function isProgramFilesNodeNpmShimPath(normalizedCommandPath: string): boolean {
  const nodeDirectory = [":/program files/nodejs/", ":/program files (x86)/nodejs/"].find(
    (directory) => normalizedCommandPath.includes(directory),
  );
  if (!nodeDirectory) {
    return false;
  }

  const shimName = normalizedCommandPath.slice(
    normalizedCommandPath.indexOf(nodeDirectory) + nodeDirectory.length,
  );
  return !shimName.includes("/") && (shimName.endsWith(".cmd") || shimName.endsWith(".ps1"));
}

function isNpmGlobalCommandPath(commandPath: string, env?: NodeJS.ProcessEnv): boolean {
  const normalized = normalizeCommandPath(commandPath);
  const appData = nonEmptyString(env?.APPDATA);
  const appDataNpmPrefix = appData
    ? `${normalizeCommandPath(appData).replace(/\/+$/, "")}/npm/`
    : null;
  return (
    normalized.includes("/node_modules/.bin/") ||
    normalized.includes("/lib/node_modules/") ||
    normalized.includes("/npm/node_modules/") ||
    normalized.includes("/appdata/roaming/npm/") ||
    (appDataNpmPrefix !== null && normalized.startsWith(appDataNpmPrefix)) ||
    isProgramFilesNodeNpmShimPath(normalized)
  );
}

function isHomebrewCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.includes("/opt/homebrew/cellar/") ||
    normalized.includes("/usr/local/cellar/") ||
    normalized.includes("/homebrew/cellar/") ||
    normalized.includes("/opt/homebrew/caskroom/") ||
    normalized.includes("/usr/local/caskroom/") ||
    normalized.includes("/homebrew/caskroom/") ||
    normalized.startsWith("/opt/homebrew/bin/") ||
    normalized.startsWith("/usr/local/bin/")
  );
}

export function resolvePackageManagedProviderMaintenance(
  definition: PackageManagedProviderMaintenanceDefinition,
  options: ProviderMaintenanceCapabilityResolutionOptions,
): ProviderMaintenanceCapabilities {
  const platform = options.platform;
  const binaryPath = nonEmptyString(options.binaryPath);
  if (!binaryPath) {
    return (
      makeFallbackProviderMaintenanceCapabilities(definition, platform) ??
      makeNpmGlobalProviderMaintenanceCapabilities(definition, platform)
    );
  }

  const resolvedCommandPath =
    options?.resolvedCommandPath ?? (hasPathSeparator(binaryPath) ? binaryPath : null);

  if (resolvedCommandPath) {
    const commandPaths = [
      resolvedCommandPath,
      ...(options?.realCommandPath ? [options.realCommandPath] : []),
    ];

    const nativeUpdate = definition.nativeUpdate;
    if (
      nativeUpdate &&
      commandPaths.some((commandPath) => nativeUpdate.isCommandPath(commandPath))
    ) {
      return (
        makeNativeProviderMaintenanceCapabilities(definition, platform) ??
        makeNpmGlobalProviderMaintenanceCapabilities(definition, platform)
      );
    }
    if (commandPaths.some(isVitePlusGlobalCommandPath)) {
      return makeVitePlusGlobalProviderMaintenanceCapabilities(definition, platform);
    }
    if (commandPaths.some(isBunGlobalCommandPath)) {
      return makeBunGlobalProviderMaintenanceCapabilities(definition, platform);
    }
    if (commandPaths.some(isPnpmGlobalCommandPath)) {
      return makePnpmGlobalProviderMaintenanceCapabilities(definition, platform);
    }
    if (commandPaths.some((commandPath) => isNpmGlobalCommandPath(commandPath, options?.env))) {
      return makeNpmGlobalProviderMaintenanceCapabilities(definition, platform);
    }
    if (commandPaths.some(isHomebrewCommandPath)) {
      return makeHomebrewProviderMaintenanceCapabilities(definition, platform);
    }
  }

  const fallbackUpdate = makeFallbackProviderMaintenanceCapabilities(
    definition,
    platform,
    hasPathSeparator(binaryPath) ? binaryPath : undefined,
  );
  if (fallbackUpdate) {
    return fallbackUpdate;
  }

  if (!hasPathSeparator(binaryPath)) {
    return makeNpmGlobalProviderMaintenanceCapabilities(definition, platform);
  }

  return makeManualOnlyProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.npmPackageName,
  });
}

export function makePackageManagedProviderMaintenanceResolver(
  definition: PackageManagedProviderMaintenanceDefinition,
): ProviderMaintenanceCapabilitiesResolver {
  return {
    resolve: (options) => resolvePackageManagedProviderMaintenance(definition, options),
  };
}

export function makeStaticProviderMaintenanceResolver(
  capabilities: ProviderMaintenanceCapabilities,
): ProviderMaintenanceCapabilitiesResolver {
  return {
    resolve: () => capabilities,
  };
}

function makeManualProviderMaintenanceCapabilities(
  provider: ProviderDriverKind,
): ProviderMaintenanceCapabilities {
  return makeManualOnlyProviderMaintenanceCapabilities({
    provider,
    packageName: null,
  });
}

export const resolveProviderMaintenanceCapabilitiesEffect = Effect.fn(
  "resolveProviderMaintenanceCapabilitiesEffect",
)(function* (
  resolver: ProviderMaintenanceCapabilitiesResolver,
  options?: Omit<ProviderMaintenanceCapabilityResolutionOptions, "platform" | "realCommandPath">,
) {
  const platform = yield* HostProcessPlatform;
  const resolutionOptions = { ...options, platform };
  const binaryPath = nonEmptyString(options?.binaryPath);
  if (!binaryPath) {
    return resolver.resolve(resolutionOptions);
  }

  const env = options?.env ?? (yield* readCommandLookupEnv);
  const resolvedCommandPath =
    (yield* resolveCommandPath(binaryPath, { env }).pipe(
      Effect.catchTag("CommandResolutionError", () => Effect.succeed(null)),
    )) ?? (hasPathSeparator(binaryPath) ? binaryPath : null);
  if (!resolvedCommandPath) {
    return resolver.resolve(resolutionOptions);
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const realCommandPath = yield* fileSystem
    .realPath(resolvedCommandPath)
    .pipe(Effect.orElseSucceed(() => resolvedCommandPath));
  return resolver.resolve({
    ...resolutionOptions,
    env,
    resolvedCommandPath,
    realCommandPath,
  });
});

function deriveVersionAdvisory(input: {
  readonly currentVersion: string | null;
  readonly latestVersion: string | null;
}): Pick<ServerProviderVersionAdvisory, "status" | "message"> {
  if (!input.currentVersion) {
    return { status: "unknown", message: null };
  }
  if (!input.latestVersion) {
    return { status: "unknown", message: null };
  }
  if (compareSemverVersions(input.currentVersion, input.latestVersion) < 0) {
    return {
      status: "behind_latest",
      message: PROVIDER_UPDATE_ACTION_TOAST_MESSAGE,
    };
  }
  return { status: "current", message: null };
}

export function createProviderVersionAdvisory(input: {
  readonly driver: ProviderDriverKind;
  readonly currentVersion: string | null;
  readonly latestVersion?: string | null;
  readonly checkedAt?: string | null;
  readonly maintenanceCapabilities?: ProviderMaintenanceCapabilities;
}): ServerProviderVersionAdvisory {
  const capabilities =
    input.maintenanceCapabilities ?? makeManualProviderMaintenanceCapabilities(input.driver);
  const latestVersion = input.latestVersion ?? null;
  const advisory = deriveVersionAdvisory({
    currentVersion: input.currentVersion,
    latestVersion,
  });

  return {
    status: advisory.status,
    currentVersion: input.currentVersion,
    latestVersion,
    updateCommand: capabilities.update?.command ?? null,
    canUpdate: capabilities.update !== null,
    checkedAt: input.checkedAt ?? null,
    message: advisory.message,
  };
}

const fetchNpmLatestVersion = Effect.fn("fetchNpmLatestVersion")(function* (packageName: string) {
  const client = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.get(
    `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`,
  ).pipe(HttpClientRequest.setHeader("accept", "application/json"));
  const response = yield* client.execute(request).pipe(
    Effect.timeoutOption(LATEST_VERSION_TIMEOUT_MS),
    Effect.orElseSucceed(() => Option.none()),
  );
  if (Option.isNone(response)) {
    return null;
  }
  const httpResponse = response.value;
  if (httpResponse.status < 200 || httpResponse.status >= 300) {
    return null;
  }
  const payload = yield* httpResponse.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(NpmLatestVersionResponse)),
    Effect.orElseSucceed(() => null),
  );
  return payload ? nonEmptyString(payload.version) : null;
});

export const resolveLatestProviderVersion = Effect.fn("resolveLatestProviderVersion")(function* (
  maintenanceCapabilities: ProviderMaintenanceCapabilities,
) {
  const packageName = maintenanceCapabilities.packageName;
  if (!packageName) {
    return null;
  }

  const latestVersionCache = yield* ProviderVersionCache;
  const cached = latestVersionCache.get(packageName);
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  if (cached && cached.expiresAt > now) {
    return cached.version;
  }

  const version = yield* fetchNpmLatestVersion(packageName);
  latestVersionCache.set(packageName, {
    expiresAt: now + LATEST_VERSION_CACHE_TTL_MS,
    version,
  });
  return version;
});

export const enrichProviderSnapshotWithVersionAdvisory = Effect.fn(
  "enrichProviderSnapshotWithVersionAdvisory",
)(function* (
  snapshot: ServerProvider,
  maintenanceCapabilities?: ProviderMaintenanceCapabilities,
  options?: {
    readonly enableProviderUpdateChecks: boolean | undefined;
  },
) {
  const capabilities =
    maintenanceCapabilities ?? makeManualProviderMaintenanceCapabilities(snapshot.driver);
  const shouldResolveLatestVersion =
    options?.enableProviderUpdateChecks !== false &&
    snapshot.enabled &&
    snapshot.installed &&
    Boolean(snapshot.version);
  if (!shouldResolveLatestVersion) {
    return {
      ...snapshot,
      versionAdvisory: createProviderVersionAdvisory({
        driver: snapshot.driver,
        currentVersion: snapshot.version,
        checkedAt: snapshot.checkedAt,
        maintenanceCapabilities: capabilities,
      }),
    };
  }

  const latestVersion = yield* resolveLatestProviderVersion(capabilities);
  return {
    ...snapshot,
    versionAdvisory: createProviderVersionAdvisory({
      driver: snapshot.driver,
      currentVersion: snapshot.version,
      latestVersion,
      checkedAt: DateTime.formatIso(yield* DateTime.now),
      maintenanceCapabilities: capabilities,
    }),
  };
});
