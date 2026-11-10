// ─── Does this page actually say anything? ──────────────────────────────────
//
// BETTER-SOFT404-1: "No events scheduled at this time" is a perfectly valid
// 200 that costs a full model call to learn nothing. So are parked domains,
// "page under construction", and soft-404s that render a friendly message
// instead of returning 404.
//
// Detecting them free is real money at scale — but this is ADVISORY only.
// The page is still returned in full, because an off-season venue really is
// "no events scheduled", and that is a true fact a consumer may want to
// record rather than discard. This informs a decision; it never makes one.

/** Phrases that, on a short page, mean "there is deliberately nothing here". */
const EMPTY_STATE_PATTERNS = [
  /\bno (?:upcoming )?(?:events?|shows?|performances?|results?|listings?|items?)\b/i,
  /\bnothing (?:scheduled|planned|to show|here)\b/i,
  /\bcheck back (?:soon|later)\b/i,
  /\b(?:page |site )?under construction\b/i,
  /\bcoming soon\b/i,
  /\bthis domain is (?:for sale|parked)\b/i,
  /\bpage not found\b/i,
  /\b404\b.{0,20}\bnot found\b/i,
];

/**
 * Only pages this short are considered. A long page that happens to contain
 * "coming soon" in one section is a real page — the signal is the COMBINATION
 * of an empty-state phrase and nothing else on the page.
 */
const MAX_EMPTY_STATE_CHARS = 600;

/** True when a page loaded successfully but appears to carry no content. */
export function looksLikeEmptyState(text: string): boolean {
  const trimmed = text.trim();
  // A page with essentially no text at all is its own signal.
  if (trimmed.length < 30) return true;
  if (trimmed.length > MAX_EMPTY_STATE_CHARS) return false;
  return EMPTY_STATE_PATTERNS.some((pattern) => pattern.test(trimmed));
}
