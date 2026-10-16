// Minimal S3 client for Cloudflare R2, used by the backup tooling.
//
// The backup destination needs object listing, HEAD, GET, and PUT. R2 exposes
// those through its S3-compatible API, so this is a small dependency-free SigV4
// implementation rather than a new SDK dependency. The signature algorithm is
// verified against AWS's published SigV4 test vectors in test/backup.
//
// Deliberately absent: any delete operation. The backup tooling cannot remove a
// backup even if it is asked to.

import { createHash, createHmac } from 'node:crypto';

const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

function hmac(key, value) {
  return createHmac('sha256', key).update(value).digest();
}

function hex(buffer) {
  return Buffer.from(buffer).toString('hex');
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

// RFC 3986 encoding: unreserved characters stay, everything else is escaped.
export function uriEncode(value, encodeSlash = true) {
  return String(value).split('').map(character => {
    if (/[A-Za-z0-9._~-]/.test(character)) return character;
    if (character === '/' && !encodeSlash) return character;
    return Array.from(new TextEncoder().encode(character)).map(byte => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`).join('');
  }).join('');
}

export function canonicalQuery(query) {
  const entries = Object.entries(query ?? {}).filter(([, value]) => value !== undefined && value !== null);
  return entries
    .map(([key, value]) => [uriEncode(key), uriEncode(value)])
    .sort(([aKey, aValue], [bKey, bValue]) => (aKey === bKey ? (aValue < bValue ? -1 : aValue > bValue ? 1 : 0) : aKey < bKey ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

// Returns { canonicalRequest, stringToSign, authorization, amzDate }.
//
// Only the headers the caller provides (plus `x-amz-date`) are signed, so the
// signature can be checked against AWS's published SigV4 test vectors, which do
// not include `x-amz-content-sha256`. The client adds that header explicitly.
export function signRequest({ method, path, query, headers, payloadHash, accessKeyId, secretAccessKey, region = 'auto', service = 's3', date = new Date() }) {
  const amzDate = `${date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}`;
  const dateStamp = amzDate.slice(0, 8);
  const allHeaders = { ...headers, 'x-amz-date': amzDate };
  const lower = Object.fromEntries(Object.entries(allHeaders).map(([key, value]) => [key.toLowerCase(), String(value).trim()]));
  const signedHeaders = Object.keys(lower).sort();
  const canonicalHeaders = signedHeaders.map(name => `${name}:${lower[name]}\n`).join('');
  const canonicalRequest = [
    method.toUpperCase(),
    uriEncode(path, false),
    canonicalQuery(query),
    canonicalHeaders,
    signedHeaders.join(';'),
    payloadHash,
  ].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), service), 'aws4_request');
  const signature = hex(hmac(signingKey, stringToSign));
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}`;
  return { canonicalRequest, stringToSign, authorization, amzDate, signature, signedHeaders };
}

// A tiny S3 client scoped to one R2 bucket. Every method is read-only except
// putObject, and there is no delete method by design.
export function createR2Client({ accountId, bucket, accessKeyId, secretAccessKey, fetchImpl = fetch, region = 'auto', clock = () => new Date() }) {
  if (!accountId || !bucket) throw new Error('an R2 client needs an account id and a bucket');
  const host = `${accountId}.r2.cloudflarestorage.com`;

  async function request({ method, key = '', query, body, contentType }) {
    const payload = body === undefined ? '' : body;
    const payloadHash = sha256Hex(payload);
    const headers = { host, 'x-amz-content-sha256': payloadHash };
    if (contentType) headers['content-type'] = contentType;
    const signed = signRequest({
      method, path: `/${bucket}${key ? `/${key}` : ''}`, query, headers, payloadHash,
      accessKeyId, secretAccessKey, region, date: clock(),
    });
    const url = new URL(`https://${host}/${bucket}${key ? `/${uriEncode(key, false)}` : ''}`);
    for (const [name, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(name, value);
    }
    const response = await fetchImpl(url, {
      method,
      headers: {
        ...headers,
        'x-amz-date': signed.amzDate,
        Authorization: signed.authorization,
      },
      body: body === undefined ? undefined : payload,
    });
    return response;
  }

  return {
    bucket,
    // Read-only: list objects under a prefix, following continuation tokens.
    async listObjects({ prefix = '', maxKeys = 1000, maxPages = 50 } = {}) {
      const objects = [];
      let token;
      for (let page = 0; page < maxPages; page += 1) {
        const response = await request({ method: 'GET', query: { 'list-type': '2', prefix, 'max-keys': String(maxKeys), 'continuation-token': token } });
        if (response.status !== 200) throw new Error(`R2 listObjects failed: HTTP ${response.status} ${await response.text().catch(() => '')}`.trim());
        const xml = await response.text();
        for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const entry = match[1];
          objects.push({
            key: decodeXml(entry.match(/<Key>([\s\S]*?)<\/Key>/)?.[1] ?? ''),
            size: Number(entry.match(/<Size>(\d+)<\/Size>/)?.[1] ?? 0),
            etag: (entry.match(/<ETag>([\s\S]*?)<\/ETag>/)?.[1] ?? '').replace(/&quot;|"/g, ''),
            lastModified: entry.match(/<LastModified>([\s\S]*?)<\/LastModified>/)?.[1] ?? null,
          });
        }
        const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
        if (!truncated) break;
        token = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1];
        if (!token) throw new Error('R2 reported a truncated listing without a continuation token');
      }
      return objects;
    },
    async headObject(key) {
      const response = await request({ method: 'HEAD', key });
      if (response.status === 404) return null;
      if (response.status !== 200) throw new Error(`R2 headObject ${key} failed: HTTP ${response.status}`);
      return {
        key,
        size: Number(response.headers.get('content-length') ?? 0),
        etag: (response.headers.get('etag') ?? '').replace(/"/g, ''),
        lastModified: response.headers.get('last-modified'),
      };
    },
    async getObject(key) {
      const response = await request({ method: 'GET', key });
      if (response.status === 404) return null;
      if (response.status !== 200) throw new Error(`R2 getObject ${key} failed: HTTP ${response.status}`);
      return await response.text();
    },
    // Binary variant, used by the mirror so object bytes are hashed exactly.
    async getObjectBuffer(key) {
      const response = await request({ method: 'GET', key });
      if (response.status === 404) return null;
      if (response.status !== 200) throw new Error(`R2 getObject ${key} failed: HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    },
    // The only mutating operation, and it refuses to replace an existing object.
    async putObject(key, body, { contentType = 'application/octet-stream', ifNoneMatch = true } = {}) {
      const existing = await this.headObject(key);
      if (existing) throw new Error(`refusing to overwrite an existing backup object: ${bucket}/${key}`);
      const response = await request({ method: 'PUT', key, body, contentType });
      if (response.status !== 200) throw new Error(`R2 putObject ${key} failed: HTTP ${response.status} ${await response.text().catch(() => '')}`.trim());
      return { key, size: Buffer.byteLength(body), etag: (response.headers.get('etag') ?? '').replace(/"/g, '') };
    },
  };
}

function decodeXml(value) {
  return value
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}
