// Conditional GET response planning (RFC 9110 §13.1.2 / §13.1.4 / §13.2).
//
// Plans the response an origin would send to a GET request for an existing
// resource, given the resource metadata (size, contentType, etag,
// lastModified) and the request's conditional/range header fields
// (If-None-Match, If-Modified-Since, Range, If-Range):
//
//   1. If-None-Match present  -> weak comparison against the current etag
//      ("*" matches any existing resource). A match selects 304 and the
//      If-Modified-Since field is ignored entirely, as is Range.
//   2. Otherwise a valid If-Modified-Since whose date is not earlier than
//      the current Last-Modified also selects 304. An invalid
//      If-Modified-Since is treated as if the field had not been sent.
//   3. Otherwise a Range header is planned with the same rules as /plan
//      (including If-Range); without Range the full representation (200)
//      is planned.
//
// A 304 plan keeps only the validator headers (ETag / Last-Modified) and
// carries neither a body length nor segments; Range is never parsed.

import {
  DEFAULT_CONTENT_TYPE,
  DEFAULT_MAX_SEGMENTS,
  DEFAULT_TRANSFER_SIZE_RATIO,
  buildFullRepresentation,
  planRanges,
} from './planner.js';
import { evaluateIfModifiedSince, evaluateIfNoneMatch } from './conditional.js';

/**
 * Plan the response to a conditional GET request.
 *
 * @returns a result object whose `statusCode` is the status the origin would
 *          send: 304 (not modified), 200 (full representation), or the
 *          /plan outcomes 206/416/422 when a Range header is present.
 *          A 400 result means a conditional field or the resource metadata
 *          was malformed.
 */
export function planGet(options) {
  const {
    size,
    contentType = DEFAULT_CONTENT_TYPE,
    maxSegments = DEFAULT_MAX_SEGMENTS,
    transferSizeRatio = DEFAULT_TRANSFER_SIZE_RATIO,
    etag,
    lastModified,
    ifNoneMatch,
    ifModifiedSince,
    rangeHeader,
    ifRange,
  } = options;

  if (!Number.isSafeInteger(size) || size < 0) {
    return fail(400, 'INVALID_SIZE', 'size must be a non-negative safe integer');
  }
  if (typeof contentType !== 'string' || /[\r\n]/.test(contentType) || contentType.length === 0) {
    return fail(400, 'INVALID_CONTENT_TYPE', 'contentType must be a single header-safe string');
  }
  if (etag !== undefined && (typeof etag !== 'string' || /[\r\n]/.test(etag) || etag.length === 0)) {
    return fail(400, 'INVALID_ETAG', 'etag must be a single header-safe entity-tag string');
  }
  if (
    lastModified !== undefined &&
    (typeof lastModified !== 'string' || /[\r\n]/.test(lastModified) || lastModified.length === 0)
  ) {
    return fail(400, 'INVALID_LAST_MODIFIED', 'lastModified must be a single header-safe HTTP-date string');
  }
  for (const [code, value] of [
    ['INVALID_IF_NONE_MATCH', ifNoneMatch],
    ['INVALID_IF_MODIFIED_SINCE', ifModifiedSince],
    ['INVALID_IF_RANGE', ifRange],
  ]) {
    if (value !== undefined && (typeof value !== 'string' || /[\r\n]/.test(value))) {
      return fail(400, code, 'conditional header fields must be single header-safe strings');
    }
  }

  // RFC 9110 §13.2.2: If-None-Match takes precedence over If-Modified-Since,
  // and both take precedence over Range/If-Range.
  let precondition = null;
  if (ifNoneMatch !== undefined) {
    const outcome = evaluateIfNoneMatch({ ifNoneMatch, etag });
    if (outcome.malformed) {
      return fail(
        400,
        'MALFORMED_IF_NONE_MATCH',
        'If-None-Match must be "*" or a comma-separated list of entity-tags',
      );
    }
    precondition = {
      header: 'If-None-Match',
      outcome: outcome.matched ? 'not-modified' : 'passed',
      reason: outcome.reason,
    };
    if (outcome.matched) {
      return buildNotModified({ size, contentType, etag, lastModified, precondition });
    }
  } else if (ifModifiedSince !== undefined) {
    const outcome = evaluateIfModifiedSince({ ifModifiedSince, lastModified });
    // An invalid request date is treated as if the field had not been sent.
    if (outcome.applicable) {
      precondition = {
        header: 'If-Modified-Since',
        outcome: outcome.notModified ? 'not-modified' : 'passed',
        reason: outcome.reason,
      };
      if (outcome.notModified) {
        return buildNotModified({ size, contentType, etag, lastModified, precondition });
      }
    }
  }

  // Precondition passed (or none was sent): a Range header is planned with
  // the same rules as /plan, including If-Range; the 206/416/422/400 result
  // is passed through unchanged apart from the precondition report.
  if (rangeHeader !== undefined) {
    const result = planRanges({
      size,
      contentType,
      rangeHeader,
      maxSegments,
      transferSizeRatio,
      etag,
      lastModified,
      ifRange,
    });
    if (precondition) result.precondition = precondition;
    return result;
  }

  // No Range: the full representation would be sent. An If-Range field
  // without a Range field is ignored (RFC 9110 §13.1.3).
  const result = buildFullRepresentation({ size, contentType, etag, lastModified });
  if (precondition) result.precondition = precondition;
  return result;
}

/**
 * Build the 304 plan: only the current validator headers are kept; there is
 * no message body, hence no Content-Length and no segments, and Range is
 * never parsed.
 */
function buildNotModified({ size, contentType, etag, lastModified, precondition }) {
  const responseHeaders = {};
  if (etag !== undefined) responseHeaders.ETag = etag;
  if (lastModified !== undefined) responseHeaders['Last-Modified'] = lastModified;

  const resource = { size, contentType };
  if (etag !== undefined) resource.etag = etag;
  if (lastModified !== undefined) resource.lastModified = lastModified;

  return {
    statusCode: 304,
    decision: 'not-modified',
    resource,
    segmentsCount: null,
    segments: null,
    bytes: null,
    multipart: null,
    responseHeaders,
    precondition,
  };
}

function fail(statusCode, code, message) {
  return {
    statusCode,
    code,
    error: 'Bad Request',
    message,
  };
}
