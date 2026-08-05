import { readFileSync } from "fs";
import path from "path";
import type { NextConfig } from "next";

// Next.js only auto-loads env files from the app directory, but the team
// keeps shared server secrets in the repo-root gohealthme/.env. Load that
// file into the server process at config time. Existing variables (for
// example from Vercel's dashboard or app/.env.local) are never overridden.
function loadRootEnv(): void {
  const file = path.join(process.cwd(), "..", ".env");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return; // no root .env: rely on platform-provided env (e.g. Vercel)
  }
  for (const line of raw.split("\n")) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match === null) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    const value = rawValue.replace(/^["']|["']$/g, "");
    if (value.length === 0) continue;
    process.env[key] = value;
  }
}

loadRootEnv();

const nextConfig: NextConfig = {
  // The dev-tools indicator is for developers, not for footage: the e2e demo
  // profile records the dev server, and the floating "N" badge would sit in
  // the corner of every frame. Same cosmetic-only flag that hides the
  // configuration banners (see lib/config.ts); normal dev keeps the default.
  ...(process.env.NEXT_PUBLIC_DEMO_CHROME === "1"
    ? { devIndicators: false as const }
    : {}),
};

export default nextConfig;
