// Scene 6 - CTA. SPOTTER (cheer sprite) settled, the headline, gohealthme.app in
// mono, and the testnet-honesty note in small muted type so nothing on screen
// overstates what is live. 3-sec wow: the URL locks in with a soft emerald
// underline sweep and SPOTTER gives the one small, deadpan-earned cheer.
import React from "react";
import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { theme } from "../theme";
import { monoFamily } from "../fonts";
import type { Dict } from "../i18n";

export const CTA: React.FC<{ d: Dict; sans: string }> = ({ d, sans }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const pop = spring({ frame, fps, config: { damping: 14 } });
  const urlIn = spring({ frame: frame - 16, fps, config: { damping: 200 } });
  const underline = interpolate(frame, [30, 55], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ background: theme.background, justifyContent: "center", alignItems: "center" }}>
      <Img
        src={staticFile("spotter/spotter-cheer.png")}
        style={{ width: 300, height: "auto", transform: `scale(${interpolate(pop, [0, 1], [0.8, 1])})`, opacity: pop }}
      />
      <div style={{ fontFamily: sans, fontSize: 40, fontWeight: 600, color: theme.foreground, marginTop: 24, opacity: pop }}>
        {d.ctaHeadline}
      </div>

      <div style={{ position: "relative", marginTop: 20, opacity: urlIn, transform: `translateY(${interpolate(urlIn, [0, 1], [16, 0])}px)` }}>
        <span style={{ fontFamily: monoFamily, fontSize: 52, fontWeight: 600, color: theme.accentDeep, letterSpacing: -1 }}>
          {d.ctaUrl}
        </span>
        <div style={{ position: "absolute", left: 0, bottom: -8, height: 4, width: `${underline * 100}%`, background: theme.accent, borderRadius: 2 }} />
      </div>

      <div style={{ fontFamily: sans, fontSize: 15, color: theme.muted, marginTop: 34, opacity: interpolate(frame, [50, 70], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) }}>
        {d.testnetNote}
      </div>
    </AbsoluteFill>
  );
};
