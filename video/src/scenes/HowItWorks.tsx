// Scene 3 - HOW IT WORKS in three quick beats: sponsor funds -> you hit the goal
// -> you get paid. Cards spring in one after another (staggered spring), an
// emerald connector draws between them. The verify beat carries the emerald TEE
// privacy note; only the third beat's amount hint is gold. 3-sec wow: the three
// cards snap in on a beat and the emerald line stitches them together.
import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { theme } from "../theme";
import { monoFamily } from "../fonts";
import { SpotterLine } from "../components/SpotterLine";
import type { Dict } from "../i18n";

const Card: React.FC<{
  index: number;
  title: string;
  sub: string;
  sans: string;
  accentGold?: boolean;
}> = ({ index, title, sub, sans, accentGold }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - index * 14, fps, config: { damping: 16, stiffness: 110 } });
  return (
    <div
      style={{
        flex: 1,
        opacity: s,
        transform: `translateY(${interpolate(s, [0, 1], [40, 0])}px) scale(${interpolate(s, [0, 1], [0.94, 1])})`,
        background: theme.surface,
        border: `1px solid ${theme.border}`,
        borderRadius: 24,
        padding: "32px 28px",
        boxShadow: "0 8px 30px rgba(22,33,27,0.06)",
      }}
    >
      <div
        style={{
          fontFamily: monoFamily,
          fontSize: 18,
          fontWeight: 600,
          color: accentGold ? theme.goldDeep : theme.accentStrong,
        }}
      >
        {String(index + 1).padStart(2, "0")}
      </div>
      <div style={{ fontFamily: sans, fontSize: 30, fontWeight: 600, color: theme.foreground, marginTop: 12, lineHeight: 1.2 }}>
        {title}
      </div>
      <div style={{ fontFamily: sans, fontSize: 19, color: theme.muted, marginTop: 10 }}>{sub}</div>
    </div>
  );
};

export const HowItWorks: React.FC<{ d: Dict; sans: string }> = ({ d, sans }) => {
  const frame = useCurrentFrame();
  const lineDraw = interpolate(frame, [10, 55], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ background: theme.background, justifyContent: "center", padding: "0 7%" }}>
      <div style={{ position: "relative" }}>
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: 0,
            height: 3,
            width: `${lineDraw * 100}%`,
            background: theme.accent,
            opacity: 0.35,
            transform: "translateY(-50%)",
            borderRadius: 2,
          }}
        />
        <div style={{ display: "flex", gap: 28, position: "relative" }}>
          <Card index={0} title={d.step1} sub={d.step1Sub} sans={sans} />
          <Card index={1} title={d.step2} sub={d.step2Sub} sans={sans} />
          <Card index={2} title={d.step3} sub={d.step3Sub} sans={sans} accentGold />
        </div>
      </div>
      <SpotterLine text={d.spotterLineHow} sans={sans} />
    </AbsoluteFill>
  );
};
