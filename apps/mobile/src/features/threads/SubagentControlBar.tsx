import { memo } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { ControlPill } from "../../components/ControlPill";

export const SUBAGENT_CONTROL_BAR_HEIGHT = 60;

export const SubagentControlBar = memo(function SubagentControlBar(props: {
  readonly bottomInset: number;
  readonly contentMaxWidth?: number;
  readonly isRunning: boolean;
  readonly onOpenParentThread?: () => void;
  readonly onStopThread: () => void;
}) {
  return (
    <View style={{ alignItems: "center", paddingBottom: props.bottomInset, paddingHorizontal: 16 }}>
      <View
        className="border border-border bg-card"
        style={{
          alignItems: "center",
          borderRadius: 999,
          flexDirection: "row",
          gap: 12,
          justifyContent: "space-between",
          maxWidth: props.contentMaxWidth,
          minHeight: 44,
          paddingHorizontal: 14,
          paddingVertical: 6,
          width: "100%",
        }}
      >
        <View className="flex-row items-center gap-2">
          {props.onOpenParentThread ? (
            <ControlPill
              accessibilityLabel="Open parent thread"
              icon="arrow.up.left"
              onPress={props.onOpenParentThread}
            />
          ) : null}
          <Text className="text-sm font-t3-medium text-foreground-muted" numberOfLines={1}>
            Subagent
          </Text>
        </View>
        {props.isRunning ? (
          <ControlPill
            accessibilityLabel="Stop subagent"
            icon="stop.fill"
            variant="danger"
            onPress={props.onStopThread}
          />
        ) : null}
      </View>
    </View>
  );
});
