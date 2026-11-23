/** Max characters of an upstream error kept on a ledger row. */
export const LEDGER_ERROR_MAX = 500;

const MIN_EXACT_SECRET = 8;

const BEARER = /Bearer\s+[A-Za-z0-9\-._~+/]{16,}=*/gi;
const SK_KEY = /\bsk-[A-Za-z0-9_-]{10,}/g;
const ASSIGNED =
  /\b(x-api-key|access[_-]?token|api[_-]?key)\b(\s*[:=]\s*["']?)[^\s"'&,}]{8,}/gi;

/**
 * Strip credential-shaped text before it is stored or exported.
 * The proxied response is left alone; this only covers text we keep.
 * Exact secrets (the configured upstream key) are applied after the patterns
 * so a short key that is not an `sk-` token is still removed.
 */
export function redactSecrets(text: string, extra?: Array<string | null | undefined>): string {
  let out = text.replace(BEARER, "Bearer [redacted]");
  out = out.replace(SK_KEY, "sk-[redacted]");
  out = out.replace(ASSIGNED, "$1$2[redacted]");
  const secrets = [...(extra ?? [])]
    .filter((secret): secret is string => typeof secret === "string" && secret.length >= MIN_EXACT_SECRET)
    .sort((a, b) => b.length - a.length);
  for (const secret of secrets) {
    if (!out.includes(secret)) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out;
}

/** Redact, then clip, so a key that straddles the clip boundary is not stored in pieces. */
export function ledgerErrorText(raw: string, extra?: Array<string | null | undefined>): string {
  return redactSecrets(raw, extra).slice(0, LEDGER_ERROR_MAX);
}
