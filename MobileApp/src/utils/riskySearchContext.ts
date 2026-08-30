import { findAdultSiteMatches, isAdultSiteUrlContext } from './adultSiteContext';
import type { KeywordFilterResult } from './keywordFilter';

/** `google.com/sea` is a common OCR truncation of `google.com/search`. */
const SEARCH_HOST_RE =
  /\b(google\.com\/search|google\.com\/sear(?:ch)?|google\.com\/sea\b|bing\.com\/search|duckduckgo\.com)\b/i;

const ADULT_EXPLICIT_QUERY_RE = /\b(nsfw|porn|xxx|nude|hentai|sex\s*tape)\b/i;

const VIOLENT_EXPLICIT_QUERY_RE =
  /\b(gore|gory|blood|murder|kill|massacre|behead|dismember|mutilation|corpse|brutal|shooting|school\s*shooting)\b/i;

/** Chrome / Google search-box OCR (e.g. "+ Q porn", "Q gore") — not body result titles. */
const ADULT_SEARCH_BOX_QUERY_RE =
  /(?:^|[\s+])q\s+(?:nsfw|porn|xxx|nude|hentai|sex\s*tape)\b/i;

const VIOLENT_SEARCH_BOX_QUERY_RE =
  /(?:^|[\s+])q\s+(?:gore|gory|blood|murder|kill|massacre|behead|dismember|mutilation|corpse|brutal|shooting|school\s*shooting)\b/i;

export function hasExplicitSearchBoxQuery(text: string): boolean {
  const lower = text.toLowerCase();
  return ADULT_SEARCH_BOX_QUERY_RE.test(lower) || VIOLENT_SEARCH_BOX_QUERY_RE.test(lower);
}

/** Adult omnibar OCR on Google — not Fiverr body labels or violent "Q gore" searches. */
export function hasExplicitAdultGoogleSearchIntent(text: string): boolean {
  const lower = text.toLowerCase();
  if (ADULT_SEARCH_BOX_QUERY_RE.test(lower)) {
    return true;
  }
  if (!SEARCH_HOST_RE.test(lower)) {
    return false;
  }
  if (/\bnsfw\s+eo\b/i.test(lower)) {
    return true;
  }
  if (/\bgoogle\.com\/sea\s*\+\s*(?:q\s+)?(?:nsfw|porn|xxx|nude|hentai)\b/i.test(lower)) {
    return true;
  }
  if (
    /\bgoogle\.com\/sea\b[\s\S]{0,50}\bq\s+(?:nsfw|porn|xxx|nude|hentai)\b/i.test(lower) ||
    /\bq\s+(?:nsfw|porn|xxx|nude|hentai)\b[\s\S]{0,50}\bgoogle\.com\/sea\b/i.test(lower)
  ) {
    return true;
  }
  return false;
}

/** Any explicit search-box or adult omnibar query (adult + violent). */
export function hasExplicitGoogleSearchIntent(text: string): boolean {
  return hasExplicitSearchBoxQuery(text) || hasExplicitAdultGoogleSearchIntent(text);
}

/** SafeSearch / censored filter UI on a search results page — not an active explicit search. */
export function isFilteredSearchResultsContext(lower: string): boolean {
  if (!SEARCH_HOST_RE.test(lower)) {
    return false;
  }
  const hasFilterUi =
    /\b(censored|safe\s*search|filtered|family\s*filter|restricted\s*mode|flouter|mode\s*ia|mode\s*l[aàá1i]|tous\s*images|flou|recherche\s*sécurisée|recherche\s*securisee)\b/i.test(
      lower,
    );
  if (!hasFilterUi) {
    return false;
  }
  return true;
}

/**
 * Cap combined risk on filtered SERPs when TFLite is low and the child did not
 * type an explicit query in the search box (body keywords like youporn are ignored).
 * Matched keyword-filter terms in the omnibox (`Q zebi`) also skip the cap.
 */
export function shouldCapFilteredSearchResults(
  text: string,
  tfliteScore: number,
  options?: { matchedKeywords?: string[] },
): boolean {
  const lower = text.toLowerCase();
  if (!isFilteredSearchResultsContext(lower) || tfliteScore >= 30) {
    return false;
  }
  if (hasExplicitGoogleSearchIntent(lower)) {
    return false;
  }
  if (
    options?.matchedKeywords?.length &&
    hasMatchedKeywordInSearchBox(lower, options.matchedKeywords)
  ) {
    return false;
  }
  return true;
}

/** Escape a keyword for use inside a RegExp (spaces → flexible whitespace). */
function escapeKeywordForRegExp(keyword: string): string {
  return keyword
    .toLowerCase()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+');
}

/**
 * True when a keyword-filter hit appears as the Chrome/Google search-box query
 * (OCR forms: "Q zebi", "+ Q zebi"), not only in result-body titles.
 */
export function hasMatchedKeywordInSearchBox(
  text: string,
  matchedKeywords: string[],
): boolean {
  if (!matchedKeywords.length) {
    return false;
  }
  const lower = text.toLowerCase();
  for (const kw of matchedKeywords) {
    const trimmed = kw.trim();
    if (!trimmed) {
      continue;
    }
    const escaped = escapeKeywordForRegExp(trimmed);
    const searchBoxRe = new RegExp(`(?:^|[\\s+(])q\\s+${escaped}\\b`, 'i');
    if (searchBoxRe.test(lower)) {
      return true;
    }
  }
  return false;
}

function isSearchHostContext(text: string): boolean {
  return SEARCH_HOST_RE.test(text.toLowerCase());
}

/** Browser search UI with an explicit adult query term. */
export function isRiskyAdultWebSearchContext(text: string): boolean {
  const lower = text.toLowerCase();
  if (isFilteredSearchResultsContext(lower)) {
    return isSearchHostContext(text) && hasExplicitAdultGoogleSearchIntent(text);
  }
  return isSearchHostContext(text) && ADULT_EXPLICIT_QUERY_RE.test(lower);
}

/** Browser search UI with violent / gore query terms (e.g. Google Images + gore). */
export function isRiskyViolentWebSearchContext(text: string): boolean {
  const lower = text.toLowerCase();
  if (isFilteredSearchResultsContext(lower)) {
    return isSearchHostContext(text) && VIOLENT_SEARCH_BOX_QUERY_RE.test(lower);
  }
  return isSearchHostContext(text) && VIOLENT_EXPLICIT_QUERY_RE.test(lower);
}

/** @deprecated Use isRiskyAdultWebSearchContext — kept for tests. */
export function isRiskyWebSearchContext(text: string): boolean {
  return isRiskyAdultWebSearchContext(text) || isRiskyViolentWebSearchContext(text);
}

/**
 * Boost keyword outcome when the child is searching for explicit or violent terms.
 */
export function applyRiskySearchBoost(
  text: string,
  result: KeywordFilterResult,
): KeywordFilterResult {
  const matched = new Set(result.matchedKeywords.map((k) => k.toLowerCase()));

  if (isAdultSiteUrlContext(text)) {
    for (const site of findAdultSiteMatches(text)) {
      matched.add(site);
    }
    return {
      riskFlag: true,
      category: 'adult',
      matchedKeywords: [...matched],
    };
  }

  if (isRiskyAdultWebSearchContext(text)) {
    matched.add('nsfw');
    return {
      riskFlag: true,
      category: 'adult',
      matchedKeywords: [...matched],
    };
  }

  if (isRiskyViolentWebSearchContext(text)) {
    matched.add('gore');
    return {
      riskFlag: true,
      category: 'violent',
      matchedKeywords: [...matched],
    };
  }

  return result;
}
