"use client";

// Batch address -> display-name resolver for list surfaces. Given a set of
// wallet addresses it asks /api/social/resolve once for the claimed handles,
// then hands back a displayName(address) that returns "@handle" when the wallet
// has claimed one and the truncated address otherwise.
//
// Identity is keyed off the address exactly as it appears on chain; the hook
// lowercases internally so a checksummed and a lowercased rendering of the same
// wallet resolve to the same handle. Handles and avatar glyphs are the only
// thing fetched - never anything health-revealing.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { displayNameFor, normalizeAddress } from "@/lib/social";

interface ResolvedProfile {
  handle: string;
  emoji: string | null;
}

interface ResolveResponse {
  profiles: Record<string, ResolvedProfile>;
}

export interface DisplayNames {
  /** "@handle" when claimed, else the truncated address. */
  displayName: (address: string) => string;
  /** The claimed handle for an address, or null. */
  handleFor: (address: string) => string | null;
  isLoading: boolean;
}

async function fetchProfiles(addresses: string[]): Promise<ResolveResponse> {
  const query = encodeURIComponent(addresses.join(","));
  const res = await fetch(`/api/social/resolve?addresses=${query}`);
  if (!res.ok) throw new Error(`resolve responded ${res.status}`);
  return (await res.json()) as ResolveResponse;
}

export function useDisplayNames(addresses: string[]): DisplayNames {
  // Normalize, dedupe, and sort so the query key is stable across renders that
  // pass a fresh array with the same members.
  const keyAddresses = useMemo(() => {
    const lowered = addresses
      .map((a) => normalizeAddress(a))
      .filter((a): a is string => a !== null);
    return Array.from(new Set(lowered)).sort();
  }, [addresses]);

  const query = useQuery({
    queryKey: ["social-resolve", keyAddresses],
    queryFn: () => fetchProfiles(keyAddresses),
    enabled: keyAddresses.length > 0,
    staleTime: 60_000,
  });

  const data = query.data;
  const isLoading = query.isLoading;

  return useMemo(() => {
    const profiles = data?.profiles ?? {};
    const handleFor = (address: string): string | null => {
      const key = normalizeAddress(address);
      if (key === null) return null;
      const profile = profiles[key];
      return profile !== undefined ? profile.handle : null;
    };
    return {
      handleFor,
      displayName: (address: string) => displayNameFor(address, handleFor(address)),
      isLoading,
    };
  }, [data, isLoading]);
}
