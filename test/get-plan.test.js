import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { buildApp } from '../src/app.js';

const app = buildApp();
const url = '/get-plan';

const ETAG = '"v1-a1b2c3"';
const LM = 'Wed, 21 Oct 2015 07:28:00 GMT';

function plan({
  size = 1000,
  range,
  contentType,
  etag,
  lastModified,
  ifNoneMatch,
  ifModifiedSince,
  ifRange,
  headers: extraHeaders,
  query,
  method = 'POST',
  body: rawBody,
}) {
  const headers = { 'content-type': 'application/json' };
  if (range !== undefined) headers.Range = range;
  if (ifNoneMatch !== undefined) headers['If-None-Match'] = ifNoneMatch;
  if (ifModifiedSince !== undefined) headers['If-Modified-Since'] = ifModifiedSince;
  if (ifRange !== undefined) headers['If-Range'] = ifRange;
  Object.assign(headers, extraHeaders ?? {});

  const body = rawBody ?? {
    size,
    ...(contentType ? { contentType } : {}),
    ...(etag !== undefined ? { etag } : {}),
    ...(lastModified !== undefined ? { lastModified } : {}),
  };

  return app.inject({
    method,
    url: query ?? url,
    headers,
    payload: method === 'POST' ? JSON.stringify(body) : undefined,
  });
}

// ---------- plain GET without any conditional ----------

test('no conditional and no Range plans the full representation (200)', async () => {
  const res = await plan({ size: 1000, etag: ETAG, lastModified: LM });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.statusCode, 200);
  assert.equal(body.decision, 'full');
  assert.equal(body.segmentsCount, null);
  assert.equal(body.segments, null);
  assert.deepEqual(body.bytes, { selected: 1000, framing: 0, total: 1000, resource: 1000, ratio: 1 });
  assert.deepEqual(body.responseHeaders, {
    'Accept-Ranges': 'bytes',
    'Content-Type': 'application/octet-stream',
    'Content-Length': '1000',
    ETag: ETAG,
    'Last-Modified': LM,
  });
  assert.equal(body.precondition, undefined);
  assert.equal(body.condition, undefined);
});

test('Range without conditionals is planned exactly like /plan (206)', async () => {
  const res = await plan({ size: 10000, range: 'bytes=0-99', contentType: 'video/mp4' });
  assert.equal(res.statusCode, 206);
  const body = res.json();
  assert.equal(body.decision, 'partial');
  assert.equal(body.segmentsCount, 1);
  assert.equal(body.responseHeaders['Content-Range'], 'bytes 0-99/10000');
  assert.equal(body.responseHeaders['Content-Length'], '100');
  assert.equal(body.precondition, undefined);
});

test('If-Range without a Range header is ignored', async () => {
  const res = await plan({ size: 1000, etag: ETAG, ifRange: '"stale"' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.decision, 'full');
  assert.equal(body.condition, undefined);
  assert.equal(body.responseHeaders['Content-Length'], '1000');
});

// ---------- If-None-Match ----------

test('If-None-Match equal to the current ETag yields a 304 plan', async () => {
  const res = await plan({ size: 1000, etag: ETAG, lastModified: LM, ifNoneMatch: ETAG });
  assert.equal(res.statusCode, 200, 'a 304 plan is transported as 200');
  const body = res.json();
  assert.equal(body.statusCode, 304);
  assert.equal(body.decision, 'not-modified');
  assert.deepEqual(body.precondition, {
    header: 'If-None-Match',
    outcome: 'not-modified',
    reason: 'etag-weak-match',
  });
  // Only the validator headers are kept: no Content-Length/Content-Type,
  // no Accept-Ranges, no segments and no body accounting.
  assert.deepEqual(body.responseHeaders, { ETag: ETAG, 'Last-Modified': LM });
  assert.equal(body.segmentsCount, null);
  assert.equal(body.segments, null);
  assert.equal(body.bytes, null);
  assert.equal(body.multipart, null);
  assert.equal(body.resource.etag, ETAG);
  assert.equal(body.resource.lastModified, LM);
});

test('If-None-Match matches any tag in a comma-separated list', async () => {
  const res = await plan({ size: 1000, etag: ETAG, ifNoneMatch: `"other", ${ETAG} , "third"` });
  assert.equal(res.json().statusCode, 304);
  assert.equal(res.json().precondition.reason, 'etag-weak-match');
});

test('If-None-Match uses weak comparison: weak listed tag matches strong current etag', async () => {
  const res = await plan({ size: 1000, etag: ETAG, ifNoneMatch: `W/${ETAG}` });
  assert.equal(res.json().statusCode, 304);
  assert.equal(res.json().precondition.reason, 'etag-weak-match');
});

test('If-None-Match uses weak comparison: strong listed tag matches weak current etag', async () => {
  const res = await plan({ size: 1000, etag: `W/${ETAG}`, ifNoneMatch: ETAG });
  assert.equal(res.json().statusCode, 304);
  assert.equal(res.json().precondition.reason, 'etag-weak-match');
});

test('If-None-Match weak tag against the same weak current etag matches', async () => {
  const res = await plan({ size: 1000, etag: `W/${ETAG}`, ifNoneMatch: `W/${ETAG}` });
  assert.equal(res.json().statusCode, 304);
});

test('If-None-Match opaque-tags are still compared verbatim', async () => {
  const res = await plan({ size: 1000, etag: ETAG, ifNoneMatch: '"V1-A1B2C3"' });
  assert.equal(res.json().statusCode, 200);
  assert.equal(res.json().precondition.reason, 'no-match');
});

test('If-None-Match "*" matches any existing resource, even without etag metadata', async () => {
  for (const body of [{ size: 1000 }, { size: 1000, etag: ETAG }]) {
    const res = await plan({ body, ifNoneMatch: '*' });
    assert.equal(res.json().statusCode, 304);
    assert.equal(res.json().precondition.reason, 'star-match');
  }
});

test('If-None-Match "*" tolerates surrounding whitespace', async () => {
  const res = await plan({ size: 1000, ifNoneMatch: '  *\t' });
  assert.equal(res.json().statusCode, 304);
  assert.equal(res.json().precondition.reason, 'star-match');
});

test('If-None-Match without a match falls through to the full plan', async () => {
  const res = await plan({ size: 1000, etag: ETAG, ifNoneMatch: '"stale"' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.statusCode, 200);
  assert.equal(body.decision, 'full');
  assert.deepEqual(body.precondition, {
    header: 'If-None-Match',
    outcome: 'passed',
    reason: 'no-match',
  });
  assert.equal(body.responseHeaders['Content-Length'], '1000');
});

test('If-None-Match without a match and a Range header yields 206', async () => {
  const res = await plan({ size: 1000, etag: ETAG, ifNoneMatch: '"stale"', range: 'bytes=0-99' });
  assert.equal(res.statusCode, 206);
  const body = res.json();
  assert.equal(body.decision, 'partial');
  assert.equal(body.precondition.outcome, 'passed');
  assert.equal(body.precondition.reason, 'no-match');
  assert.equal(body.responseHeaders['Content-Range'], 'bytes 0-99/1000');
});

test('If-None-Match tag list without current etag metadata cannot match', async () => {
  const res = await plan({ size: 1000, ifNoneMatch: ETAG });
  assert.equal(res.json().statusCode, 200);
  assert.deepEqual(res.json().precondition, {
    header: 'If-None-Match',
    outcome: 'passed',
    reason: 'resource-metadata-missing',
  });
});

test('empty list elements inside If-None-Match are ignored', async () => {
  const res = await plan({ size: 1000, etag: ETAG, ifNoneMatch: `"other", , ${ETAG}` });
  assert.equal(res.json().statusCode, 304);
});

test('empty entity-tag is a valid list member and matches an empty current etag', async () => {
  const res = await plan({ size: 1000, etag: '""', ifNoneMatch: '""' });
  assert.equal(res.json().statusCode, 304);
  assert.equal(res.json().precondition.reason, 'etag-weak-match');
});

test('malformed If-None-Match values are rejected with 400', async () => {
  for (const bad of [
    'no-quotes',          // bare token
    '"unterminated',      // unbalanced quote
    '"a" junk',           // trailing garbage in one element
    '"a", *',             // "*" mixed into a list
    '*,"a"',              // same, reversed
    '',                   // no validator at all
    ' , ',                // only empty list elements
    'W/',                 // weak prefix without a tag
    'W/"ok"extra',        // garbage after a weak tag
  ]) {
    const res = await plan({ size: 1000, etag: ETAG, ifNoneMatch: bad });
    assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(bad)}`);
    assert.equal(res.json().code, 'MALFORMED_IF_NONE_MATCH', `for ${JSON.stringify(bad)}`);
  }
});

test('a present If-None-Match makes If-Modified-Since irrelevant', async () => {
  // INM does not match -> 200, even though IMS alone would select 304.
  const res = await plan({
    size: 1000,
    etag: ETAG,
    lastModified: LM,
    ifNoneMatch: '"stale"',
    ifModifiedSince: LM,
  });
  assert.equal(res.json().statusCode, 200);
  assert.equal(res.json().precondition.header, 'If-None-Match');
  assert.equal(res.json().precondition.outcome, 'passed');
});

test('a matching If-None-Match selects 304 even with an invalid If-Modified-Since', async () => {
  const res = await plan({
    size: 1000,
    etag: ETAG,
    lastModified: LM,
    ifNoneMatch: ETAG,
    ifModifiedSince: 'not-a-date',
  });
  assert.equal(res.json().statusCode, 304);
  assert.equal(res.json().precondition.header, 'If-None-Match');
});

test('a 304 plan never parses the Range header', async () => {
  const res = await plan({ size: 1000, etag: ETAG, ifNoneMatch: ETAG, range: 'bytes=garbage' });
  assert.equal(res.json().statusCode, 304);
  assert.equal(res.json().decision, 'not-modified');
});

test('304 plan with only Last-Modified keeps just that validator', async () => {
  const res = await plan({ size: 1000, lastModified: LM, ifNoneMatch: '*' });
  assert.deepEqual(res.json().responseHeaders, { 'Last-Modified': LM });
});

test('304 plan without any validator metadata has empty response headers', async () => {
  const res = await plan({ size: 1000, ifNoneMatch: '*' });
  assert.deepEqual(res.json().responseHeaders, {});
});

// ---------- If-Modified-Since ----------

test('If-Modified-Since equal to Last-Modified yields a 304 plan', async () => {
  const res = await plan({ size: 1000, lastModified: LM, ifModifiedSince: LM });
  assert.equal(res.json().statusCode, 304);
  assert.deepEqual(res.json().precondition, {
    header: 'If-Modified-Since',
    outcome: 'not-modified',
    reason: 'date-not-later',
  });
  assert.deepEqual(res.json().responseHeaders, { 'Last-Modified': LM });
});

test('If-Modified-Since later than Last-Modified yields a 304 plan', async () => {
  const res = await plan({
    size: 1000,
    lastModified: LM,
    ifModifiedSince: 'Thu, 22 Oct 2015 07:28:00 GMT',
  });
  assert.equal(res.json().statusCode, 304);
  assert.equal(res.json().precondition.reason, 'date-not-later');
});

test('resource newer than If-Modified-Since falls through to the full plan', async () => {
  const res = await plan({
    size: 1000,
    lastModified: LM,
    ifModifiedSince: 'Tue, 20 Oct 2015 07:28:00 GMT',
  });
  assert.equal(res.json().statusCode, 200);
  const body = res.json();
  assert.equal(body.decision, 'full');
  assert.deepEqual(body.precondition, {
    header: 'If-Modified-Since',
    outcome: 'passed',
    reason: 'date-later',
  });
  assert.equal(body.responseHeaders['Content-Length'], '1000');
});

test('resource newer than If-Modified-Since with a Range header yields 206', async () => {
  const res = await plan({
    size: 1000,
    lastModified: LM,
    ifModifiedSince: 'Tue, 20 Oct 2015 07:28:00 GMT',
    range: 'bytes=-100',
  });
  assert.equal(res.statusCode, 206);
  const body = res.json();
  assert.equal(body.decision, 'partial');
  assert.equal(body.precondition.reason, 'date-later');
  assert.equal(body.segments[0].start, 900);
});

test('an invalid If-Modified-Since is treated as if the field were absent', async () => {
  for (const bad of ['not-a-date', '21 Oct 2015 07:28:00 GMT', 'Wed, 31 Feb 2015 07:28:00 GMT']) {
    const res = await plan({ size: 1000, lastModified: LM, ifModifiedSince: bad });
    assert.equal(res.json().statusCode, 200, `expected 200 for ${JSON.stringify(bad)}`);
    assert.equal(res.json().decision, 'full');
    assert.equal(res.json().precondition, undefined, `no precondition block for ${JSON.stringify(bad)}`);
  }
});

test('If-Modified-Since without lastModified metadata cannot select 304', async () => {
  const res = await plan({ size: 1000, ifModifiedSince: LM });
  assert.equal(res.json().statusCode, 200);
  assert.deepEqual(res.json().precondition, {
    header: 'If-Modified-Since',
    outcome: 'passed',
    reason: 'resource-metadata-missing',
  });
});

test('If-Modified-Since accepts RFC 850 and asctime dates for the same instant', async () => {
  for (const ims of ['Wednesday, 21-Oct-15 07:28:00 GMT', 'Wed Oct 21 07:28:00 2015']) {
    const res = await plan({ size: 1000, lastModified: LM, ifModifiedSince: ims });
    assert.equal(res.json().statusCode, 304, `expected 304 for ${JSON.stringify(ims)}`);
    assert.equal(res.json().precondition.reason, 'date-not-later');
  }
});

test('If-Modified-Since comparison uses the parsed instant across mixed formats', async () => {
  // lastModified as RFC 850, IMS as asctime one second earlier -> modified.
  const res = await plan({
    size: 1000,
    lastModified: 'Wednesday, 21-Oct-15 07:28:00 GMT',
    ifModifiedSince: 'Wed Oct 21 07:27:59 2015',
  });
  assert.equal(res.json().statusCode, 200);
  assert.equal(res.json().precondition.reason, 'date-later');
});

test('a 304 from If-Modified-Since never parses the Range header', async () => {
  const res = await plan({ size: 1000, lastModified: LM, ifModifiedSince: LM, range: 'bytes=garbage' });
  assert.equal(res.json().statusCode, 304);
});

// ---------- Range / If-Range interplay after the precondition passes ----------

test('Range and If-Range follow the existing /plan rules (If-Range failed -> 200 full)', async () => {
  const res = await plan({ size: 1000, etag: ETAG, range: 'bytes=0-99', ifRange: '"stale"' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.decision, 'full');
  assert.equal(body.condition.outcome, 'failed');
  assert.equal(body.condition.reason, 'etag-mismatch');
});

test('Range and If-Range follow the existing /plan rules (If-Range passed -> 206)', async () => {
  const res = await plan({
    size: 1000,
    etag: ETAG,
    ifNoneMatch: '"stale"',
    range: 'bytes=0-99',
    ifRange: ETAG,
  });
  assert.equal(res.statusCode, 206);
  const body = res.json();
  assert.equal(body.condition.outcome, 'passed');
  assert.equal(body.condition.reason, 'etag-match');
  assert.equal(body.precondition.reason, 'no-match');
});

test('unsatisfiable Range is passed through as 416', async () => {
  const res = await plan({ size: 100, range: 'bytes=500-600', etag: ETAG });
  assert.equal(res.statusCode, 416);
  const body = res.json();
  assert.equal(body.code, 'RANGE_NOT_SATISFIABLE');
  assert.equal(body.responseHeaders['Content-Range'], 'bytes */100');
});

test('segment and transfer guards are passed through as 422', async () => {
  const specs = Array.from({ length: 17 }, (_, i) => `${i * 10}-${i * 10 + 1}`).join(',');
  const res = await plan({ size: 1000, range: `bytes=${specs}` });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().code, 'TOO_MANY_SEGMENTS');
});

test('malformed Range without a matching precondition is a 400', async () => {
  const res = await plan({ size: 1000, range: 'bytes=garbage' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'MALFORMED_RANGE');
});

// ---------- request-level validation ----------

test('invalid resource metadata is rejected with 400', async () => {
  let res = await plan({ size: 1000, etag: 'no-quotes', ifNoneMatch: ETAG });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'INVALID_ETAG');

  res = await plan({ size: 1000, lastModified: 'not-a-date', ifModifiedSince: LM });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'INVALID_LAST_MODIFIED');
});

test('invalid contentType is rejected with 400', async () => {
  const res = await plan({ size: 1000, contentType: 'not a type' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'INVALID_CONTENT_TYPE');
});

test('CR/LF inside If-None-Match or If-Modified-Since is rejected with 400', async () => {
  let res = await plan({ size: 1000, ifNoneMatch: '"v1"\r' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'INVALID_IF_NONE_MATCH');

  res = await plan({ size: 1000, ifModifiedSince: `${LM}\n` });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'INVALID_IF_MODIFIED_SINCE');
});

test('overlong conditional headers are rejected with 400', async () => {
  const long = `"${'a'.repeat(5000)}"`;
  const res = await plan({ size: 1000, ifNoneMatch: long });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'INVALID_IF_NONE_MATCH');
});

test('missing size is rejected with 400; body validation mirrors /plan', async () => {
  const res = await plan({ body: {} });
  assert.equal(res.statusCode, 400);

  // Like POST /plan, unknown properties are stripped and scalar types are
  // coerced by the shared (non-strict) body validator.
  const stripped = await plan({ body: { size: 1000, bogus: 1 } });
  assert.equal(stripped.statusCode, 200);
  const coerced = await plan({ body: { size: '1000' } });
  assert.equal(coerced.statusCode, 200);
});

test('planner defends itself against invalid input when called directly', async () => {
  const { planGet } = await import('../src/get-plan.js');
  assert.equal(planGet({ size: -1 }).code, 'INVALID_SIZE');
  assert.equal(planGet({ size: 1.5 }).code, 'INVALID_SIZE');
  assert.equal(planGet({ size: 10, contentType: 'a/b\r\n' }).code, 'INVALID_CONTENT_TYPE');
  assert.equal(planGet({ size: 10, etag: 'x\r' }).code, 'INVALID_ETAG');
  assert.equal(planGet({ size: 10, lastModified: 'x\n' }).code, 'INVALID_LAST_MODIFIED');
  assert.equal(planGet({ size: 10, ifNoneMatch: 42 }).code, 'INVALID_IF_NONE_MATCH');
  assert.equal(planGet({ size: 10, ifModifiedSince: 42 }).code, 'INVALID_IF_MODIFIED_SINCE');
  assert.equal(planGet({ size: 10, ifRange: 42 }).code, 'INVALID_IF_RANGE');
});

// ---------- GET variant ----------

test('GET /get-plan evaluates If-None-Match from query params and headers', async () => {
  const res = await plan({
    method: 'GET',
    query: `/get-plan?size=1000&etag=${encodeURIComponent(ETAG)}&lastModified=${encodeURIComponent(LM)}`,
    ifNoneMatch: ETAG,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.statusCode, 304);
  assert.equal(body.precondition.reason, 'etag-weak-match');
  assert.deepEqual(body.responseHeaders, { ETag: ETAG, 'Last-Modified': LM });
});

test('GET /get-plan evaluates If-Modified-Since and Range together', async () => {
  const res = await plan({
    method: 'GET',
    query: `/get-plan?size=1000&lastModified=${encodeURIComponent(LM)}`,
    ifModifiedSince: 'Tue, 20 Oct 2015 07:28:00 GMT',
    range: 'bytes=0-9',
  });
  assert.equal(res.statusCode, 206);
  const body = res.json();
  assert.equal(body.precondition.reason, 'date-later');
  assert.equal(body.responseHeaders['Content-Range'], 'bytes 0-9/1000');
});

test('GET /get-plan rejects invalid size and duplicate metadata params', async () => {
  let res = await plan({ method: 'GET', query: '/get-plan?size=abc' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'INVALID_SIZE');

  res = await plan({ method: 'GET', query: `/get-plan?size=1&etag=${encodeURIComponent(ETAG)}&etag=${encodeURIComponent(ETAG)}` });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'DUPLICATE_ETAG_PARAMETER');
});

// ---------- duplicate conditional fields (raw sockets) ----------

const rawApp = buildApp();
await rawApp.listen({ port: 0, host: '127.0.0.1' });
const rawPort = rawApp.server.address().port;
after(async () => rawApp.close());

function rawRequest(lines, body = '') {
  return new Promise((resolve, reject) => {
    const sock = net.connect(rawPort, '127.0.0.1', () => {
      sock.write([...lines, '', body].join('\r\n'));
    });
    let data = '';
    sock.setTimeout(5000, () => { sock.destroy(); reject(new Error('timeout')); });
    sock.on('data', (chunk) => { data += chunk; });
    sock.on('end', () => resolve(data));
    sock.on('error', reject);
  });
}

function postLines(extraLines, body) {
  return [
    'POST /get-plan HTTP/1.1',
    'Host: 127.0.0.1',
    'Connection: close',
    'Content-Type: application/json',
    `Content-Length: ${Buffer.byteLength(body)}`,
    ...extraLines,
  ];
}

test('duplicate If-None-Match headers are rejected with 400', async () => {
  const body = JSON.stringify({ size: 1000, etag: ETAG });
  const raw = await rawRequest(
    postLines([`If-None-Match: ${ETAG}`, `If-None-Match: ${ETAG}`], body),
    body,
  );
  assert.match(raw.split('\r\n')[0], /^HTTP\/1\.1 400/);
  const payload = raw.slice(raw.indexOf('\r\n\r\n') + 4);
  assert.equal(JSON.parse(payload).code, 'DUPLICATE_IF_NONE_MATCH_HEADER');
});

test('duplicate If-Modified-Since headers are rejected with 400', async () => {
  const body = JSON.stringify({ size: 1000, lastModified: LM });
  const raw = await rawRequest(
    postLines([`If-Modified-Since: ${LM}`, `If-Modified-Since: ${LM}`], body),
    body,
  );
  assert.match(raw.split('\r\n')[0], /^HTTP\/1\.1 400/);
  const payload = raw.slice(raw.indexOf('\r\n\r\n') + 4);
  assert.equal(JSON.parse(payload).code, 'DUPLICATE_IF_MODIFIED_SINCE_HEADER');
});

test('duplicate Range headers are rejected with 400 on /get-plan too', async () => {
  const body = JSON.stringify({ size: 1000 });
  const raw = await rawRequest(
    postLines(['Range: bytes=0-9', 'Range: bytes=10-19'], body),
    body,
  );
  assert.match(raw.split('\r\n')[0], /^HTTP\/1\.1 400/);
  assert.match(raw, /DUPLICATE_RANGE_HEADER/);
});

// ---------- 304 transport: the plan body must survive on a real socket ----------

test('a 304 plan is transported as HTTP 200 with the JSON plan intact', async () => {
  const body = JSON.stringify({ size: 1000, etag: ETAG });
  const raw = await rawRequest(
    postLines([`If-None-Match: ${ETAG}`], body),
    body,
  );
  // A bare 304 response could not carry the plan; the API answers 200 and
  // reports the planned status inside the body.
  assert.match(raw.split('\r\n')[0], /^HTTP\/1\.1 200/);
  const payload = raw.slice(raw.indexOf('\r\n\r\n') + 4);
  const plan = JSON.parse(payload);
  assert.equal(plan.statusCode, 304);
  assert.equal(plan.decision, 'not-modified');
  assert.deepEqual(plan.responseHeaders, { ETag: ETAG });
});
