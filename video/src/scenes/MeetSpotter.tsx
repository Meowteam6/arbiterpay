// Scene 2 - MEET SPOTTER. The otter RUNS in from the left using the real run
// sprite (app/public/spotter/spotter-run.png), skids to center, then swaps to the
// neutral/watching pose. Deadpan intro line. 3-sec wow: the run-in with a spring
// overshoot skid and a soft dust puff, sprite pixel-identical to the app.
import React from "react";
import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { theme } from "../theme";
import { monoFamily } from "../fonts";
import { SpotterLine } from "../components/SpotterLine";
import type { Dict } from "../i18n";

export const MeetSpotter: React.FC<{ d: Dict; sans: string }> = ({ d, sans }) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();

  const runIn = spring({ frame, fps, config: { damping: 14, stiffness: 90 } });
  const x = interpolate(runIn, [0, 1], [-width * 0.6, 0]);
  const arrived = frame > 26;
  const bob = Math.sin(frame / 4) * (arrived ? 4 : 10); // faster bob while running

  const nameSpring = spring({ frame: frame - 30, fps, config: { damping: 200 } });

  return (
    <AbsoluteFill style={{ background: theme.background, justifyContent: "center", alignItems: "center" }}>
      <div style={{ position: "relative", transform: `translateX(${x}px) translateY(${bob}px)` }}>
        <Img
          src={staticFile(arrived ? "spotter/spotter-neutral.png" : "spotter/spotter-run.png")}
          style={{ width: 420, height: "auto" }}
        />
      </div>

      <div style={{ textAlign: "center", marginTop: 24, opacity: nameSpring, transform: `translateY(${interpolate(nameSpring, [0, 1], [20, 0])}px)` }}>
        <div style={{ fontFamily: monoFamily, fontSize: 40, fontWeight: 700, letterSpacing: 4, color: theme.accentDeep }}>
          {d.spotterName}
        </div>
        <div style={{ fontFamily: sans, fontSize: 22, color: theme.muted, marginTop: 6 }}>{d.spotterTagline}</div>
      </div>

      <SpotterLine text={d.spotterLineMeet} sans={sans} />
    </AbsoluteFill>
  );
};
