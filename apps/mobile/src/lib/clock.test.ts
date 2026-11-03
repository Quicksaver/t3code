import { describe, expect, it, vi } from "vite-plus/test";
import { minuteTick } from "@t3tools/client-runtime/clock";

import { minuteTickToEpochMs } from "./clock";
import { relativeTime } from "./time";

describe("minuteTickToEpochMs", () => {
  it("reads the minute tick as UTC regardless of the device timezone", () => {
    expect(minuteTickToEpochMs("2026-10-26T02:14")).toBe(Date.UTC(2026, 9, 26, 2, 14));
  });

  it("formats both archive ages from shared minute snapshots", () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 26, 12, 0, 30) });
    const ages = () => {
      const nowMs = minuteTickToEpochMs(minuteTick.getSnapshot());
      return [
        relativeTime("2026-10-26T11:59:30Z", nowMs),
        relativeTime("2026-10-26T11:58:30Z", nowMs),
      ];
    };
    try {
      expect(ages()).toEqual(["<1m", "1m"]);

      vi.advanceTimersByTime(30_000);

      expect(ages()).toEqual(["1m", "2m"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
