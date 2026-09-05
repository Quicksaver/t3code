import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ uuidv4: vi.fn<() => string>() }));

vi.mock("../../lib/uuid", () => ({ uuidv4: mocks.uuidv4 }));

import { makeMobileMagiParticipantId } from "./magiParticipantIds";

describe("makeMobileMagiParticipantId", () => {
  beforeEach(() => mocks.uuidv4.mockReset());

  it("mints a distinct id for every rapid participant creation", () => {
    mocks.uuidv4.mockImplementation(() => `uuid-${mocks.uuidv4.mock.calls.length}`);

    const ids = Array.from({ length: 100 }, () => makeMobileMagiParticipantId());

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe("mobile-uuid-1");
    expect(ids.at(-1)).toBe("mobile-uuid-100");
  });
});
