import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { MagiRunStatusIcon, ParticipantStatusLight } from "./MagiPanel";

describe("Magi status icons", () => {
  it("shows a static blue network inside a dashed circle while running", () => {
    const markup = renderToStaticMarkup(<MagiRunStatusIcon state="running" label="Deliberating" />);

    expect(markup.match(/<svg/g)).toHaveLength(2);
    expect(markup.match(/text-info-foreground/g)).toHaveLength(2);
    expect(markup).not.toContain("animate-");
    expect(markup).not.toContain("magi-run-icon-running");
  });

  it("keeps the working participant dashed circle static", () => {
    const markup = renderToStaticMarkup(
      <ParticipantStatusLight indicator="working" label="Working" />,
    );

    expect(markup.match(/<svg/g)).toHaveLength(1);
    expect(markup).toContain("text-info-foreground");
    expect(markup).not.toContain("animate-");
  });
});
