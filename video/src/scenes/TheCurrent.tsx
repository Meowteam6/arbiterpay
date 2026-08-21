// Scene 5 - THE CURRENT. The live-payout river: city - goal - $amount rows stream
// upward continuously, each amount a gold mono mark. Verified rows carry a small
// emerald check; self-reported rows carry an amber "self-reported" chip and NEVER
// a check or the word verified - the honesty tier is visible in the stream. Coral
// water-motion feel, gold only on the numbers. 3-sec wow: the endless upward
// current of real-looking payouts, amounts glinting gold as they pass.
import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { theme } from "../theme";
import { monoFamily } from "../fonts";
import { SpotterLine } from "../components/SpotterLine";
import { currentEntries } from "../data";
import type { Dict } from "../i18n";

export const TheCurrent: React.FC<{ d: Dict; sans: string }> = ({ d, sans }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  const rowH = 92;
  const speed = 1.1; // px per frame upward
  const loop = [...currentEntries, ...currentEntries, ...currentEntries];
  const scroll = (frame * speed) % (currentEntries.length * rowH);
  const fade = interpolate(frame, [0, 16], [0, 1], { extrapolateRight: "clamp" });
  const outFade = interpolate(frame, [durationInFrames - 14, durationInFrames], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ background: theme.background, opacity: fade * outFade }}>
      <div style={{ textAlign: "center", paddingTop: "6%" }}>
        <div style={{ fontFamily: monoFamily, fontSize: 20, letterSpacing: 3, textTransform: "uppercase", color: theme.accentDeep, fontWeight: 700 }}>
          {d.currentLabel}
        </div>
        <div style={{ fontFamily: sans, fontSize: 20, color: theme.muted, marginTop: 6 }}>{d.currentSub}</div>
        <div style={{ fontFamily: sans, fontSize: 15, color: theme.muted, marginTop: 10, opacity: 0.85 }}>{d.testnetNote}</div>
      </div>

      {/* the streaming river, masked top & bottom */}
      <div style={{ position: "absolute", top: "20%", bottom: "16%", left: "10%", right: "10%", overflow: "hidden", maskImage: "linear-gradient(to bottom, transparent, black 12%, black 88%, transparent)", WebkitMaskImage: "linear-gradient(to bottom, transparent, black 12%, black 88%, transparent)" }}>
        <div style={{ transform: `translateY(${-scroll}px)` }}>
          {loop.map((e, i) => (
            <div
              key={i}
              style={{
                height: rowH - 16,
                marginBottom: 16,
                display: "flex",
                alignItems: "center",
                gap: 16,
                padding: "0 26px",
                background: theme.surface,
                border: `1px solid ${theme.border}`,
                borderRadius: 18,
                boxShadow: "0 4px 16px rgba(22,33,27,0.05)",
              }}
            >
              {/* Name + amount + tier only. The goal/health category is NEVER
                  shown - that is the product's core privacy promise, and the
                  feed carries no category to leak. */}
              <span style={{ fontFamily: sans, fontSize: 22, fontWeight: 600, color: theme.foreground, minWidth: 130 }}>{e.city}</span>
              <div style={{ flex: 1 }} />
              {e.verified ? (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: sans, fontSize: 15, color: theme.accentStrong }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                    <path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" stroke={theme.accentStrong} strokeWidth="2" strokeLinejoin="round" />
                    <path d="M9 12l2 2 4-4" stroke={theme.accentStrong} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  {d.dropVerified}
                </span>
              ) : (
                <span style={{ fontFamily: sans, fontSize: 13, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, color: theme.warning, background: `${theme.warning}14`, border: `1px solid ${theme.warning}44`, borderRadius: 999, padding: "4px 12px" }}>
                  self-reported
                </span>
              )}
              <span style={{ fontFamily: monoFamily, fontVariantNumeric: "tabular-nums", fontSize: 26, fontWeight: 600, color: theme.gold, minWidth: 110, textAlign: "right" }}>
                ${e.amount}
              </span>
            </div>
          ))}
        </div>
      </div>

      <SpotterLine text={d.spotterLineCurrent} sans={sans} />
    </AbsoluteFill>
  );
};
