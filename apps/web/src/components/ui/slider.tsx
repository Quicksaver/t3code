import type { ComponentProps, CSSProperties } from "react";

import { cn } from "~/lib/utils";

type SliderProps = Omit<ComponentProps<"input">, "max" | "min" | "type" | "value"> & {
  readonly max: number;
  readonly min: number;
  readonly value: number;
};

function Slider({ className, max, min, style, value, ...props }: SliderProps) {
  const progress = max === min ? 0 : Math.min(1, Math.max(0, (value - min) / (max - min)));
  const sliderStyle = {
    ...style,
    "--range-slider-progress": `${progress * 100}%`,
    "--range-slider-fill-offset": `${0.5 - progress}rem`,
  } as CSSProperties;

  return (
    <input
      {...props}
      className={cn("range-slider", className)}
      max={max}
      min={min}
      style={sliderStyle}
      type="range"
      value={value}
    />
  );
}

export { Slider };
