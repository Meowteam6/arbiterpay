// Scene 4 - THE DROP. The emotional peak, recreated as motion graphics from
// components/PayoutMoment.tsx + Confetti.tsx. SPOTTER (payday sprite) holds up a
// gold coin; the coin arcs to center; a coral+emerald confetti burst fires ONCE
// (never gold - gold is only the coin and the amount); the gold amount lands and
// holds STILL (no count-up). Emerald "Verified" ribbon + the real privacy line.
// 3-sec wow: coin arc -> confetti pop -> the still gold Money mark, on the beat.
import React from "react";
import { AbsoluteFill, Img, interpolate, random, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { theme, confettiColors } from "../theme";
import { monoFamily } from "../fonts";
import { Money } from "../components/Money";
import { SpotterLine } from "../components/SpotterLine";
import { dropAmount } from "../data";
import type { Dict } from "../i18n";

const Confetti: React.FC<{ start: number }> = ({ start }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const local = frame - start;
  if (local < 0) return null;
  const pieces = new Array(28).fill(0).map((_, i) => {
    const dx = (random(`x${i}`) - 0.5) * width * 0.6;
    const dy = height * (0.18 + random(`y${i}`) * 0.28);
    const rot = (random(`r${i}`) - 0.5) * 720;
    const delay = random(`d${i}`) * 6;
    const p = interpolate(local - delay, [0, 40], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    return { i, dx, dy, rot, p, color: confettiColors[i % confettiColors.length] };
  });
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
      {pieces.map((p) => (
        <span
          key={p.i}
          style={{
            position: "absolute",
            width: 12,
            height: 18,
            background: p.color,
            opacity: 1 - p.p,
            transform: `translate(${p.dx * p.p}px, ${p.dy * p.p - 30}px) rotate(${p.rot * p.p}deg)`,
            borderRadius: 2,
          }}
        />
      ))}
    </AbsoluteFill>
  );
};

export const TheDrop: React.FC<{ d: Dict; sans: string }> = ({ d, sans }) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();

  // Coin arc: from SPOTTER (left) up-and-over to center, lands ~frame 34.
  const arc = interpolate(frame, [4, 34], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const coinX = interpolate(arc, [0, 1], [-width * 0.22, 0]);
  const coinY = -Math.sin(arc * Math.PI) * 220; // parabola up then down
  const coinScale = interpolate(arc, [0, 1], [0.6, 1]);
  const landed = frame >= 34;

  const amountSpring = spring({ frame: frame - 34, fps, config: { damping: 200, stiffness: 120 } });
  const ribbon = spring({ frame: frame - 48, fps, config: { damping: 18 } });

  return (
    <AbsoluteFill style={{ background: theme.background, justifyContent: "center", alignItems: "center" }}>
      <Img
        src={staticFile("spotter/spotter-payday.png")}
        style={{ position: "absolute", left: "8%", bottom: "6%", width: 360, height: "auto" }}
      />

      {/* Testnet honesty rides ON the money scene - a payout number must never
          imply real money on a public post. */}
      <div
        style={{
          position: "absolute",
          top: 44,
          left: "50%",
          transform: "translateX(-50%)",
          fontFamily: sans,
          fontSize: 15,
          color: theme.muted,
          background: theme.surfaceRaised,
          border: `1px solid ${theme.border}`,
          borderRadius: 999,
          padding: "6px 16px",
        }}
      >
        {d.testnetNote}
      </div>

      {landed && <Confetti start={34} />}

      {/* the coin in flight */}
      {!landed && (
        <div
          style={{
            position: "absolute",
            transform: `translate(${coinX}px, ${coinY}px) scale(${coinScale})`,
            width: 90,
            height: 90,
            borderRadius: "50%",
            background: `radial-gradient(circle at 35% 30%, ${theme.gold}, ${theme.goldStrong})`,
            boxShadow: `0 0 40px ${theme.gold}66`,
            border: `3px solid ${theme.goldDeep}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: monoFamily,
            fontSize: 40,
            fontWeight: 700,
            color: theme.goldDeep,
          }}
        >
          $
        </div>
      )}

      {/* the amount, held STILL */}
      <div style={{ opacity: amountSpring, transform: `scale(${interpolate(amountSpring, [0, 1], [0.8, 1])})`, textAlign: "center" }}>
        <div style={{ fontFamily: monoFamily, fontSize: 18, letterSpacing: 3, textTransform: "uppercase", color: theme.muted, marginBottom: 18 }}>
          {d.dropLabel}
        </div>
        <Money amount={dropAmount} size={130} />
      </div>

      {/* emerald verified ribbon + privacy line */}
      <div
        style={{
          marginTop: 40,
          opacity: ribbon,
          transform: `translateY(${interpolate(ribbon, [0, 1], [16, 0])}px)`,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 12,
        }}
      >
        <span
          style={{
            fontFamily: monoFamily,
            fontSize: 15,
            fontWeight: 600,
            letterSpacing: 1,
            textTransform: "uppercase",
            color: theme.accentStrong,
            background: `${theme.accent}1f`,
            border: `1px solid ${theme.accent}55`,
            borderRadius: 999,
            padding: "6px 16px",
          }}
        >
          {d.dropVerified}
        </span>
        <span style={{ fontFamily: sans, fontSize: 18, color: theme.muted }}>{d.dropPrivacy}</span>
      </div>

      <SpotterLine text={d.spotterLineDrop} sans={sans} />
    </AbsoluteFill>
  );
};
