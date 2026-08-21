// Scene 1 - THE HOOK. The grandma cross-border thesis, made literal with two
// points on a soft map that connect with a drawn emerald arc. This is the VISION
// line ("the vision" label sits under it) - not a claim that live cross-border
// payouts exist. 3-sec wow: the arc draws point-to-point and a coral pulse
// travels along it, "you" -> "lola", while the second clause lands.
import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { theme } from "../theme";
import { monoFamily } from "../fonts";
import { grandmaRoute } from "../data";
import type { Dict } from "../i18n";

export const Hook: React.FC<{ d: Dict; sans: string }> = ({ d, sans }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  const fadeIn = interpolate(frame, [0, 18], [0, 1], { extrapolateRight: "clamp" });
  const line2 = spring({ frame: frame - 30, fps, config: { damping: 20 } });

  // Map arc geometry (normalized -> px)
  const fx = grandmaRoute.from.x * width;
  const fy = grandmaRoute.from.y * height;
  const tx = grandmaRoute.to.x * width;
  const ty = grandmaRoute.to.y * height;
  const cx = (fx + tx) / 2;
  const cy = Math.min(fy, ty) - height * 0.16; // control point arches up
  const draw = interpolate(frame, [40, 78], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  // Point traveling along the quadratic bezier
  const t = draw;
  const px = (1 - t) * (1 - t) * fx + 2 * (1 - t) * t * cx + t * t * tx;
  const py = (1 - t) * (1 - t) * fy + 2 * (1 - t) * t * cy + t * t * ty;

  const pathLen = 1400; // generous; dashoffset drives the reveal
  const label = (x: number, y: number, text: string, color: string) => (
    <g>
      <circle cx={x} cy={y} r={9} fill={color} />
      <circle cx={x} cy={y} r={16} fill="none" stroke={color} strokeWidth={2} opacity={0.4} />
      <text x={x} y={y - 26} textAnchor="middle" fontFamily={monoFamily} fontSize={22} fontWeight={600} fill={theme.foreground}>
        {text}
      </text>
    </g>
  );

  return (
    <AbsoluteFill style={{ background: theme.background }}>
      <svg width={width} height={height} style={{ position: "absolute", inset: 0 }}>
        <path
          d={`M ${fx} ${fy} Q ${cx} ${cy} ${tx} ${ty}`}
          fill="none"
          stroke={theme.accent}
          strokeWidth={3}
          strokeDasharray={pathLen}
          strokeDashoffset={pathLen * (1 - draw)}
          strokeLinecap="round"
          opacity={0.9}
        />
        {label(fx, fy, "you", theme.accentStrong)}
        {draw > 0.02 && <circle cx={px} cy={py} r={7} fill={theme.coral} />}
        {draw > 0.98 && label(tx, ty, "lola", theme.coralStrong)}
      </svg>

      <AbsoluteFill style={{ justifyContent: "flex-start", padding: "9% 8% 0" }}>
        <div style={{ opacity: fadeIn, maxWidth: "72%" }}>
          <div style={{ fontFamily: sans, fontSize: 46, fontWeight: 600, color: theme.foreground, lineHeight: 1.15 }}>
            {d.hookLine1}
          </div>
          <div
            style={{
              fontFamily: sans,
              fontSize: 46,
              fontWeight: 600,
              color: theme.foreground,
              lineHeight: 1.15,
              opacity: line2,
              transform: `translateY(${interpolate(line2, [0, 1], [16, 0])}px)`,
            }}
          >
            {d.hookLine2}
          </div>
          <div style={{ marginTop: 14, fontFamily: monoFamily, fontSize: 15, letterSpacing: 2, textTransform: "uppercase", color: theme.muted, opacity: interpolate(frame, [60, 80], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) }}>
            {d.thesisVision}
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
