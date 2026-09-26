import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Slider } from "./slider";

describe("Slider", () => {
  it("renders a native range control with the shared progress treatment", () => {
    const html = renderToStaticMarkup(
      <Slider aria-label="Example" className="w-full" min={10} max={30} value={20} />,
    );

    expect(html).toContain('type="range"');
    expect(html).toContain("range-slider w-full");
    expect(html).toContain("--range-slider-progress:50%");
    expect(html).toContain("--range-slider-fill-offset:0rem");
  });

  it("passes disabled state through to read-only sliders", () => {
    const html = renderToStaticMarkup(
      <Slider aria-label="Read only" min={0} max={10} value={4} disabled />,
    );

    expect(html).toContain("disabled");
  });
});
