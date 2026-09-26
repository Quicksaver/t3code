import Svg, { Circle, Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedSvg = withUniwind(Svg);

/** Same three-node consensus geometry used by the web client. */
export function MagiConsensusIcon(props: {
  readonly size?: number;
  readonly color?: string;
  readonly colorClassName?: string;
}) {
  const size = props.size ?? 18;
  return (
    <ThemedSvg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      accessibilityElementsHidden
      color={props.color}
      colorClassName={props.colorClassName ?? "accent-icon"}
    >
      <Path
        d="M7 8.5 12 12l5-3.5M12 12v5"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.7}
      />
      <Circle cx={7} cy={7} r={3} fill="none" stroke="currentColor" strokeWidth={1.8} />
      <Circle cx={17} cy={7} r={3} fill="none" stroke="currentColor" strokeWidth={1.8} />
      <Circle cx={12} cy={18} r={3} fill="none" stroke="currentColor" strokeWidth={1.8} />
    </ThemedSvg>
  );
}
