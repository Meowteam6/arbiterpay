// Supabase clients for the social identity layer. Server-only: this module is
// never imported from a "use client" file, and the service-role key it reads
// must never reach the browser.
//
// TWO CLIENTS, TWO TRUST LEVELS
//   - getSupabaseAnon()        publishable (anon) key. Read-only by RLS: the
//                              profiles and profile_stats tables grant SELECT
//                              to anon and have no write policy, so this client
//                              can read the public identity data and nothing
//                              else. Safe to reach from any public surface.
//   - getSupabaseServiceRole() service-role key. Bypasses RLS. The ONLY writer.
//                              Used exclusively behind an EIP-191 signature
//                              check that proves the caller controls the wallet
//                              being written (see /api/social/handle).
//
// Identity here is the wallet address, not a Supabase Auth session, so neither
// client carries cookies: both use a no-op cookie store. @supabase/ssr's
// createServerClient is still the constructor (per the stack decision) - the
// cookie plumbing it exists for is simply unused because there is no auth
// session to persist.
//
// Both factories return null when their key is absent rather than throwing at
// import time, so a build or a test run with no Supabase env stays green and
// every caller degrades to "no handles known" instead of crashing.

import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

// No auth session is kept, so the cookie store is inert. getAll returns nothing
// and setAll is omitted; the client never needs to persist a token.
const NO_COOKIES = { getAll: (): { name: string; value: string }[] => [] };

/** Whether the anon read path is wired up. */
export function supabaseReadConfigured(): boolean {
  return SUPABASE_URL !== "" && SUPABASE_ANON_KEY !== "";
}

/** Whether the service-role write path is wired up. */
export function supabaseWriteConfigured(): boolean {
  return SUPABASE_URL !== "" && SUPABASE_SERVICE_ROLE_KEY !== "";
}

/** Anon, read-only Supabase client, or null when unconfigured. */
export function getSupabaseAnon(): SupabaseClient | null {
  if (!supabaseReadConfigured()) return null;
  return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: NO_COOKIES,
  });
}

/** Service-role Supabase client (bypasses RLS), or null when unconfigured. */
export function getSupabaseServiceRole(): SupabaseClient | null {
  if (!supabaseWriteConfigured()) return null;
  return createServerClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    cookies: NO_COOKIES,
  });
}
