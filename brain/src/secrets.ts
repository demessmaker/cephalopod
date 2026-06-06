// Secret detection for write-time scanning (05 §5). A curated set of
// high-precision patterns (favor few false positives over exhaustive coverage).
const PATTERNS: [string, RegExp][] = [
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ["stripe-secret-key", /\bsk_(?:live|test)_[0-9a-zA-Z]{16,}\b/],
  ["google-api-key", /\bAIza[0-9A-Za-z_\-]{35}\b/],
  ["cephalopod-token", /\bcph_[0-9a-f]{40,}\b/],
  ["private-key-block", /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/],
];

/** Returns the names of any secret patterns found in `text` (empty = clean). */
export function scanSecrets(text: string): string[] {
  const hits: string[] = [];
  for (const [name, re] of PATTERNS) if (re.test(text)) hits.push(name);
  return hits;
}
