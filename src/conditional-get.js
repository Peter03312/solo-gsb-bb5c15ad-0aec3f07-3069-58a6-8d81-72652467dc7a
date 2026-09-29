// RFC 9110 conditional GET planning (§13.1.1 If-None-Match / §13.1.3
// If-Modified-Since) for an *existing* resource.
//
// Precedence:
//   - If-None-Match is evaluated first; whenever the field is present (even
//     malformed-looking-but-present) If-Modified-Since is ignored.
//   - Without If-None-Match, If-Modified-Since is evaluated only when it
//     carries a valid HTTP-date AND the resource has a valid Last-Modified;
//     an invalid request date is treated as if the field were absent.
//   - On a match the plan is 304: only the current validator header(s) are
//     kept, Range is not evaluated and there is no body length or segments.
//   - Otherwise Range + If-Range follow the ordinary /plan rules when Range
//     is present; without Range the full 200 representation is planned.
//
// Transport note: RFC 9110 forbids a body on a real 304 and Node's HTTP stack
// physically drops anything written with that status. Plans with statusCode
// 304 are therefore delivered over HTTP 200 with an X-Planned-Status: 304
// response header (see app.js); the JSON body below is what the origin would
// have answered with.

import { ENTITY_TAG_RE, parseHttpDate } from './conditional.js';

// If-None-Match = "*" / 1#entity-tag  (RFC 9110 §13.1.1)
// Comma is illegal inside an entity-tag, so splitting on commas is safe;
// optional whitespace (OWS) is allowed around each list member.
const LIST_SPLIT_RE = /\s*,\s*/;

/**
 * Parse an If-None-Match field value.
 *
 * @returns {{tags: string[], wildcard: boolean} | {error: true, code: string,
 *   message: string}} A parsed descriptor, or a malformed-field error.
 *   `wildcard` is true exactly for the standalone "*" form; "*" mixed into a
 *   tag list is malformed. Empty members, stray tokens or bad entity-tags
 *   make the whole field malformed.
 */
export function parseIfNoneMatch(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return malformed('If-None-Match must be "*" or a comma-separated list of entity-tags');
  }

  const trimmed = value.trim();
  if (trimmed === '*') return { tags: [], wildcard: true };

  // A stray leading/trailing comma or a doubled comma leaves an empty member;
  // reject rather than silently dropping it.
  if (trimmed.startsWith(',') || trimmed.endsWith(',') || trimmed.includes(',,')) {
    return malformed('If-None-Match list contains an empty member');
  }

  const parts = trimmed.split(LIST_SPLIT_RE);
  for (const tag of parts) {
    if (tag === '*') {
      return malformed('If-None-Match "*" cannot be combined with other entity-tags');
    }
    if (!ENTITY_TAG_RE.test(tag)) {
      return malformed(
        `If-None-Match list member ${JSON.stringify(tag)} is not a valid entity-tag`,
      );
    }
  }
  return { tags: parts, wildcard: false };
}

function malformed(message) {
  return { error: true, code: 'MALFORMED_IF_NONE_MATCH', message };
}

/**
 * Weak entity-tag comparison (RFC 9110 §8.8.3.2): strip a case-sensitive
 * "W/" prefix from both sides, then compare the opaque-tags verbatim. Two
 * strong tags, a strong and a weak tag, or two weak tags therefore match on
 * identical opaque-tags.
 */
function weakCompare(tagA, tagB) {
  const opaque = (tag) => (tag.startsWith('W/') ? tag.slice(2) : tag);
  return opaque(tagA) === opaque(tagB);
}

/**
 * Evaluate the received validator fields against the current resource.
 *
 * @param {object} input
 * @param {string} [input.ifNoneMatch]      raw If-None-Match field value
 * @param {string} [input.ifModifiedSince]  raw If-Modified-Since field value
 * @param {string} [input.etag]             current resource ETag
 * @param {string} [input.lastModified]     current resource Last-Modified
 * @returns {{notModified: boolean, precondition: object,
 *   fieldError?: {code: string, message: string}}}
 *   `notModified` selects the 304 plan; `precondition` describes the
 *   evaluation for the response (it also records an ignored
 *   If-Modified-Since). `fieldError` flags a malformed If-None-Match that
 *   the edge must answer with 400.
 */
export function evaluateConditionalGet({ ifNoneMatch, ifModifiedSince, etag, lastModified } = {}) {
  // ---- If-None-Match takes precedence whenever the field is present. ----
  if (ifNoneMatch !== undefined) {
    const parsed = parseIfNoneMatch(ifNoneMatch);
    if (parsed.error) {
      return {
        notModified: false,
        precondition: { header: 'If-None-Match', outcome: 'error', reason: 'malformed' },
        fieldError: { code: parsed.code, message: parsed.message },
      };
    }

    if (parsed.wildcard) {
      // The resource exists (this planner only deals with existing ones),
      // so "*" always matches.
      return {
        notModified: true,
        precondition: {
          header: 'If-None-Match',
          outcome: 'matched',
          reason: 'wildcard',
        },
      };
    }

    if (typeof etag !== 'string') {
      return {
        notModified: false,
        precondition: {
          header: 'If-None-Match',
          outcome: 'not-matched',
          reason: 'resource-metadata-missing',
        },
      };
    }

    const matched = parsed.tags.some((tag) => weakCompare(tag, etag));
    return {
      notModified: matched,
      precondition: {
        header: 'If-None-Match',
        outcome: matched ? 'matched' : 'not-matched',
        reason: matched ? 'etag-match' : 'etag-mismatch',
      },
    };
  }

  // ---- If-Modified-Since, only with no If-None-Match. ----
  if (ifModifiedSince !== undefined) {
    const now = new Date();
    const requestTime = parseHttpDate(ifModifiedSince, now);

    // An invalid If-Modified-Since is treated as if the field were absent.
    if (requestTime === null) {
      return { notModified: false, precondition: null };
    }

    const currentTime = typeof lastModified === 'string' ? parseHttpDate(lastModified, now) : null;
    if (currentTime === null) {
      return {
        notModified: false,
        precondition: {
          header: 'If-Modified-Since',
          outcome: 'not-applicable',
          reason: 'resource-metadata-missing',
        },
      };
    }

    // Unmodified when the representation is not newer than the request date
    // (equal instants count as unmodified: the client echoed Last-Modified).
    const unmodified = currentTime <= requestTime;
    return {
      notModified: unmodified,
      precondition: {
        header: 'If-Modified-Since',
        outcome: unmodified ? 'matched' : 'not-matched',
        reason: unmodified ? 'not-modified-since' : 'modified-after',
      },
    };
  }

  return { notModified: false, precondition: null };
}

/**
 * Build the 304 Not Modified plan.
 *
 * Only the current validator header(s) supplied for the resource are echoed;
 * there is no Content-Length, no Content-Range and no segments.
 */
export function buildNotModifiedPlan({ etag, lastModified } = {}) {
  const responseHeaders = {};
  if (etag !== undefined) responseHeaders.ETag = etag;
  if (lastModified !== undefined) responseHeaders['Last-Modified'] = lastModified;

  const plan = {
    statusCode: 304,
    decision: 'not-modified',
    segmentsCount: null,
    segments: null,
    bytes: null,
    multipart: null,
    responseHeaders,
  };
  return plan;
}
