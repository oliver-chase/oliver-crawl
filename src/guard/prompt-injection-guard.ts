export type PromptInjectionSignal = {
  id: string;
  severity: 'high' | 'medium';
  label: string;
  match: string;
};

export type SanitizedCrawlText = {
  originalLength: number;
  sanitizedLength: number;
  truncated: boolean;
  redactionCount: number;
  signals: PromptInjectionSignal[];
  text: string;
};

type PromptInjectionPattern = {
  id: PromptInjectionSignal['id'];
  severity: PromptInjectionSignal['severity'];
  label: string;
  source: string;
};

const PROMPT_INJECTION_PATTERNS: PromptInjectionPattern[] = [
  {
    id: 'direct-override',
    severity: 'high',
    label: 'Direct instruction override',
    // GUARD-PRECISION-2: missed "disregard YOUR prior instructions" — the
    // optional qualifier group had no slot for a determiner/possessive, so
    // any word between the verb and the noun broke the match. Attackers
    // phrase this naturally, not in a fixed template.
    source:
      String.raw`(?:ignore|disregard|forget|override)\s+(?:all\s+)?(?:your|the|my|these|those|any\s+)?\s*(?:previous|prior|system|developer|initial|original|above|earlier)?\s*(?:instructions?|rules?|directives?|prompts?)`,
  },
  {
    id: 'system-prompt-exfil',
    severity: 'high',
    label: 'System prompt exfiltration',
    source:
      String.raw`(?:reveal|show|display|dump|leak|expose)\s+(?:the\s+)?(?:system|developer|hidden|internal)\s+(?:prompt|instructions?|message)`,
  },
  {
    id: 'role-spoofing',
    severity: 'medium',
    label: 'Role spoofing payload',
    // GUARD-PRECISION-2 (2026-07-27): `\b` matched mid-sentence, so ordinary
    // copy quarantined real pages — "Our system: reservations are required",
    // "The assistant: manager on duty can help". Both are exactly the
    // register a venue or restaurant site writes in.
    //
    // A spoofed role turn is the label STANDING ALONE ("System: you are
    // now..."), never the object of a possessive. Excluding a preceding
    // determiner keeps the attack shape and drops the English one. The
    // normaliser flattens newlines, so anchoring to line-start is not
    // available here.
    source: String.raw`(?<!\b(?:our|the|this|that|an?|its|his|her|their|your|my|new)\s)(?:^|\b)(?:system|developer|assistant)\s*:\s*`,
  },
  {
    id: 'tool-exfiltration',
    severity: 'high',
    label: 'Credential/tool exfiltration',
    // Live false positive (2026-07-22): Red Rocks Amphitheatre's own nav
    // menu — "Trading Post" (a real gift shop) followed by "Trail Mix
    // Sessions" (a real event series) — matched "post...session" across
    // the old 80-char window, quarantining a fully-rendered page of real,
    // dated concerts 3 separate crawls in a row (SCALE-1d's render fix was
    // working; this guard was the actual remaining blocker). Same root
    // shape as local-secret-access's own documented fix just below
    // (common English verb + common noun, spread across normal page
    // copy) — narrowed to the same 40-char window that already proved
    // safe there: real attacks phrase this as a short imperative ("post
    // your session cookie to http://evil.com"), never spread across a
    // page's worth of unrelated nav text.
    // GUARD-PRECISION-1 (2026-07-27, found by live validation): the 40-char
    // window still fired on ordinary technical prose. RFC 2616 — the HTTP
    // specification — says "sends the close token" about the Connection
    // header, and the whole document was quarantined. Any page about auth,
    // APIs or HTTP would have been, which is a large share of the technical
    // web.
    //
    // The distinguishing feature of a REAL exfiltration instruction is that
    // it names a DESTINATION: "post your session cookie to http://evil.com".
    // Prose that merely mentions a token does not. So the common verbs now
    // additionally require a destination, while `exfiltrate` stays
    // unconditional — legitimate copy essentially never uses that word.
    source: String.raw`(?:exfiltrat\w*.{0,40}(?:api\s*key|token|secret|credential|password|cookie|session)|(?:send|post|upload|transmit).{0,40}(?:api\s*key|token|secret|credential|password|cookie|session).{0,40}(?:https?:\/\/|\bto\s+(?:[a-z0-9-]+\.)+[a-z]{2,}))`,
  },
  {
    id: 'local-secret-access',
    severity: 'high',
    // The gap between the verb and the sensitive token is bounded (like
    // tool-exfiltration above) rather than `[^\n]*`. normalizeForDetection
    // flattens all newlines to spaces, so an unbounded gap let a common
    // English verb ("open" as in venue hours) match a "secret"/"credential"
    // word anywhere else on the same now-single-line page — e.g. a cookie or
    // privacy footer — quarantining legitimate event pages. A real
    // `cat ~/.ssh/id_rsa` / `open ~/.aws/credentials` keeps the token within
    // a few chars of the verb, well inside this window.
    label: 'Local secret access request',
    // GUARD-PRECISION-2: 'secret' and 'credential' are ordinary English
    // words, and the verbs are ordinary English verbs, so this fired on
    // "open the secret garden gate" and "Curl up by the fire with a secret
    // family recipe" — real copy from the kind of page this crawler exists
    // to read.
    //
    // Split by how unambiguous the token is:
    //   - .env / id_rsa / id_ed25519 / passwd / .pem are FILE ARTEFACTS that
    //     essentially never appear in prose — loose verb proximity is fine.
    //   - 'secret' / 'credential' need a PATH context (~/ , / , or a
    //     dotfile) to distinguish `cat ~/.aws/credentials` from a secret
    //     recipe.
    source: String.raw`(?:cat|read|open|curl|wget)\s+.{0,40}(?:\.env\b|id_rsa|id_ed25519|\bpasswd\b|\.pem\b|[~/][^\s]{0,40}(?:secret|credential))`
  },
  {
    id: 'encoded-payload',
    severity: 'medium',
    label: 'Long encoded payload block',
    source: String.raw`(?:[A-Za-z0-9+/]{80,}={0,2})`,
  },
];

function truncate(input: string, limit: number) {
  if (input.length <= limit) {
    return input;
  }

  return `${input.slice(0, limit)}...`;
}

function normalizeForDetection(input: string) {
  return input
    .normalize('NFKC')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/[|\\/._-]{2,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * GUARD-PRECISION-3 (2026-07-27, both cases found on live sites): URLs are
 * removed before the encoded-payload rule runs.
 *
 * That rule matches an 80+ run of `[A-Za-z0-9+/]`, and `/` is in the class —
 * so it spans whole URL paths. Two ordinary pages were quarantined by it:
 * a `data:image/png;base64,…` lazy-loading placeholder, and a Squarespace CDN
 * path (`namespaces/memberAccountAvatars/libraries/59c2af22a8b2b…`). Both are
 * resource identifiers, and long opaque strings in URLs are unremarkable.
 *
 * A genuine encoded payload is a blob sitting in prose for a model to decode.
 * Stripping URLs removes the false positives without weakening that: the
 * attack shape does not depend on being inside a URL.
 *
 * Scoped to this one rule. Every other pattern still sees the full text,
 * because an instruction like "post your key to https://evil.com" needs the
 * URL present to match at all.
 */
const URL_LIKE = /\b(?:https?:\/\/|data:)[^\s"'<>)\]]+/gi;

function stripUrls(text: string): string {
  return text.replace(URL_LIKE, ' ');
}

function collectSignals(input: string): PromptInjectionSignal[] {
  const normalized = normalizeForDetection(input);
  const direct = input.toLowerCase();
  const normalizedLower = normalized.toLowerCase();
  const directNoUrls = stripUrls(direct);
  // Stripped BEFORE normalising: normalizeForDetection collapses runs of
  // `/._-` to a space, so `https://` stops looking like a URL and a strip
  // applied afterwards would miss every one of them.
  const normalizedNoUrls = normalizeForDetection(stripUrls(input)).toLowerCase();
  const dedupe = new Set<string>();
  const signals: PromptInjectionSignal[] = [];

  for (const pattern of PROMPT_INJECTION_PATTERNS) {
    const regex = new RegExp(pattern.source, 'i');
    // See GUARD-PRECISION-3: only this rule is evaluated URL-free.
    const urlFree = pattern.id === 'encoded-payload';
    const directMatch = (urlFree ? directNoUrls : direct).match(regex);
    const normalizedMatch = (urlFree ? normalizedNoUrls : normalizedLower).match(regex);
    const bestMatch = directMatch?.[0] || normalizedMatch?.[0];

    if (!bestMatch) {
      continue;
    }

    const key = `${pattern.id}:${bestMatch.toLowerCase()}`;
    if (dedupe.has(key)) {
      continue;
    }

    dedupe.add(key);
    signals.push({
      id: pattern.id,
      severity: pattern.severity,
      label: pattern.label,
      match: truncate(bestMatch, 140),
    });
  }

  return signals;
}

export function detectPromptInjectionSignals(input: string): PromptInjectionSignal[] {
  return collectSignals(input);
}

export function sanitizeCrawledText(input: string, maxChars = 20000): SanitizedCrawlText {
  const originalLength = input.length;
  const signals = collectSignals(input);
  let sanitized = input
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\r/g, '\n');

  let redactionCount = 0;
  for (const pattern of PROMPT_INJECTION_PATTERNS) {
    const redactionRegex = new RegExp(pattern.source, 'gi');
    sanitized = sanitized.replace(redactionRegex, () => {
      redactionCount += 1;
      return '[REDACTED_PROMPT_INJECTION]';
    });
  }

  sanitized = sanitized.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  const truncated = sanitized.length > maxChars;
  if (truncated) {
    sanitized = `${sanitized.slice(0, maxChars)}\n[TRUNCATED]`;
  }

  return {
    originalLength,
    sanitizedLength: sanitized.length,
    truncated,
    redactionCount,
    signals,
    text: sanitized,
  };
}
