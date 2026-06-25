import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "@effect/vitest";

import { ChatComposerOverlayBackground } from "./ChatComposerOverlayBackground";

describe("ChatComposerOverlayBackground", () => {
  it("keeps the overlay chrome full-width without the old cap", () => {
    const markup = renderToStaticMarkup(<ChatComposerOverlayBackground />);

    expect(markup).toContain("chat-composer-horizontal-inset");
    expect(markup).toContain("chat-composer-shared-blur");
    expect(markup).toContain("w-full");
    expect(markup).not.toContain("max-w-208");
    expect(markup).not.toContain("mx-auto");
  });
});
