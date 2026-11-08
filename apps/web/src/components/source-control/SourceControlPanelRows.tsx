import { SourceControlVirtualList } from "./SourceControlVirtualList";
import type { VcsPanelFileChange } from "@t3tools/contracts";
import { FileDiff, useWorkerPool } from "@pierre/diffs/react";
import type { ComponentProps, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useSyncExternalStore } from "react";

import { getRenderablePatch, resolveDiffThemeName } from "~/lib/diffRendering";
import { Button } from "../ui/button";

import { COMMIT_PAGE_SIZE, sumFiles } from "./SourceControlPanelModel";
import { FileChangeTooltipRow, StatLabels } from "./SourceControlPanelPrimitives";

export function FileChangeSummary({ files }: { readonly files: readonly VcsPanelFileChange[] }) {
  const stats = sumFiles(files);
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-xs text-secondary-label">
      <span>{files.length === 1 ? "1 file" : `${files.length} files`}</span>
      <StatLabels insertions={stats.insertions} deletions={stats.deletions} />
    </span>
  );
}

export function FileChangeList({
  files,
  emptyLabel,
  onFileContextMenu,
  getFileKey,
  isFileExpanded,
  onFileToggle,
  renderExpandedFile,
  onOpenFile,
  onOpenInVsCode,
}: {
  readonly files: readonly VcsPanelFileChange[];
  readonly emptyLabel: string;
  readonly onFileContextMenu?: (
    event: ReactMouseEvent<HTMLDivElement>,
    file: VcsPanelFileChange,
  ) => void;
  readonly getFileKey?: (file: VcsPanelFileChange) => string;
  readonly isFileExpanded?: (file: VcsPanelFileChange) => boolean;
  readonly onFileToggle?: (file: VcsPanelFileChange) => void;
  readonly renderExpandedFile?: (file: VcsPanelFileChange) => ReactNode;
  readonly onOpenFile?: (file: VcsPanelFileChange) => void;
  readonly onOpenInVsCode?: (file: VcsPanelFileChange) => void;
}) {
  if (files.length === 0) {
    return <div className="px-3 py-1 text-xs text-muted-foreground">{emptyLabel}</div>;
  }
  return (
    <SourceControlVirtualList
      items={files}
      getKey={(file) => getFileKey?.(file) ?? `${file.path}:${file.status}`}
      renderItem={(file) => {
        const fileKey = getFileKey?.(file) ?? `${file.path}:${file.status}`;
        const expanded = isFileExpanded?.(file) ?? false;
        return (
          <div key={fileKey} className="space-y-0.5">
            <FileChangeTooltipRow
              expanded={expanded}
              file={file}
              onFileContextMenu={onFileContextMenu}
              onFileToggle={onFileToggle}
              onOpenFile={onOpenFile}
              onOpenInVsCode={onOpenInVsCode}
            />
            {expanded && renderExpandedFile ? (
              <div className="ml-4 border-l border-border/60 pl-1">{renderExpandedFile(file)}</div>
            ) : null}
          </div>
        );
      }}
    />
  );
}

export function LoadMoreCommitsButton({
  remaining,
  loading,
  onClick,
}: {
  readonly remaining: number;
  readonly loading: boolean;
  readonly onClick: () => void;
}) {
  if (remaining <= 0) return null;
  return (
    <Button size="xs" variant="ghost-muted" className="w-full" disabled={loading} onClick={onClick}>
      {loading
        ? "Loading..."
        : `Load ${Math.min(COMMIT_PAGE_SIZE, remaining)} more of ${remaining} remaining`}
    </Button>
  );
}

export function InlineFileDiff({
  patch,
  resolvedTheme,
}: {
  readonly patch: string;
  readonly resolvedTheme: "light" | "dark";
}) {
  const renderablePatch = (() => getRenderablePatch(patch, `vcs-panel-file:${resolvedTheme}`))();
  if (!renderablePatch) {
    return <div className="px-2 py-1 text-xs text-muted-foreground">No diff.</div>;
  }
  if (renderablePatch.kind === "raw") {
    return (
      <pre className="max-h-80 overflow-auto rounded bg-muted/40 p-2 text-xs">
        {renderablePatch.text}
      </pre>
    );
  }
  return (
    <div className="diff-render-surface max-h-96 overflow-auto rounded border border-border/60 bg-background/60">
      {renderablePatch.files.map((fileDiff) => (
        <WorkerRefreshedFileDiff
          key={fileDiff.cacheKey ?? `${fileDiff.prevName ?? "none"}:${fileDiff.name ?? "none"}`}
          fileDiff={fileDiff}
          options={{
            collapsed: false,
            diffStyle: "unified",
            theme: resolveDiffThemeName(resolvedTheme),
          }}
        />
      ))}
    </div>
  );
}

function WorkerRefreshedFileDiff(props: ComponentProps<typeof FileDiff>) {
  const workerPool = useWorkerPool();
  const subscribe = (listener: () => void) =>
    workerPool?.subscribeToStatChanges(listener) ?? (() => {});
  const getSnapshot = () => workerPool?.getDiffResultCache(props.fileDiff) !== undefined;
  const highlightCached = useSyncExternalStore(subscribe, getSnapshot, () => false);
  const renderKey = props.fileDiff.cacheKey
    ? `${props.fileDiff.cacheKey}:${highlightCached ? "highlighted" : "pending"}`
    : undefined;
  return <FileDiff {...props} key={renderKey} />;
}
