// Geist Sans + Geist Mono, same faces as the live app (app/layout.tsx loads them
// via next/font/google). Mono is reserved for amounts. Noto Sans SC is loaded as
// a CJK fallback so the zh render has glyphs Geist does not ship; Latin/Tagalog
// stay on Geist. Fonts are awaited via delayRender so no frame renders unstyled.
import { loadFont as loadGeist } from "@remotion/google-fonts/Geist";
import { loadFont as loadGeistMono } from "@remotion/google-fonts/GeistMono";
import { loadFont as loadNotoSC } from "@remotion/google-fonts/NotoSansSC";
import { cancelRender, continueRender, delayRender } from "remotion";
import type { Lang } from "./i18n";

const geist = loadGeist("normal", { weights: ["400", "500", "600", "700"], subsets: ["latin"] });
const geistMono = loadGeistMono("normal", { weights: ["400", "500", "600"], subsets: ["latin"] });
const notoSC = loadNotoSC("normal", { weights: ["400", "500", "700"], subsets: ["chinese-simplified", "latin"] });

export const monoFamily = geistMono.fontFamily;

// Sans stack per language: zh falls back to Noto SC for Chinese glyphs.
export const sansFamily = (lang: Lang): string =>
  lang === "zh"
    ? `${geist.fontFamily}, ${notoSC.fontFamily}, system-ui, sans-serif`
    : `${geist.fontFamily}, system-ui, sans-serif`;

const handle = delayRender("Loading Geist + Noto fonts");
Promise.all([geist.waitUntilDone(), geistMono.waitUntilDone(), notoSC.waitUntilDone()])
  .then(() => continueRender(handle))
  .catch((err) => cancelRender(err));
