import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import {
  parseIfNoneMatch,
  evaluateConditionalGet,
  buildNotModifiedPlan,
} from '../src/conditional-get.js';

const app = buildApp();
const URL = '/get-plan';

const ETAG = '"v1-a1b2c3"';
const WEAK_ETAG = `W/${ETAG}`;
const LM = 'Wed, 21 Oct 2015 07:28:00 GMT';

function getPlan({
  size = 1000,
  contentType,
  etag,
  lastModified,
  range,
  ifRange,
  ifNoneMatch,
  ifModifiedSince,
  headers: extraHeaders = {},
  method = 'POST',
}) {
  const headers = { 'content-type': 'application/json' };
  if (range !== undefined) headers.Range = range;
  if (ifRange !== undefined) headers['If-Range'] = ifRange;
  if (ifNoneMatch !== undefined) headers['If-None-Match'] = ifNoneMatch;
  if (ifModifiedSince !== undefined) headers['If-Modified-Since'] = ifModifiedSince;
  Object.assign(headers, extraHeaders);

  const body = {
    size,
    ...(contentType ? { contentType } : {}),
    ...(etag !== undefined ? { etag } : {}),
    ...(lastModified !== undefined ? { lastModified } : {}),
  };

  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) query.set(k, String(v));

  return app.inject({
    method,
    url: method === 'GET' ? `${URL}?${query.toString()}` : URL,
    headers,
    payload: method === 'POST' ? JSON.stringify(body) : undefined,
  });
}

// ---------- No conditional fields ----------

test('plain GET without Range plans the full 200 representation', async () => {
  const res = await getPlan({ etag: ETAG, lastModified: LM, contentType: 'video/mp4' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.statusCode, 200);
  assert.equal(body.decision, 'full');
  assert.equal(body.segmentsCount, null);
  assert.equal(body.segments, null);
  assert.equal(body.multipart, null);
  assert.equal(body.bytes.total, 1000);
  assert.deepEqual(body.responseHeaders, {
    'Accept-Ranges': 'bytes',
    'Content-Type': 'video/mp4',
    'Content-Length': '1000',
    ETag: ETAG,
    'Last-Modified': LM,
  });
  assert.equal(body.precondition, undefined);
});

test('plain GET on an empty resource plans Content-Length 0', async () => {
  const res = await getPlan({ size: 0 });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().responseHeaders['Content-Length'], '0');
});

test('GET form without Range also plans the full representation', async () => {
  const res = await getPlan({ method: 'GET', etag: ETAG });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().decision, 'full');
});

test('a Range without conditionals is honoured exactly like /plan', async () => {
  const res = await getPlan({ range: 'bytes=0-99', etag: ETAG });
  assert.equal(res.statusCode, 206);
  const body = res.json();
  assert.equal(body.decision, 'partial');
  assert.equal(body.segmentsCount, 1);
  assert.equal(body.responseHeaders['Content-Range'], 'bytes 0-99/1000');
  assert.equal(body.responseHeaders['Content-Length'], '100');
  assert.equal(body.precondition, undefined);
});

test('an unsatisfiable Range without conditionals yields 416', async () => {
  const res = await getPlan({ size: 100, range: 'bytes=500-600', etag: ETAG });
  assert.equal(res.statusCode, 416);
  assert.equal(res.json().responseHeaders['Content-Range'], 'bytes */100');
});

test('a malformed Range without conditionals yields 400', async () => {
  const res = await getPlan({ range: 'bytes=abc' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'MALFORMED_RANGE');
});

// ---------- If-None-Match: 304 plans ----------

test('If-None-Match equal to the current ETag plans 304', async () => {
  const res = await getPlan({ etag: ETAG, lastModified: LM, ifNoneMatch: ETAG });
  assert.equal(res.statusCode, 200); // transport envelope, see X-Planned-Status
  assert.equal(res.headers['x-planned-status'], '304');
  const body = res.json();
  assert.equal(body.statusCode, 304);
  assert.equal(body.decision, 'not-modified');
  assert.equal(body.segments, null);
  assert.equal(body.segmentsCount, null);
  assert.equal(body.bytes, null);
  assert.equal(body.multipart, null);
  assert.deepEqual(body.responseHeaders, {
    ETag: ETAG,
    'Last-Modified': LM,
  });
  assert.deepEqual(body.precondition, {
    header: 'If-None-Match',
    outcome: 'matched',
    reason: 'etag-match',
  });
});

test('304 keeps only the validator headers that were supplied', async () => {
  const res = await getPlan({ etag: ETAG, ifNoneMatch: ETAG });
  const headers = res.json().responseHeaders;
  assert.deepEqual(Object.keys(headers).sort(), ['ETag']);
  assert.equal(headers['Content-Length'], undefined);
  assert.equal(headers['Content-Range'], undefined);
  assert.equal(headers['Accept-Ranges'], undefined);
});

test('304 via wildcard with no metadata has empty validator headers', async () => {
  const res = await getPlan({ ifNoneMatch: '*' });
  assert.equal(res.headers['x-planned-status'], '304');
  const body = res.json();
  assert.equal(body.statusCode, 304);
  assert.deepEqual(body.responseHeaders, {});
  assert.equal(body.precondition.reason, 'wildcard');
});

test('If-None-Match "*" matches an existing resource even on a 0-byte one', async () => {
  const res = await getPlan({ size: 0, ifNoneMatch: '*' });
  assert.equal(res.headers['x-planned-status'], '304');
  assert.equal(res.json().statusCode, 304);
});

test('If-None-Match matches any member of a tag list', async () => {
  const res = await getPlan({ etag: ETAG, ifNoneMatch: `"a", ${ETAG}, "b"` });
  assert.equal(res.headers['x-planned-status'], '304');
  assert.equal(res.json().precondition.reason, 'etag-match');
});

test('OWS around list members is tolerated', async () => {
  const res = await getPlan({ etag: ETAG, ifNoneMatch: `  ${ETAG}  ` });
  assert.equal(res.headers['x-planned-status'], '304');
});

test('weak comparison: a weak request tag matches a strong current ETag', async () => {
  const res = await getPlan({ etag: ETAG, ifNoneMatch: WEAK_ETAG });
  assert.equal(res.headers['x-planned-status'], '304');
  assert.equal(res.json().precondition.reason, 'etag-match');
});

test('weak comparison: a strong request tag matches a weak current ETag', async () => {
  const res = await getPlan({ etag: WEAK_ETAG, ifNoneMatch: ETAG });
  assert.equal(res.headers['x-planned-status'], '304');
  const echoed = res.json().responseHeaders.ETag;
  assert.equal(echoed, WEAK_ETAG); // current validator is echoed verbatim
});

test('weak comparison: two weak tags with the same opaque-tag match', async () => {
  const res = await getPlan({ etag: WEAK_ETAG, ifNoneMatch: WEAK_ETAG });
  assert.equal(res.headers['x-planned-status'], '304');
});

test('304 short-circuits before Range is parsed', async () => {
  // A malformed Range paired with a matching validator must still plan 304.
  const res = await getPlan({ etag: ETAG, ifNoneMatch: ETAG, range: 'bytes=garbage' });
  assert.equal(res.headers['x-planned-status'], '304');
  const body = res.json();
  assert.equal(body.statusCode, 304);
  assert.equal(body.segments, null);
});

test('304 short-circuits even when the Range is unsatisfiable (416 would otherwise apply)', async () => {
  const res = await getPlan({ size: 100, etag: ETAG, ifNoneMatch: ETAG, range: 'bytes=900-999' });
  assert.equal(res.headers['x-planned-status'], '304');
  assert.equal(res.json().statusCode, 304);
});

// ---------- If-None-Match: non-matching ----------

test('If-None-Match mismatch without Range plans the full 200', async () => {
  const res = await getPlan({ etag: ETAG, ifNoneMatch: '"other"' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.decision, 'full');
  assert.deepEqual(body.precondition, {
    header: 'If-None-Match',
    outcome: 'not-matched',
    reason: 'etag-mismatch',
  });
});

test('If-None-Match mismatch honours Range', async () => {
  const res = await getPlan({ etag: ETAG, ifNoneMatch: '"other"', range: 'bytes=0-9' });
  assert.equal(res.statusCode, 206);
  const body = res.json();
  assert.equal(body.segments[0].start, 0);
  assert.equal(body.segments[0].end, 9);
  assert.equal(body.precondition.reason, 'etag-mismatch');
});

test('If-None-Match list with no matching member honours Range', async () => {
  const res = await getPlan({ etag: ETAG, ifNoneMatch: '"a", "b"', range: 'bytes=0-9' });
  assert.equal(res.statusCode, 206);
  assert.equal(res.json().precondition.outcome, 'not-matched');
});

test('If-None-Match without current ETag metadata never matches', async () => {
  const res = await getPlan({ ifNoneMatch: ETAG, range: 'bytes=0-9' });
  assert.equal(res.statusCode, 206);
  assert.equal(res.json().precondition.reason, 'resource-metadata-missing');
});

// ---------- If-None-Match precedence over If-Modified-Since ----------

test('a present If-None-Match makes If-Modified-Since be ignored (match wins)', async () => {
  const res = await getPlan({
    etag: ETAG,
    lastModified: LM,
    ifNoneMatch: ETAG,
    ifModifiedSince: 'Tue, 20 Oct 2015 07:28:00 GMT', // stale, would say modified
  });
  assert.equal(res.headers['x-planned-status'], '304');
  assert.equal(res.json().precondition.header, 'If-None-Match');
});

test('a present but non-matching If-None-Match still ignores a matching If-Modified-Since', async () => {
  const res = await getPlan({
    etag: ETAG,
    lastModified: LM,
    ifNoneMatch: '"other"',
    ifModifiedSince: LM, // would say unmodified on its own
    range: 'bytes=0-9',
  });
  assert.equal(res.statusCode, 206);
  assert.equal(res.json().precondition.header, 'If-None-Match');
});

test('a malformed If-None-Match is 400 even when If-Modified-Since would yield 304', async () => {
  const res = await getPlan({
    lastModified: LM,
    ifNoneMatch: 'junk',
    ifModifiedSince: LM,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'MALFORMED_IF_NONE_MATCH');
});

// ---------- If-Modified-Since ----------

test('If-Modified-Since later than Last-Modified plans 304', async () => {
  const res = await getPlan({
    lastModified: LM,
    ifModifiedSince: 'Thu, 22 Oct 2015 07:28:00 GMT',
  });
  assert.equal(res.headers['x-planned-status'], '304');
  const body = res.json();
  assert.equal(body.statusCode, 304);
  assert.deepEqual(body.responseHeaders, { 'Last-Modified': LM });
  assert.deepEqual(body.precondition, {
    header: 'If-Modified-Since',
    outcome: 'matched',
    reason: 'not-modified-since',
  });
});

test('If-Modified-Since equal to Last-Modified plans 304', async () => {
  const res = await getPlan({ lastModified: LM, ifModifiedSince: LM });
  assert.equal(res.headers['x-planned-status'], '304');
  assert.equal(res.json().precondition.reason, 'not-modified-since');
});

test('If-Modified-Since earlier than Last-Modified plans the full 200', async () => {
  const res = await getPlan({
    lastModified: LM,
    ifModifiedSince: 'Tue, 20 Oct 2015 07:28:00 GMT',
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.decision, 'full');
  assert.deepEqual(body.precondition, {
    header: 'If-Modified-Since',
    outcome: 'not-matched',
    reason: 'modified-after',
  });
});

test('If-Modified-Since modified + Range honours the range (206)', async () => {
  const res = await getPlan({
    lastModified: LM,
    ifModifiedSince: 'Tue, 20 Oct 2015 07:28:00 GMT',
    range: 'bytes=10-19, 500-509',
  });
  assert.equal(res.statusCode, 206);
  assert.equal(res.json().segmentsCount, 2);
  assert.equal(res.json().precondition.reason, 'modified-after');
});

test('If-Modified-Since match short-circuits Range (malformed Range stays 304)', async () => {
  const res = await getPlan({
    lastModified: LM,
    ifModifiedSince: LM,
    range: 'bytes=garbage',
  });
  assert.equal(res.headers['x-planned-status'], '304');
  assert.equal(res.json().statusCode, 304);
});

test('an invalid If-Modified-Since date is treated as absent (no precondition block)', async () => {
  const res = await getPlan({ lastModified: LM, ifModifiedSince: 'not-a-date' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().decision, 'full');
  assert.equal(res.json().precondition, undefined);
});

test('an invalid If-Modified-Since with Range falls through to normal range planning', async () => {
  const res = await getPlan({ lastModified: LM, ifModifiedSince: '21 Oct 2015', range: 'bytes=0-9' });
  assert.equal(res.statusCode, 206);
  assert.equal(res.json().precondition, undefined);
});

test('If-Modified-Since without current Last-Modified metadata does not match', async () => {
  const res = await getPlan({ ifModifiedSince: LM });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().precondition.reason, 'resource-metadata-missing');
});

test('If-Modified-Since accepts an RFC 850 date and matches the same instant', async () => {
  const res = await getPlan({
    lastModified: LM,
    ifModifiedSince: 'Wednesday, 21-Oct-15 07:28:00 GMT',
  });
  assert.equal(res.headers['x-planned-status'], '304');
});

// ---------- If-Range interactions on the non-304 path ----------

test('non-matching validator + failing If-Range downgrades to 200 with both blocks', async () => {
  const res = await getPlan({
    etag: ETAG,
    ifNoneMatch: '"other"',
    ifRange: '"old"',
    range: 'bytes=0-9',
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.decision, 'full');
  assert.equal(body.precondition.header, 'If-None-Match');
  assert.deepEqual(body.condition, {
    header: 'If-Range',
    validatorKind: 'etag',
    outcome: 'failed',
    reason: 'etag-mismatch',
  });
});

test('non-matching validator + passing If-Range keeps 206', async () => {
  const res = await getPlan({
    etag: ETAG,
    ifNoneMatch: '"other"',
    ifRange: ETAG,
    range: 'bytes=0-9',
  });
  assert.equal(res.statusCode, 206);
  assert.equal(res.json().condition.reason, 'etag-match');
});

// ---------- 400 errors ----------

test('malformed If-None-Match (bare token) is 400 MALFORMED_IF_NONE_MATCH', async () => {
  for (const bad of ['junk', '"unterminated', '"x"junk', '', '   ', '"a", junk', 'W/x']) {
    const res = await getPlan({ ifNoneMatch: bad });
    assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(bad)}`);
    assert.equal(
      res.json().code,
      'MALFORMED_IF_NONE_MATCH',
      `expected code for ${JSON.stringify(bad)}`,
    );
  }
});

test('wildcard mixed into a tag list is 400', async () => {
  const res = await getPlan({ ifNoneMatch: '*, "a"' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'MALFORMED_IF_NONE_MATCH');
});

test('empty list member is 400', async () => {
  const res = await getPlan({ ifNoneMatch: '"a", , "b"' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'MALFORMED_IF_NONE_MATCH');
});

test('illegal resource metadata is 400', async () => {
  const etagRes = await getPlan({ etag: 'no-quotes', ifNoneMatch: '"x"' });
  assert.equal(etagRes.statusCode, 400);
  assert.equal(etagRes.json().code, 'INVALID_ETAG');

  const lmRes = await getPlan({ lastModified: 'nonsense', ifModifiedSince: LM });
  assert.equal(lmRes.statusCode, 400);
  assert.equal(lmRes.json().code, 'INVALID_LAST_MODIFIED');
});

test('illegal metadata is 400 even when a wildcard would otherwise plan 304', async () => {
  const res = await getPlan({ lastModified: 'nonsense', ifNoneMatch: '*' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'INVALID_LAST_MODIFIED');
});

test('If-None-Match with CR/LF is 400 at the edge', async () => {
  const res = await getPlan({ ifNoneMatch: '"v1"\r' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'MALFORMED_IF_NONE_MATCH');
});

// ---------- Core module unit tests ----------

test('parseIfNoneMatch parses wildcard, strong and weak tags', () => {
  assert.deepEqual(parseIfNoneMatch('*'), { tags: [], wildcard: true });
  assert.deepEqual(parseIfNoneMatch(ETAG), { tags: [ETAG], wildcard: false });
  assert.deepEqual(parseIfNoneMatch(` ${ETAG} , "x" `), { tags: [ETAG, '"x"'], wildcard: false });
  assert.deepEqual(parseIfNoneMatch(WEAK_ETAG), { tags: [WEAK_ETAG], wildcard: false });
});

test('parseIfNoneMatch rejects malformed values', () => {
  for (const bad of [
    undefined,
    '',
    '   ',
    'junk',
    '"unterminated',
    '"x" junk',
    'W/notquoted',
    '*, "x"',
    '"a", junk',
    '"a",, "b"',
    ',"a"',
    '"a",',
  ]) {
    const result = parseIfNoneMatch(bad);
    assert.equal(result.error, true, `expected error for ${JSON.stringify(bad)}`);
    assert.equal(result.code, 'MALFORMED_IF_NONE_MATCH');
  }
});

test('evaluateConditionalGet: INM present suppresses IMS entirely', async () => {
  // INM matches; IMS is stale (which must not matter).
  let r = evaluateConditionalGet({
    ifNoneMatch: ETAG,
    ifModifiedSince: 'Tue, 20 Oct 2015 07:28:00 GMT',
    etag: ETAG,
    lastModified: LM,
  });
  assert.equal(r.notModified, true);
  assert.equal(r.precondition.header, 'If-None-Match');

  // Malformed INM surfaces as fieldError even with a matching IMS.
  r = evaluateConditionalGet({ ifNoneMatch: 'junk', ifModifiedSince: LM, lastModified: LM });
  assert.equal(r.notModified, false);
  assert.equal(r.fieldError.code, 'MALFORMED_IF_NONE_MATCH');
});

test('evaluateConditionalGet: weak comparison rules', () => {
  // weak request vs strong current
  assert.equal(
    evaluateConditionalGet({ ifNoneMatch: WEAK_ETAG, etag: ETAG }).notModified,
    true,
  );
  // strong request vs weak current
  assert.equal(
    evaluateConditionalGet({ ifNoneMatch: ETAG, etag: WEAK_ETAG }).notModified,
    true,
  );
  // different opaque-tags do not match
  assert.equal(
    evaluateConditionalGet({ ifNoneMatch: '"other"', etag: ETAG }).notModified,
    false,
  );
});

test('evaluateConditionalGet: IMS validity matrix', () => {
  // both valid, resource not newer -> unmodified
  assert.equal(
    evaluateConditionalGet({ ifModifiedSince: LM, lastModified: LM }).notModified,
    true,
  );
  assert.equal(
    evaluateConditionalGet({
      ifModifiedSince: 'Thu, 22 Oct 2015 07:28:00 GMT',
      lastModified: LM,
    }).notModified,
    true,
  );
  // resource newer -> modified
  assert.equal(
    evaluateConditionalGet({
      ifModifiedSince: 'Tue, 20 Oct 2015 07:28:00 GMT',
      lastModified: LM,
    }).notModified,
    false,
  );
  // invalid request date -> treated as absent
  const ignored = evaluateConditionalGet({ ifModifiedSince: 'junk', lastModified: LM });
  assert.equal(ignored.notModified, false);
  assert.equal(ignored.precondition, null);
  // valid request date but missing resource metadata
  const noMeta = evaluateConditionalGet({ ifModifiedSince: LM });
  assert.equal(noMeta.notModified, false);
  assert.equal(noMeta.precondition.reason, 'resource-metadata-missing');
});

test('evaluateConditionalGet with no fields does nothing', () => {
  const r = evaluateConditionalGet({ etag: ETAG, lastModified: LM });
  assert.equal(r.notModified, false);
  assert.equal(r.precondition, null);
  assert.equal(r.fieldError, undefined);
});

test('buildNotModifiedPlan echoes only supplied validators', () => {
  assert.deepEqual(buildNotModifiedPlan({ etag: ETAG, lastModified: LM }), {
    statusCode: 304,
    decision: 'not-modified',
    segmentsCount: null,
    segments: null,
    bytes: null,
    multipart: null,
    responseHeaders: { ETag: ETAG, 'Last-Modified': LM },
  });
  assert.deepEqual(buildNotModifiedPlan().responseHeaders, {});
});
