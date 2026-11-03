import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { Button } from "../../components/ui/Button";
import { LegendList } from "@legendapp/list/react-native";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type EnvironmentMachineKind,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import type { MenuAction, NativeActionEvent } from "@react-native-menu/menu";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { IconButton } from "../../components/ui/IconButton";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { Notice } from "../../components/ui/Notice";
import { RowPressable } from "../../components/ui/RowPressable";
import { AppBar } from "../../components/ui/AppBar";
import { SettingsScreenContent } from "../settings/components/SettingsScreen";
import { SymbolView } from "../../components/ui/AppSymbol";
import { useNavigation } from "@react-navigation/native";
import { useCallback, useMemo, useRef, useState, type ComponentProps } from "react";
import { Platform, Pressable, useWindowDimensions, View } from "react-native";
import { RefreshControl } from "../../components/ui/RefreshControl";
import { GestureDetector, useNativeGesture } from "react-native-gesture-handler";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";

import { AppText as Text } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { EmptyState } from "../../components/ui/EmptyState";
import {
  ENVIRONMENT_MACHINE_SYMBOLS,
  EnvironmentMachineSymbol,
} from "../../components/EnvironmentMachineSymbol";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { useNowMinuteMs } from "../../lib/clock";
import { relativeTime } from "../../lib/time";
import { MOBILE_SHAPE } from "../../lib/designTokens";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useServerConfigs } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { ThreadSwipeable } from "../home/thread-swipe-actions";
import {
  archivedThreadActionKey,
  archivedThreadTimestampValue,
  nextArchivedThreadSortState,
  type ArchivedThreadGroup,
  type ArchivedThreadSortField,
  type ArchivedThreadSortState,
} from "./archivedThreadList";

export interface ArchivedThreadsHeaderEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

type ArchivedThreadListItem =
  | {
      readonly kind: "project";
      readonly key: string;
      readonly environmentLabel: string | null;
      readonly environmentMachine: EnvironmentMachineKind;
      readonly expanded: boolean;
      readonly group: ArchivedThreadGroup;
      readonly isSearching: boolean;
      readonly isReserved: boolean;
      readonly isBusy: boolean;
    }
  | {
      readonly kind: "thread";
      readonly key: string;
      readonly environmentLabel: string | null;
      readonly isLast: boolean;
      readonly thread: EnvironmentThreadShell;
    };

function ArchivedThreadsHeader(props: {
  readonly environments: ReadonlyArray<ArchivedThreadsHeaderEnvironment>;
  readonly searchQuery: string;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly sort: ArchivedThreadSortState;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onRefresh: () => void;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onSortChange: (sort: ArchivedThreadSortState) => void;
}) {
  const navigation = useNavigation();
  const { width } = useWindowDimensions();
  const serverConfigs = useServerConfigs();
  const hasCustomFilter =
    props.selectedEnvironmentId !== null ||
    props.sort.field !== "archivedAt" ||
    props.sort.direction !== "desc";
  return (
    <AppBar
      title="Archived threads"
      onBack={() => navigation.goBack()}
      search={{
        value: props.searchQuery,
        onChangeText: props.onSearchQueryChange,
        placeholder: "Search archived threads",
        compactPlaceholder: "Search",
        mode: "inline",
        compactToolbar: width < 700,
      }}
      menus={[
        {
          title: "Archived thread options",
          icon: hasCustomFilter
            ? "line.3.horizontal.decrease.circle.fill"
            : "line.3.horizontal.decrease.circle",
          items: [
            {
              id: "environment",
              title: "Environment",
              items: [
                {
                  id: "environment:all",
                  title: "All environments",
                  selected: props.selectedEnvironmentId === null,
                  onPress: () => props.onEnvironmentChange(null),
                },
                ...props.environments.map((environment) => ({
                  id: `environment:${environment.environmentId}`,
                  title: environment.label,
                  icon: ENVIRONMENT_MACHINE_SYMBOLS[
                    resolveEnvironmentMachineKind(
                      serverConfigs.get(environment.environmentId) ?? null,
                    )
                  ],
                  selected: props.selectedEnvironmentId === environment.environmentId,
                  onPress: () => props.onEnvironmentChange(environment.environmentId),
                })),
              ],
            },
            {
              id: "sort",
              title: "Sort archived threads",
              items: (["archivedAt", "createdAt"] as const).flatMap((field) =>
                (["desc", "asc"] as const).map((direction) => ({
                  id: `sort:${field}:${direction}`,
                  title: `${field === "archivedAt" ? "Archived" : "Created"}: ${direction === "desc" ? "newest" : "oldest"} first`,
                  selected: props.sort.field === field && props.sort.direction === direction,
                  onPress: () => props.onSortChange({ field, direction }),
                })),
              ),
            },
            {
              id: "refresh",
              title: "Refresh archived threads",
              onPress: props.onRefresh,
            },
          ],
        },
      ]}
    />
  );
}

function ArchivedSortButton(props: {
  readonly field: ArchivedThreadSortField;
  readonly label: string;
  readonly sort: ArchivedThreadSortState;
  readonly onSortChange: (sort: ArchivedThreadSortState) => void;
}) {
  const active = props.sort.field === props.field;
  return (
    <RowPressable
      accessibilityLabel={`Sort by ${props.label}`}
      accessibilityRole="button"
      hitSlop={6}
      className="min-h-11 flex-row items-center gap-1 rounded-md px-2 py-2"
      onPress={() => props.onSortChange(nextArchivedThreadSortState(props.sort, props.field))}
    >
      <Text textRole="caption" className="font-t3-medium text-foreground-muted" numberOfLines={1}>
        {props.label}
      </Text>
      {active ? (
        <SymbolView
          name={props.sort.direction === "asc" ? "chevron.up" : "chevron.down"}
          size={9}
          tintColorClassName={"accent-icon-subtle"}
          type="monochrome"
        />
      ) : (
        <View className="w-[9px]" />
      )}
    </RowPressable>
  );
}

function ProjectGroupHeader(props: {
  readonly isFirst: boolean;
  readonly environmentLabel: string | null;
  readonly environmentMachine: EnvironmentMachineKind;
  readonly expanded: boolean;
  readonly group: ArchivedThreadGroup;
  readonly isBusy: boolean;
  readonly isReserved: boolean;
  readonly isSearching: boolean;
  readonly onProjectAction: (action: "unarchive" | "delete") => void;
  readonly onSortChange: (sort: ArchivedThreadSortState) => void;
  readonly onToggle: () => void;
  readonly sort: ArchivedThreadSortState;
}) {
  const canOperateProject = useEnvironmentScope(
    props.group.project.environmentId,
    AuthOrchestrationOperateScope,
  );
  const scopeLabel = props.isSearching ? "matching" : "all";
  const actions = useMemo<MenuAction[]>(
    () => [
      {
        id: "unarchive",
        title: `Unarchive ${scopeLabel}`,
        image: "arrow.uturn.backward",
      },
      {
        id: "delete",
        title: `Delete ${scopeLabel}`,
        image: "trash",
        attributes: { destructive: true },
      },
    ],
    [scopeLabel],
  );
  const groupRadius =
    Platform.OS === "android" ? MOBILE_SHAPE.group.android : MOBILE_SHAPE.group.ios;
  return (
    <View className={props.isFirst ? "pt-4" : "pt-6"}>
      <View
        className="overflow-hidden bg-grouped-card"
        style={{
          borderTopLeftRadius: groupRadius,
          borderTopRightRadius: groupRadius,
          borderBottomLeftRadius: props.expanded ? 0 : groupRadius,
          borderBottomRightRadius: props.expanded ? 0 : groupRadius,
        }}
      >
        <View className="flex-row items-center pr-2">
          <RowPressable
            accessibilityLabel={
              (props.expanded ? "Collapse " : "Expand ") + props.group.project.title
            }
            accessibilityRole="button"
            accessibilityState={{ expanded: props.expanded }}
            className="min-w-0 flex-1"
            disabled={props.isSearching}
            onPress={props.onToggle}
          >
            <ListRowLayout
              label={props.group.project.title}
              description={[
                props.group.threads.length +
                  " archived " +
                  (props.group.threads.length === 1 ? "thread" : "threads"),
                props.environmentLabel,
              ]
                .filter(Boolean)
                .join(" · ")}
              leading={
                <View className="size-6 items-center justify-center">
                  <ProjectFavicon
                    environmentId={props.group.project.environmentId}
                    faviconPath={props.group.project.faviconPath}
                    projectIcon={props.group.project.projectIcon}
                    projectTitle={props.group.project.title}
                    size={24}
                    workspaceRoot={props.group.project.workspaceRoot}
                  />
                </View>
              }
              accessory={
                <View className="flex-row items-center gap-2">
                  {props.environmentLabel ? (
                    <EnvironmentMachineSymbol
                      kind={props.environmentMachine}
                      size={14}
                      tintColorClassName="accent-icon-muted"
                    />
                  ) : null}
                  <SymbolView
                    name={props.expanded ? "chevron.down" : "chevron.right"}
                    size={14}
                    tintColorClassName="accent-icon-subtle"
                    type="monochrome"
                  />
                </View>
              }
            />
          </RowPressable>
          {props.isBusy ? (
            <Pressable
              accessibilityLabel={`Project actions for ${props.group.project.title}`}
              accessibilityRole="button"
              className="size-12 items-center justify-center"
              disabled
            >
              <AppActivityIndicator colorClassName="accent-icon-subtle" size="small" />
            </Pressable>
          ) : !canOperateProject || props.isReserved ? (
            <IconButton
              accessibilityLabel={`Project actions for ${props.group.project.title}`}
              icon="ellipsis"
              disabled
            />
          ) : (
            <Menu
              actions={actions}
              onPressAction={({ nativeEvent }: NativeActionEvent) => {
                if (nativeEvent.event === "unarchive" || nativeEvent.event === "delete") {
                  props.onProjectAction(nativeEvent.event);
                }
              }}
            >
              <IconButton
                accessibilityLabel={`Project actions for ${props.group.project.title}`}
                icon="ellipsis"
              />
            </Menu>
          )}
        </View>
        {props.expanded ? (
          <View className="flex-row flex-wrap items-center gap-2 px-4 pb-1">
            <Text textRole="footnote" className="mr-auto text-foreground-muted">
              Sort by
            </Text>
            <ArchivedSortButton
              field="archivedAt"
              label="Archived"
              onSortChange={props.onSortChange}
              sort={props.sort}
            />
            <ArchivedSortButton
              field="createdAt"
              label="Created"
              onSortChange={props.onSortChange}
              sort={props.sort}
            />
          </View>
        ) : null}
      </View>
    </View>
  );
}

function ArchivedThreadRow(props: {
  readonly environmentLabel: string | null;
  readonly isLast: boolean;
  readonly isBusy: boolean;
  readonly isReserved: boolean;
  readonly onDelete: () => void;
  readonly onSwipeableClose: (methods: SwipeableMethods) => void;
  readonly onSwipeableWillOpen: (methods: SwipeableMethods) => void;
  readonly simultaneousSwipeGesture?: ComponentProps<typeof ThreadSwipeable>["simultaneousWith"];
  readonly onUnarchive: () => void;
  readonly thread: EnvironmentThreadShell;
}) {
  const nowMs = useNowMinuteMs();
  const { width: windowWidth } = useWindowDimensions();
  const cardColor = useUniwindTheme()["--color-grouped-card"];
  const canOperateThread = useEnvironmentScope(
    props.thread.environmentId,
    AuthOrchestrationOperateScope,
  );
  const { onDelete, onUnarchive } = props;
  const archivedTimestamp = relativeTime(
    archivedThreadTimestampValue(props.thread, "archivedAt"),
    nowMs,
  );
  const createdTimestamp = relativeTime(props.thread.createdAt, nowMs);
  const subtitle = [props.environmentLabel, props.thread.branch].filter((part): part is string =>
    Boolean(part),
  );
  const isBlocked = !canOperateThread || props.isReserved || props.isBusy;
  const swipeDeleteAction = isBlocked ? () => undefined : onDelete;
  const menuActions = useMemo<MenuAction[]>(
    () => [
      { id: "unarchive", title: "Unarchive", image: "arrow.uturn.backward" },
      {
        id: "delete",
        title: "Delete",
        image: "trash",
        attributes: { destructive: true },
      },
    ],
    [],
  );
  const handleMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      if (nativeEvent.event === "unarchive") onUnarchive();
      if (nativeEvent.event === "delete") onDelete();
    },
    [onDelete, onUnarchive],
  );
  const rowContent = (
    <View className="border-t border-separator">
      <ListRowLayout
        label={props.thread.title}
        description={[
          subtitle.join(" · "),
          "Archived " + archivedTimestamp + " · Created " + createdTimestamp,
        ]
          .filter(Boolean)
          .join("\n")}
        accessory={
          props.isBusy ? (
            <AppActivityIndicator colorClassName="accent-icon-subtle" size="small" />
          ) : undefined
        }
      />
    </View>
  );
  const groupRadius =
    Platform.OS === "android" ? MOBILE_SHAPE.group.android : MOBILE_SHAPE.group.ios;
  const containerStyle = {
    borderBottomLeftRadius: props.isLast ? groupRadius : 0,
    borderBottomRightRadius: props.isLast ? groupRadius : 0,
    overflow: "hidden" as const,
  };
  const row = (
    <RowPressable className="bg-grouped-card" disabled={isBlocked}>
      {rowContent}
    </RowPressable>
  );
  if (!canOperateThread) return <View style={containerStyle}>{row}</View>;
  return (
    <ThreadSwipeable
      backgroundColor={cardColor}
      resetKey={JSON.stringify([props.thread.environmentId, props.thread.id])}
      threadKey={`${props.thread.environmentId}:${props.thread.id}`}
      // Round + clip the swipeable container so the group's corners stay
      // rounded while rows swipe; the row itself stays square inside.
      containerStyle={containerStyle}
      enabled={!isBlocked}
      fullSwipeWidth={windowWidth - 32}
      onDelete={swipeDeleteAction}
      onSwipeableClose={props.onSwipeableClose}
      onSwipeableWillOpen={props.onSwipeableWillOpen}
      primaryAction={{
        accessibilityLabel: `Unarchive ${props.thread.title}`,
        icon: "arrow.uturn.backward",
        label: "Unarchive",
        onPress: isBlocked ? () => undefined : onUnarchive,
      }}
      simultaneousWith={props.simultaneousSwipeGesture}
      threadTitle={props.thread.title}
    >
      {() =>
        isBlocked ? (
          row
        ) : (
          <Menu actions={menuActions} onPressAction={handleMenuAction} shouldOpenOnLongPress>
            {row}
          </Menu>
        )
      }
    </ThreadSwipeable>
  );
}

function ArchiveError(props: { readonly message: string; readonly onRetry: () => void }) {
  return (
    <View className="gap-3 pt-4">
      <Notice tone="danger" message={`Could not load every archive\n${props.message}`} />
      <Button label="Try again" tone="secondary" onPress={props.onRetry} />
    </View>
  );
}

export function ArchivedThreadsScreen(props: {
  readonly environments: ReadonlyArray<ArchivedThreadsHeaderEnvironment>;
  readonly error: string | null;
  readonly groups: ReadonlyArray<ArchivedThreadGroup>;
  readonly isLoading: boolean;
  readonly searchQuery: string;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly sort: ArchivedThreadSortState;
  readonly busyThreadKeys: ReadonlySet<string>;
  readonly reservedThreadKeys: ReadonlySet<string>;
  readonly onDeleteThread: (thread: EnvironmentThreadShell) => void;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onProjectAction: (
    projectTitle: string,
    threads: ReadonlyArray<EnvironmentThreadShell>,
    scope: "all" | "matching",
    action: "unarchive" | "delete",
  ) => void;
  readonly onRefresh: () => void;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onSortChange: (sort: ArchivedThreadSortState) => void;
  readonly onUnarchiveThread: (thread: EnvironmentThreadShell) => void;
}) {
  const {
    busyThreadKeys,
    onDeleteThread,
    onProjectAction,
    onSortChange,
    onUnarchiveThread,
    reservedThreadKeys,
    sort,
  } = props;
  const [expandedProjectKeys, setExpandedProjectKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const openSwipeableRef = useRef<SwipeableMethods | null>(null);
  const archiveScrollGesture = useNativeGesture();
  const environmentLabelsById = useMemo(
    () =>
      new Map(
        props.environments.map((environment) => [environment.environmentId, environment.label]),
      ),
    [props.environments],
  );
  const serverConfigs = useServerConfigs();
  const isSearching = props.searchQuery.trim().length > 0;
  const listItems = useMemo<ReadonlyArray<ArchivedThreadListItem>>(() => {
    const items: ArchivedThreadListItem[] = [];
    for (const group of props.groups) {
      const environmentLabel = environmentLabelsById.get(group.project.environmentId) ?? null;
      const expanded = isSearching || expandedProjectKeys.has(group.key);
      items.push({
        kind: "project",
        key: `${group.key}:project`,
        environmentLabel,
        environmentMachine: resolveEnvironmentMachineKind(
          serverConfigs.get(group.project.environmentId) ?? null,
        ),
        expanded,
        group,
        isSearching,
        isReserved: group.threads.some((thread) =>
          reservedThreadKeys.has(archivedThreadActionKey(thread)),
        ),
        isBusy: group.threads.some((thread) => busyThreadKeys.has(archivedThreadActionKey(thread))),
      });

      if (!expanded) continue;
      group.threads.forEach((thread, index) => {
        items.push({
          kind: "thread",
          key: archivedThreadActionKey(thread),
          environmentLabel,
          isLast: index === group.threads.length - 1,
          thread,
        });
      });
    }
    return items;
  }, [
    environmentLabelsById,
    expandedProjectKeys,
    isSearching,
    busyThreadKeys,
    props.groups,
    reservedThreadKeys,
    serverConfigs,
  ]);
  const toggleProject = useCallback((projectKey: string) => {
    setExpandedProjectKeys((current) => {
      const next = new Set(current);
      if (next.has(projectKey)) next.delete(projectKey);
      else next.add(projectKey);
      return next;
    });
  }, []);
  const handleSwipeableWillOpen = (methods: SwipeableMethods) => {
    if (openSwipeableRef.current && openSwipeableRef.current !== methods) {
      openSwipeableRef.current.close();
    }
    openSwipeableRef.current = methods;
  };
  const handleSwipeableClose = (methods: SwipeableMethods) => {
    if (openSwipeableRef.current === methods) {
      openSwipeableRef.current = null;
    }
  };
  const isInitialLoad = props.isLoading && props.groups.length === 0 && props.error === null;
  const isFiltered = props.searchQuery.trim().length > 0 || props.selectedEnvironmentId !== null;
  const renderListItem = ({ item }: { item: ArchivedThreadListItem }) => {
    if (item.kind === "project") {
      return (
        <ProjectGroupHeader
          isFirst={item.group.key === props.groups[0]?.key}
          environmentLabel={item.environmentLabel}
          environmentMachine={item.environmentMachine}
          expanded={item.expanded}
          group={item.group}
          isBusy={item.isBusy}
          isReserved={item.isReserved}
          isSearching={item.isSearching}
          onProjectAction={(action) =>
            onProjectAction(
              item.group.project.title,
              item.group.threads,
              item.isSearching ? "matching" : "all",
              action,
            )
          }
          onSortChange={onSortChange}
          onToggle={() => toggleProject(item.group.key)}
          sort={sort}
        />
      );
    }

    return (
      <ArchivedThreadRow
        environmentLabel={item.environmentLabel}
        isLast={item.isLast}
        isBusy={busyThreadKeys.has(archivedThreadActionKey(item.thread))}
        isReserved={reservedThreadKeys.has(archivedThreadActionKey(item.thread))}
        onDelete={() => onDeleteThread(item.thread)}
        onSwipeableClose={handleSwipeableClose}
        onSwipeableWillOpen={handleSwipeableWillOpen}
        onUnarchive={() => onUnarchiveThread(item.thread)}
        simultaneousSwipeGesture={archiveScrollGesture}
        thread={item.thread}
      />
    );
  };
  const listEmptyComponent = useMemo(() => {
    if (isInitialLoad) {
      return (
        <View className="items-center py-16">
          <AppActivityIndicator colorClassName="accent-icon" />
          <Text className="mt-3 text-sm text-foreground-muted">Loading archive...</Text>
        </View>
      );
    }

    return (
      <EmptyState
        detail={
          isFiltered
            ? "Try another search or environment."
            : "Threads you archive will appear here."
        }
        title={isFiltered ? "No matching threads" : "No archived threads"}
      />
    );
  }, [isFiltered, isInitialLoad]);

  return (
    // Without this native container, formSheet resizing mistakes the background for a header and collapses the list.
    <View collapsable={false} className="flex-1 bg-sheet">
      <ArchivedThreadsHeader
        environments={props.environments}
        searchQuery={props.searchQuery}
        onEnvironmentChange={props.onEnvironmentChange}
        onRefresh={props.onRefresh}
        onSearchQueryChange={props.onSearchQueryChange}
        onSortChange={props.onSortChange}
        selectedEnvironmentId={props.selectedEnvironmentId}
        sort={props.sort}
      />

      <SettingsScreenContent>
        <GestureDetector gesture={archiveScrollGesture}>
          <LegendList
            renderScrollComponent={NativeScrollView}
            style={{ flex: 1 }}
            contentContainerStyle={{
              paddingBottom: 32,
              paddingHorizontal: 20,
              paddingTop: 0,
              width: "100%",
              maxWidth: Platform.OS === "android" ? 720 : undefined,
              alignSelf: "center",
            }}
            contentInsetAdjustmentBehavior="automatic"
            data={listItems}
            extraData={props.searchQuery}
            estimatedItemSize={62}
            getItemType={(item) => item.kind}
            keyboardDismissMode="on-drag"
            keyboardShouldPersistTaps="handled"
            keyExtractor={(item) => item.key}
            ListEmptyComponent={listEmptyComponent}
            ListHeaderComponent={
              props.error ? <ArchiveError message={props.error} onRetry={props.onRefresh} /> : null
            }
            onScrollBeginDrag={() => openSwipeableRef.current?.close()}
            refreshControl={
              <RefreshControl
                onRefresh={props.onRefresh}
                refreshing={props.isLoading && !isInitialLoad}
                tintColorClassName={String("accent-icon")}
              />
            }
            renderItem={renderListItem}
            showsVerticalScrollIndicator={false}
          />
        </GestureDetector>
      </SettingsScreenContent>
    </View>
  );
}
