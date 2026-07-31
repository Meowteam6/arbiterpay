// Server-only env access. Every module reads env through these helpers so a
// missing variable fails loudly with the variable name instead of a cryptic
// downstream error.

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(
      `Missing required env var ${name}. Add it to the repo-root .env (see .env.example).`,
    );
  }
  return value.trim();
}

export function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  return value.trim();
}
