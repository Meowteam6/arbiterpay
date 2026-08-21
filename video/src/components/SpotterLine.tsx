// SPOTTER's deadpan lower-third caption. One line per scene, springs up from the
// bottom, sits, leaves. Deliberately understated: emerald name chip, muted body,
// no exclamation, never on a number. This is the "loud around the numbers, never
// a cheerleader" voice made visual - the line is quiet so the gold amount is loud.
import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { theme } from "../theme";
import { monoFamily } from "../fonts";

export const SpotterLine: React.FC<{ text: string; sans: string }> = ({ text, sans }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const rise = spring({ frame, fps, config: { damping: 18, stiffness: 120 } });
  const y = interpolate(rise, [0, 1], [40, 0]);
  const out = interpolate(frame, [durationInFrames - 12, durationInFrames], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", padding: "0 8%" }}>
      <div
        style={{
          transform: `translateY(${y}px)`,
          opacity: rise * out,
          display: "flex",
          alignItems: "center",
          gap: 14,
          marginBottom: "8%",
          padding: "14px 22px",
          borderRadius: 999,
          background: theme.surface,
          border: `1px solid ${theme.border}`,
          boxShadow: "0 6px 24px rgba(22,33,27,0.08)",
          maxWidth: "88%",
        }}
      >
        <span
          style={{
            fontFamily: monoFamily,
            fontSize: 13,
            fontWeight: 600,
            letterSpacing: 1,
            color: theme.accentStrong,
            textTransform: "uppercase",
            whiteSpace: "nowrap",
          }}
        >
          SPOTTER
        </span>
        <span style={{ fontFamily: sans, fontSize: 26, fontWeight: 500, color: theme.foreground, lineHeight: 1.2 }}>
          {text}
        </span>
      </div>
    </AbsoluteFill>
  );
};
