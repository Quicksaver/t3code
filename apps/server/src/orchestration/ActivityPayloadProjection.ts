import type {
  OrchestrationEvent,
  OrchestrationThreadActivity,
  OrchestrationThreadDetailSnapshot,
} from "@t3tools/contracts";
import {
  looksLikeUnifiedDiff,
  WORK_LOG_ACTIVITY_LIMITS,
  WORK_LOG_COMMAND_DURATION_MS_KEYS,
  WORK_LOG_COMMAND_ELAPSED_SECONDS_KEYS,
  WORK_LOG_COMMAND_EXIT_CODE_KEYS,
  WORK_LOG_COMMAND_OUTPUT_TRUNCATED_MARKER,
  WORK_LOG_COMMAND_ITEM_CONTENT_KEYS,
  WORK_LOG_COMMAND_RESULT_NUMBER_KEYS,
  WORK_LOG_COMMAND_RESULT_TEXT_KEYS,
  WORK_LOG_PATCH_CONTAINER_KEYS,
  WORK_LOG_PATCH_KEYS,
  WORK_LOG_PATH_KEYS,
} from "@t3tools/shared/toolActivity";
import { isWorkspaceImagePreviewPath } from "@t3tools/shared/filePreview";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

interface CommandTextBudget {
  remaining: number;
  truncated: boolean;
}

function boundedCommandText(value: string, budget: CommandTextBudget): string | undefined {
  if (value.length <= budget.remaining) {
    budget.remaining -= value.length;
    return value;
  }
  budget.truncated = true;
  if (budget.remaining === 0) {
    return undefined;
  }
  const marker = WORK_LOG_COMMAND_OUTPUT_TRUNCATED_MARKER.slice(0, budget.remaining);
  const prefixLength = Math.max(0, budget.remaining - marker.length);
  const projected = `${value.slice(0, prefixLength)}${marker}`;
  budget.remaining = 0;
  return projected;
}

function copyCommandResultFields(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  budget: CommandTextBudget,
): void {
  for (const key of WORK_LOG_COMMAND_RESULT_TEXT_KEYS) {
    if (typeof source[key] === "string") {
      const projected = boundedCommandText(source[key], budget);
      if (projected !== undefined) {
        target[key] = projected;
      }
    }
  }
  for (const key of WORK_LOG_COMMAND_RESULT_NUMBER_KEYS) {
    if (typeof source[key] === "number" && Number.isFinite(source[key])) {
      target[key] = source[key];
    }
  }
}

function projectCommandData(
  data: Record<string, unknown>,
  preserveCommandDetails: boolean,
  budget: CommandTextBudget,
): Record<string, unknown> | undefined {
  const item = asRecord(data.item);
  if (!item) {
    return undefined;
  }

  const projectedItem: Record<string, unknown> = {};
  if ("command" in item) {
    projectedItem.command = item.command;
  }
  const input = asRecord(item.input);
  if (input && "command" in input) {
    projectedItem.input = { command: input.command };
  }

  const result = asRecord(item.result);
  if (result) {
    const projectedResult: Record<string, unknown> = {};
    if ("command" in result) {
      projectedResult.command = result.command;
    }
    if (preserveCommandDetails) {
      copyCommandResultFields(result, projectedResult, budget);
    } else {
      const content = asTrimmedString(result.content);
      if (content) {
        const summary = summarizeToolTextOutput(content);
        if (summary) {
          projectedResult.content = summary;
        }
      }
    }
    if (Object.keys(projectedResult).length > 0) {
      projectedItem.result = projectedResult;
    }
  }

  if (preserveCommandDetails) {
    if (typeof item.aggregatedOutput === "string") {
      const aggregatedOutput = boundedCommandText(item.aggregatedOutput, budget);
      if (aggregatedOutput !== undefined) {
        projectedItem.aggregatedOutput = aggregatedOutput;
      }
    }
    copyCommandResultFields(item, projectedItem, budget);
  } else {
    const aggregatedOutput = asTrimmedString(item.aggregatedOutput);
    if (aggregatedOutput) {
      const summary = summarizeToolTextOutput(aggregatedOutput);
      if (summary) {
        projectedItem.aggregatedOutput = summary;
      }
    }
  }

  return Object.keys(projectedItem).length > 0 ? projectedItem : undefined;
}

function projectCommandValue(data: Record<string, unknown>): unknown {
  if (data.command !== undefined) {
    return data.command;
  }

  const input = asRecord(data.input);
  if (input?.command !== undefined) {
    return input.command;
  }

  const stateInput = asRecord(asRecord(data.state)?.input);
  if (stateInput?.command !== undefined) {
    return stateInput.command;
  }

  return undefined;
}

function projectViewedImagePath(data: Record<string, unknown>): string | undefined {
  const directPath = asTrimmedString(data.imagePath);
  if (directPath && isWorkspaceImagePreviewPath(directPath)) {
    return directPath;
  }

  const toolName = asTrimmedString(data.toolName)?.toLowerCase();
  if (toolName !== "read" && toolName !== "read file") {
    return undefined;
  }
  const input = asRecord(data.input);
  const inputPath = asTrimmedString(input?.file_path) ?? asTrimmedString(input?.path);
  return inputPath && isWorkspaceImagePreviewPath(inputPath) ? inputPath : undefined;
}

function summarizeToolTextOutput(value: string): string | null {
  const lines: string[] = [];
  for (const rawLine of value.split(/\r?\n/u)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (line.length > 0) {
      lines.push(line);
    }
  }

  const firstLine = lines.find((line) => line !== "```");
  if (firstLine) {
    return firstLine.length <= 84 ? firstLine : `${firstLine.slice(0, 83).trimEnd()}…`;
  }
  if (lines.length > 1) {
    return `${lines.length.toLocaleString()} lines`;
  }
  return null;
}

/**
 * Fields of an MCP tool-call item both clients render in the expanded
 * work-log row. Everything else — notably `result`, which carries the full
 * tool output and dominates wire size on MCP-heavy threads — is summarized
 * or dropped. Full payloads remain in persistence.
 */
const MCP_ITEM_KEPT_FIELDS = [
  "type",
  "id",
  "tool",
  "server",
  "status",
  "arguments",
  "appContext",
  "error",
  "durationMs",
] as const;

/**
 * Pulls renderable text out of an MCP tool result: either a Codex-style
 * `{content: [{type: "text", text}, ...]}` record or a raw Claude
 * `tool_result` block whose `content` is a string or block array.
 */
function extractMcpResultText(result: unknown): string | null {
  const record = asRecord(result);
  if (!record) {
    return typeof result === "string" ? result : null;
  }
  if (typeof record.content === "string") {
    return record.content;
  }
  if (Array.isArray(record.content)) {
    const texts: string[] = [];
    for (const entry of record.content) {
      const text = asRecord(entry)?.text;
      if (typeof text === "string" && text.trim().length > 0) {
        texts.push(text);
      }
    }
    if (texts.length > 0) {
      return texts.join("\n");
    }
  }
  return null;
}

function summarizeMcpResult(result: unknown): Record<string, unknown> | undefined {
  if (result === undefined || result === null) {
    return undefined;
  }
  const text = extractMcpResultText(result);
  const summary = text ? summarizeToolTextOutput(text) : null;
  return summary ? { content: summary } : undefined;
}

/**
 * MCP tool calls carry full tool results (`data.item.result` on Codex,
 * `data.result` on Claude/OpenCode) that used to bypass slimming entirely to
 * keep the expanded-row UI working. Keep the fields the UI actually renders
 * and summarize the result like regular tool output.
 */
function projectMcpToolCallData(data: Record<string, unknown>): Record<string, unknown> {
  const projectedData: Record<string, unknown> = {};

  const item = asRecord(data.item);
  if (item) {
    const projectedItem: Record<string, unknown> = {};
    for (const key of MCP_ITEM_KEPT_FIELDS) {
      if (key in item) {
        projectedItem[key] = item[key];
      }
    }
    const result = summarizeMcpResult(item.result);
    if (result) {
      projectedItem.result = result;
    }
    projectedData.item = projectedItem;
  }

  if ("toolName" in data) {
    projectedData.toolName = data.toolName;
  }
  if ("input" in data) {
    projectedData.input = data.input;
  }
  if (!item) {
    const result = summarizeMcpResult(data.result);
    if (result) {
      projectedData.result = result;
    }
  }

  if ("toolCallId" in data) {
    projectedData.toolCallId = data.toolCallId;
  }
  if ("kind" in data) {
    projectedData.kind = data.kind;
  }

  const fileDetails: ProjectedFileDetails = {
    changedFiles: [],
    seenChangedFiles: new Set<string>(),
    patches: [],
    seenPatches: new Set<string>(),
    preservePatches: false,
  };
  collectProjectedFileDetails(data, fileDetails, 0);
  if (fileDetails.changedFiles.length > 0) {
    projectedData.files = fileDetails.changedFiles.map((path) => ({ path }));
  }

  return projectedData;
}

function projectRawOutput(
  value: unknown,
  preserveCommandDetails: boolean,
  budget: CommandTextBudget,
): Record<string, unknown> | undefined {
  const direct = asTrimmedString(value);
  if (direct) {
    const content = preserveCommandDetails
      ? boundedCommandText(value as string, budget)
      : summarizeToolTextOutput(direct);
    return content ? { content } : undefined;
  }

  const rawOutput = asRecord(value);
  if (!rawOutput) {
    return undefined;
  }

  if (preserveCommandDetails) {
    const projected: Record<string, unknown> = {};
    copyCommandResultFields(rawOutput, projected, budget);
    if (typeof rawOutput.totalFiles === "number" && Number.isFinite(rawOutput.totalFiles)) {
      projected.totalFiles = rawOutput.totalFiles;
    }
    if (rawOutput.truncated === true) {
      projected.truncated = true;
    }
    return Object.keys(projected).length > 0 ? projected : undefined;
  }

  if (typeof rawOutput.totalFiles === "number" && Number.isFinite(rawOutput.totalFiles)) {
    return {
      totalFiles: rawOutput.totalFiles,
      ...(rawOutput.truncated === true ? { truncated: true } : {}),
    };
  }

  const content = asTrimmedString(rawOutput.content);
  if (content) {
    const summary = summarizeToolTextOutput(content);
    return summary ? { content: summary } : undefined;
  }

  const stdout = asTrimmedString(rawOutput.stdout);
  if (stdout) {
    const summary = summarizeToolTextOutput(stdout);
    return summary ? { content: summary } : undefined;
  }

  const stderr = asTrimmedString(rawOutput.stderr);
  if (stderr) {
    const summary = summarizeToolTextOutput(stderr);
    return summary ? { content: summary } : undefined;
  }

  return undefined;
}

function changeKindFromRecord(record: Record<string, unknown>): string | null {
  if (typeof record.kind === "string") {
    return asTrimmedString(record.kind)?.toLowerCase() ?? null;
  }
  return asTrimmedString(asRecord(record.kind)?.type)?.toLowerCase() ?? null;
}

function isProjectablePatch(record: Record<string, unknown>, value: string): boolean {
  if (value.length > WORK_LOG_ACTIVITY_LIMITS.maxPatchChars) {
    return false;
  }
  if (looksLikeUnifiedDiff(value)) {
    return true;
  }
  const changeKind = changeKindFromRecord(record);
  return changeKind === "add" || changeKind === "delete";
}

function patchIdentity(record: Record<string, unknown>, patch: string): string {
  if (patch.startsWith("diff --git ") || patch.startsWith("--- ")) {
    return patch;
  }
  const path = WORK_LOG_PATH_KEYS.map((key) => asTrimmedString(record[key])).find(
    (candidate) => candidate !== null,
  );
  return `${changeKindFromRecord(record) ?? ""}\0${path ?? ""}\0${patch}`;
}

interface ProjectedFileDetails {
  readonly changedFiles: string[];
  readonly seenChangedFiles: Set<string>;
  readonly patches: Array<Record<string, unknown>>;
  readonly seenPatches: Set<string>;
  readonly preservePatches: boolean;
}

function pushChangedFile(details: ProjectedFileDetails, value: unknown): void {
  const normalized = asTrimmedString(value);
  if (!normalized || details.seenChangedFiles.has(normalized)) {
    return;
  }
  details.seenChangedFiles.add(normalized);
  details.changedFiles.push(normalized);
}

function reachedFileDetailLimits(details: ProjectedFileDetails): boolean {
  return (
    details.changedFiles.length >= WORK_LOG_ACTIVITY_LIMITS.maxChangedFiles &&
    (!details.preservePatches || details.patches.length >= WORK_LOG_ACTIVITY_LIMITS.maxPatches)
  );
}

function collectProjectedFileDetails(
  value: unknown,
  details: ProjectedFileDetails,
  depth: number,
): void {
  if (depth > WORK_LOG_ACTIVITY_LIMITS.maxSearchDepth || reachedFileDetailLimits(details)) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectProjectedFileDetails(entry, details, depth + 1);
      if (reachedFileDetailLimits(details)) {
        return;
      }
    }
    return;
  }

  const record = asRecord(value);
  if (!record) {
    return;
  }

  if (details.changedFiles.length < WORK_LOG_ACTIVITY_LIMITS.maxChangedFiles) {
    for (const key of WORK_LOG_PATH_KEYS) {
      pushChangedFile(details, record[key]);
      if (details.changedFiles.length >= WORK_LOG_ACTIVITY_LIMITS.maxChangedFiles) {
        break;
      }
    }
  }

  if (details.preservePatches && details.patches.length < WORK_LOG_ACTIVITY_LIMITS.maxPatches) {
    for (const key of WORK_LOG_PATCH_KEYS) {
      const patch = typeof record[key] === "string" ? record[key] : null;
      const identity = patch ? patchIdentity(record, patch) : null;
      if (
        !patch ||
        !identity ||
        details.seenPatches.has(identity) ||
        !isProjectablePatch(record, patch)
      ) {
        continue;
      }
      details.seenPatches.add(identity);
      const projected: Record<string, unknown> = { [key]: patch };
      for (const pathKey of WORK_LOG_PATH_KEYS) {
        const path = asTrimmedString(record[pathKey]);
        if (path) {
          projected[pathKey] = path;
        }
      }
      const kind = changeKindFromRecord(record);
      if (kind) {
        projected.kind = kind;
      }
      details.patches.push(projected);
      if (details.patches.length >= WORK_LOG_ACTIVITY_LIMITS.maxPatches) {
        break;
      }
    }
  }

  for (const nestedKey of WORK_LOG_PATCH_CONTAINER_KEYS) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectProjectedFileDetails(record[nestedKey], details, depth + 1);
    if (reachedFileDetailLimits(details)) {
      return;
    }
  }
}

function hasCommandValue(value: unknown): boolean {
  if (asTrimmedString(value)) {
    return true;
  }
  return (
    Array.isArray(value) &&
    value.some((entry) => typeof entry === "string" && entry.trim().length > 0)
  );
}

function projectAcpContent(
  value: unknown,
  preserveCommandDetails: boolean,
  budget: CommandTextBudget,
): Record<string, unknown> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const text = value
    .map((entryValue) => {
      const entry = asRecord(entryValue);
      const content = asRecord(entry?.content);
      return entry?.type === "content" && content?.type === "text"
        ? asTrimmedString(content.text)
        : null;
    })
    .filter((entry): entry is string => entry !== null)
    .join("\n");
  const content = preserveCommandDetails
    ? boundedCommandText(text, budget)
    : summarizeToolTextOutput(text);
  return content ? { content } : undefined;
}

export interface ActivityPayloadProjectionOptions {
  readonly preserveCommandDetails?: boolean;
}

/**
 * Removes activity payload fields that no current client reads. Command
 * activities retain bounded result details by default; callers persisting
 * cumulative non-terminal updates can request a summary-only projection to
 * avoid quadratic storage growth.
 */
export function projectActivityPayload(
  activity: OrchestrationThreadActivity,
  options: ActivityPayloadProjectionOptions = {},
): OrchestrationThreadActivity {
  const payload = asRecord(activity.payload);
  const data = asRecord(payload?.data);
  if (!payload || !data) {
    return activity;
  }

  const dataKind = changeKindFromRecord(data);
  const preserveFileDetails =
    payload.itemType === "file_change" ||
    payload.requestKind === "file-change" ||
    dataKind === "edit" ||
    dataKind === "move" ||
    dataKind === "delete" ||
    dataKind === "write";
  const preserveCommandDetails =
    options.preserveCommandDetails !== false &&
    !preserveFileDetails &&
    (payload.itemType === "command_execution" ||
      payload.requestKind === "command" ||
      dataKind === "execute" ||
      (payload.itemType === "dynamic_tool_call" && hasCommandValue(data.command)));
  const commandTextBudget: CommandTextBudget = {
    remaining: WORK_LOG_ACTIVITY_LIMITS.maxCommandOutputChars,
    truncated: false,
  };
  const itemStatus = asRecord(data.item)?.status;
  const projectedPayload =
    payload.status === "completed" && (itemStatus === "failed" || itemStatus === "declined")
      ? { ...payload, status: itemStatus }
      : payload;

  if (payload.itemType === "mcp_tool_call") {
    return {
      ...activity,
      payload: {
        ...projectedPayload,
        data: projectMcpToolCallData(data),
      },
    };
  }
  const projectedData: Record<string, unknown> = {};
  let rawOutput =
    projectRawOutput(data.rawOutput, preserveCommandDetails, commandTextBudget) ??
    projectAcpContent(data.content, preserveCommandDetails, commandTextBudget);
  const item = projectCommandData(data, preserveCommandDetails, commandTextBudget);
  if (item) {
    projectedData.item = item;
  }
  const command = projectCommandValue(data);
  if (command !== undefined) {
    projectedData.command = command;
  }
  const imagePath = projectViewedImagePath(data);
  if (imagePath) {
    projectedData.imagePath = imagePath;
  }
  if (preserveCommandDetails) {
    copyCommandResultFields(data, projectedData, commandTextBudget);
  }

  const fileDetails: ProjectedFileDetails = {
    changedFiles: [],
    seenChangedFiles: new Set<string>(),
    patches: [],
    seenPatches: new Set<string>(),
    preservePatches: preserveFileDetails || !preserveCommandDetails,
  };
  collectProjectedFileDetails(data, fileDetails, 0);
  if (fileDetails.changedFiles.length > 0) {
    // Both clients discover file names by walking objects with path-like keys.
    projectedData.files = fileDetails.changedFiles.map((path) => ({ path }));
  }

  if ("toolCallId" in data) {
    projectedData.toolCallId = data.toolCallId;
  }
  if (dataKind) {
    projectedData.kind = dataKind;
  }

  if (commandTextBudget.truncated) {
    rawOutput ??= {};
    rawOutput.truncated = true;
  }
  if (rawOutput) {
    projectedData.rawOutput = rawOutput;
  }

  if (fileDetails.patches.length > 0) {
    projectedData.changes = fileDetails.patches;
  }

  return {
    ...activity,
    payload: {
      ...projectedPayload,
      data: projectedData,
    },
  };
}

/**
 * Matches the validity rule in the web client's
 * `deriveLatestContextWindowSnapshot`: rows without a finite, non-negative
 * `usedTokens` are skipped during its backward walk, so they must not shadow
 * an earlier resolvable row here.
 */
function isResolvableContextWindowActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "context-window.updated") {
    return false;
  }
  const payload = asRecord(activity.payload);
  const usedTokens = payload?.usedTokens;
  return typeof usedTokens === "number" && Number.isFinite(usedTokens) && usedTokens >= 0;
}

/**
 * Drops all but the last resolvable context-window activity per turn from a
 * snapshot. Clients only ever read the latest usage value (walking the array
 * backwards), so shipping the full history — often thousands of rows on long
 * threads — buys nothing. Retention is per turn rather than per thread because
 * a live `thread.reverted` makes the client discard whole turns; keeping each
 * turn's latest row means the meter can still resolve a value from the turns
 * that survive. Malformed rows pass through untouched rather than shadowing a
 * valid earlier row. Live `thread.activity-appended` events are untouched:
 * newer updates still stream through and supersede the retained rows on the
 * client.
 */
function dropStaleContextWindowActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OrchestrationThreadActivity> {
  const latestIndexByTurn = new Map<string | null, number>();
  for (let index = 0; index < activities.length; index += 1) {
    if (isResolvableContextWindowActivity(activities[index]!)) {
      latestIndexByTurn.set(activities[index]!.turnId, index);
    }
  }
  if (latestIndexByTurn.size === 0) {
    return activities;
  }
  return activities.filter(
    (activity, index) =>
      !isResolvableContextWindowActivity(activity) ||
      latestIndexByTurn.get(activity.turnId) === index,
  );
}

/**
 * Identity used to retain only the newest lifecycle row for each call in a
 * thread snapshot. Prefer the runtime item id, then the legacy nested id, and
 * finally the itemType/title/detail triple. Rows without any identity remain
 * untouched.
 */
function toolLifecycleIdentity(activity: OrchestrationThreadActivity): string | null {
  const payload = asRecord(activity.payload);
  if (!payload) {
    return null;
  }

  const toolCallId =
    asTrimmedString(payload.toolCallId) ?? asTrimmedString(asRecord(payload.data)?.toolCallId);
  if (toolCallId) {
    return `id:${toolCallId}`;
  }

  const itemType = asTrimmedString(payload.itemType) ?? "";
  // Mirrors the clients' `normalizeCompactToolLabel`: a completion's title may
  // gain a trailing "complete"/"completed" the in-flight updates lack.
  const label = (asTrimmedString(payload.title) ?? activity.summary)
    .replace(/\s+(?:complete|completed)\s*$/iu, "")
    .trim();
  const detail = asTrimmedString(payload.detail) ?? "";
  if (itemType.length === 0 && label.length === 0 && detail.length === 0) {
    return null;
  }
  return [itemType, label, detail].join("");
}

interface ProjectedCumulativeDetails {
  readonly outputsByKey: Map<string, string[]>;
  readonly numberCategories: Set<"duration" | "exitCode">;
  readonly patches: string[];
  readonly paths: Set<string>;
}

const cumulativeCommandTextKeys = new Set<string>([
  ...WORK_LOG_COMMAND_RESULT_TEXT_KEYS,
  ...WORK_LOG_COMMAND_ITEM_CONTENT_KEYS,
]);
const cumulativeExitCodeKeys = new Set<string>(WORK_LOG_COMMAND_EXIT_CODE_KEYS);
const cumulativeDurationKeys = new Set<string>([
  ...WORK_LOG_COMMAND_DURATION_MS_KEYS,
  ...WORK_LOG_COMMAND_ELAPSED_SECONDS_KEYS,
]);
const cumulativePatchKeys = new Set<string>(WORK_LOG_PATCH_KEYS);
const cumulativePathKeys = new Set<string>(WORK_LOG_PATH_KEYS);

function collectProjectedCumulativeDetails(
  value: unknown,
  details: ProjectedCumulativeDetails,
  depth = 0,
  seen = new WeakSet<object>(),
): void {
  if (depth > WORK_LOG_ACTIVITY_LIMITS.maxSearchDepth + 2 || value === null) {
    return;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return;
    seen.add(value);
    for (const entry of value) {
      collectProjectedCumulativeDetails(entry, details, depth + 1, seen);
    }
    return;
  }
  const record = asRecord(value);
  if (!record || seen.has(record)) {
    return;
  }
  seen.add(record);

  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === "number" && Number.isFinite(entry)) {
      if (cumulativeExitCodeKeys.has(key) && Number.isInteger(entry)) {
        details.numberCategories.add("exitCode");
      }
      if (cumulativeDurationKeys.has(key)) {
        details.numberCategories.add("duration");
      }
      continue;
    }
    if (typeof entry === "string") {
      if (cumulativeCommandTextKeys.has(key)) {
        const outputs = details.outputsByKey.get(key);
        if (outputs) outputs.push(entry);
        else details.outputsByKey.set(key, [entry]);
      }
      if (cumulativePatchKeys.has(key) && looksLikeUnifiedDiff(entry)) {
        details.patches.push(entry.trim());
      }
      if (cumulativePathKeys.has(key) && entry.trim().length > 0) {
        details.paths.add(entry.trim());
      }
      continue;
    }
    collectProjectedCumulativeDetails(entry, details, depth + 1, seen);
  }
}

function projectedCumulativeDetails(activity: OrchestrationThreadActivity) {
  const details: ProjectedCumulativeDetails = {
    outputsByKey: new Map(),
    numberCategories: new Set(),
    patches: [],
    paths: new Set(),
  };
  collectProjectedCumulativeDetails(activity.payload, details);
  return details;
}

function completionCoversProjectedUpdate(
  update: OrchestrationThreadActivity,
  completion: OrchestrationThreadActivity,
): boolean {
  const updateDetails = projectedCumulativeDetails(update);
  const completionDetails = projectedCumulativeDetails(completion);

  for (const [key, updateOutputs] of updateDetails.outputsByKey) {
    const completionOutputs = completionDetails.outputsByKey.get(key) ?? [];
    if (
      !updateOutputs.every((output) => completionOutputs.some((next) => next.startsWith(output)))
    ) {
      return false;
    }
  }
  for (const category of updateDetails.numberCategories) {
    if (!completionDetails.numberCategories.has(category)) {
      return false;
    }
  }
  if (
    !updateDetails.patches.every((patch) =>
      completionDetails.patches.some((next) => next.startsWith(patch)),
    )
  ) {
    return false;
  }
  for (const path of updateDetails.paths) {
    if (!completionDetails.paths.has(path)) {
      return false;
    }
  }
  return true;
}

/**
 * Drops `tool.updated` rows a later `tool.completed` row supersedes without
 * removing bounded command output, result numbers, patches, or changed paths
 * that the clients merge cumulatively. Projection runs first, so this comparison
 * covers exactly the activity details a snapshot would transfer. Updates with a
 * contribution missing from the completion remain available for client-side
 * merging.
 *
 * Matching is per turn for the same reason `dropStaleContextWindowActivities`
 * retains per turn: a live `thread.reverted` makes the client discard whole
 * turns, so a completion in a different turn could vanish and leave the
 * dropped update unrepresented. The completion must also come *after* the
 * update within the turn — a later update belongs to a subsequent call that
 * reuses the same identity and is still in flight. Rows without a lifecycle
 * identity pass through, matching the clients, which never collapse them.
 * Live `thread.activity-appended` events are untouched: updates still stream
 * in real time and the completion supersedes them on the client as before.
 *
 * Deliberate divergence from client collapse: clients fold only *adjacent*
 * lifecycle rows, so a superseded update separated from its completion by an
 * interleaved parallel call renders as its own row today, and this drop
 * removes it. Measured against a real database, that affects 1.5% of dropped
 * rows (553 of 36,581). Dropping only updates whose projected cumulative
 * details are present in the completion keeps the transfer reduction for
 * pure in-flight state without assuming every provider completion is a full
 * command-output or patch superset.
 */
function dropSupersededToolUpdatedActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OrchestrationThreadActivity> {
  const completionIndicesByKey = new Map<string, number[]>();
  for (let index = 0; index < activities.length; index += 1) {
    const activity = activities[index]!;
    if (activity.kind !== "tool.completed") {
      continue;
    }
    const identity = toolLifecycleIdentity(activity);
    if (!identity) {
      continue;
    }
    const key = `${activity.turnId ?? ""} ${identity}`;
    const indices = completionIndicesByKey.get(key);
    if (indices) {
      indices.push(index);
    } else {
      completionIndicesByKey.set(key, [index]);
    }
  }
  if (completionIndicesByKey.size === 0) {
    return activities;
  }

  return activities.filter((activity, index) => {
    if (activity.kind !== "tool.updated") {
      return true;
    }
    const identity = toolLifecycleIdentity(activity);
    if (!identity) {
      return true;
    }
    const indices = completionIndicesByKey.get(`${activity.turnId ?? ""} ${identity}`);
    const completionIndex = indices?.find((candidateIndex) => candidateIndex > index);
    return (
      completionIndex === undefined ||
      !completionCoversProjectedUpdate(activity, activities[completionIndex]!)
    );
  });
}

export function projectThreadDetailSnapshot(
  snapshot: OrchestrationThreadDetailSnapshot,
): OrchestrationThreadDetailSnapshot {
  return {
    ...snapshot,
    thread: {
      ...snapshot.thread,
      activities: dropSupersededToolUpdatedActivities(
        dropStaleContextWindowActivities(snapshot.thread.activities).map((activity) =>
          projectActivityPayload(activity),
        ),
      ),
    },
  };
}

export function projectActivityEvent(event: OrchestrationEvent): OrchestrationEvent {
  if (event.type !== "thread.activity-appended") {
    return event;
  }
  return {
    ...event,
    payload: {
      ...event.payload,
      activity: projectActivityPayload(event.payload.activity),
    },
  };
}
