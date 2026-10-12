import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { STATUS_CODES } from 'node:http';
import { mkdir, writeFile, access, lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { buildSdlSchema, executeGraphql, parseAuthChallenges, readFileNoFollow, sigV4, stringifyRequest, writeFileAtomic, type Request } from '@apijanus/core';
import type { Handler } from './router';
import { features } from './features';
import { schemas } from './contract';
import type { AppSession } from './session';
import type { SecretStore } from './secrets';
import type { CollectionSnapshot } from '../shared/api';

const ENV_ID = 'environments/demo.env.yml';
const KEY = 'API_KEY';
const BASIC_PASSWORD = 'BASIC_PASSWORD';
const JWT_SECRET = 'JWT_SECRET';
const OAUTH_CLIENT_ID = 'OAUTH_CLIENT_ID';
const OAUTH_CLIENT_SECRET = 'OAUTH_CLIENT_SECRET';
const DEMO_SECRET = 'DEMO_SECRET';
const DIGEST_PASSWORD = 'DIGEST_PASSWORD';
const AWS_ACCESS_KEY_ID = 'AWS_ACCESS_KEY_ID';
const AWS_SECRET_ACCESS_KEY = 'AWS_SECRET_ACCESS_KEY';
/** The region and service /auth/aws expects (AWS_REGION in the Demo environment). */
const AWS_REGION = 'us-east-1';
const AWS_SERVICE = 'execute-api';
/** The demo's secrets and how each is generated the first time the demo opens (then kept in the secret store). */
const DEMO_SECRETS: [name: string, make: () => string][] = [
  [KEY, () => `demo-${randomBytes(12).toString('hex')}`],
  [BASIC_PASSWORD, () => `demo-pw-${randomBytes(12).toString('hex')}`],
  [JWT_SECRET, () => `demo-jwt-${randomBytes(24).toString('hex')}`],
  [OAUTH_CLIENT_ID, () => `demo-client-${randomBytes(8).toString('hex')}`],
  [OAUTH_CLIENT_SECRET, () => `demo-oauth-${randomBytes(16).toString('hex')}`],
  [DEMO_SECRET, () => `demo-vault-${randomBytes(12).toString('hex')}`],
  [DIGEST_PASSWORD, () => `demo-digest-${randomBytes(12).toString('hex')}`],
  [AWS_ACCESS_KEY_ID, () => `demo-akid-${randomBytes(10).toString('hex')}`],
  [AWS_SECRET_ACCESS_KEY, () => `demo-aws-${randomBytes(20).toString('hex')}`],
];

const DEMO_SDL = `type User { id: ID! name: String! email: String! }
type Article { id: ID! title: String! author: User }
type Query { user(id: ID!): User users: [User!]! article(id: ID!): Article }
type Mutation { createArticle(title: String!): Article }`;
const demoSchema = buildSdlSchema(DEMO_SDL);
const ada = (id: string) => ({ id, name: 'Ada Lovelace', email: 'ada@example.com' });
const demoRoot = {
  user: ({ id }: { id: string }) => ada(id),
  users: () => [ada('42'), { id: '7', name: 'Grace Hopper', email: 'grace@example.com' }],
  article: ({ id }: { id: string }) => ({ id, title: 'Hello', author: ada('42') }),
  createArticle: ({ title }: { title: string }) => ({ id: '1', title, author: ada('42') }),
};

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
let png: Buffer | undefined;
/** A deterministic 48x48 RGB PNG: two faces of a gradient, split down the middle. */
export function demoPng(): Buffer {
  if (png) return png;
  const size = 48;
  const rows: Buffer[] = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) {
      const left = x < size / 2;
      row[1 + x * 3] = left ? 40 + y * 4 : 230 - y * 3;
      row[2 + x * 3] = left ? 90 + x * 3 : 120;
      row[3 + x * 3] = left ? 200 : 60 + y * 3;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(Buffer.concat(rows))), pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return png;
}

/** The demo's apijanus.yml before it had collection variables, then before it had a collection test; an untouched one is upgraded when the demo opens. */
const LEGACY_DEMO_ROOTS = [
  'apijanus: 1\nname: JanusAPI Demo\n',
  'apijanus: 1\nname: JanusAPI Demo\nvariables:\n  - { name: apiVersion, value: "2026-10" }\n  - { name: appName, value: JanusAPI Demo }\n',
];

type Sample = Partial<Omit<Request, 'apijanus' | 'name' | 'method' | 'url' | 'tests'>> & Pick<Request, 'name' | 'method' | 'url'> & {
  /** What the request shows; written as the first line of its test script. */
  about: string;
  tests: string;
};

/** A sample request file: its description opens the test script as a comment. */
const sample = (r: Sample): string => {
  const { about, tests, ...rest } = r;
  return stringifyRequest({ apijanus: 1, ...rest, tests: `// ${about}\n${tests.trim()}\n` });
};
const status = (code: number) => `test("status is ${code}", () => expect(res.status).to.equal(${code}));`;

/** The demo's sample files to upload, written into files/ by writeDemo. */
export const DEMO_SAMPLE_TEXT = 'JanusAPI demo upload: a small text file.\nIt lives in files/sample.txt inside the demo collection.\n';
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const ITEM_URL = '{{baseUrl}}/items/{{itemId}}';

/** The upload samples, built from the sample files so their tests check the exact size and SHA-256 the mock reports. */
function uploadSamples(): Record<string, Sample> {
  const textSize = Buffer.byteLength(DEMO_SAMPLE_TEXT);
  const textHash = sha256(DEMO_SAMPLE_TEXT);
  const png = demoPng();
  const part = (name: string) => `res.body.parts.find((p) => p.name === "${name}")`;
  return {
    'bodies/upload-file.req.yml': {
      name: 'Upload a file (multipart)', method: 'POST', url: '{{baseUrl}}/upload', seq: 5,
      about: 'A multipart form with a text field and two files from files/ in this collection, streamed from disk. The mock reports each file\'s name, size and SHA-256, never its contents.',
      body: { type: 'multipart', fields: [
        { name: 'title', value: 'Quarterly report' },
        { name: 'document', value: '', kind: 'file', file: { path: 'files/sample.txt' } },
        { name: 'image', value: '', kind: 'file', file: { path: 'files/logo.png' } },
      ] },
      tests: `${status(200)}\ntest("the document arrived whole: ${textSize} bytes", () => expect(${part('document')}).to.include({ filename: "sample.txt", contentType: "text/plain", size: ${textSize} }));\ntest("the document's SHA-256 matches", () => expect(${part('document')}.sha256).to.equal("${textHash}"));\ntest("the image's size and SHA-256 match", () => expect(${part('image')}).to.include({ filename: "logo.png", contentType: "image/png", size: ${png.length}, sha256: "${sha256(png)}" }));`,
    },
    'bodies/binary-upload.req.yml': {
      name: 'Binary upload', method: 'PUT', url: '{{baseUrl}}/upload/binary', seq: 6,
      about: 'A binary body: files/logo.png is streamed from disk as the whole body, with Content-Type image/png from its extension.',
      body: { type: 'binary', file: { path: 'files/logo.png' } },
      tests: `${status(200)}\ntest("the whole file arrived: ${png.length} bytes", () => expect(res.body.size).to.equal(${png.length}));\ntest("sent as image/png", () => expect(res.body.contentType).to.equal("image/png"));\ntest("the SHA-256 matches", () => expect(res.body.sha256).to.equal("${sha256(png)}"));`,
    },
  };
}

/** Sample requests for every method, body, response type, auth, script and variable feature, by file. */
const SAMPLES: Record<string, Sample> = {
  // basics/: methods, params, path variables and headers.
  'basics/list-items.req.yml': {
    name: 'List items (query params)', method: 'GET', url: '{{baseUrl}}/items', seq: 0, about: 'GET with query params; the debug param is disabled, so it is not sent.',
    params: [{ name: 'limit', value: '5' }, { name: 'sort', value: 'name' }, { name: 'debug', value: 'true', enabled: false }],
    tests: `${status(200)}\ntest("returns five items", () => expect(res.body.items).to.have.length(5));\ntest("the disabled debug param was not sent", () => expect(res.body.debug).to.equal(false));`,
  },
  'basics/item-by-id.req.yml': {
    name: 'Item by id (path variable)', method: 'GET', url: ITEM_URL, seq: 1, about: 'GET with a path variable: {{itemId}} comes from the Demo environment.',
    tests: `${status(200)}\ntest("returns the item in the path", () => expect(res.body.id).to.equal(Number(env.get("itemId"))));`,
  },
  'basics/custom-headers.req.yml': {
    name: 'Custom request headers', method: 'GET', url: '{{baseUrl}}/echo', seq: 2, about: 'Custom headers; X-Debug is disabled, so it is not sent. /echo shows what arrived.',
    headers: [{ name: 'X-Demo-Client', value: 'JanusAPI' }, { name: 'Accept', value: 'application/json' }, { name: 'X-Debug', value: '1', enabled: false }],
    tests: `${status(200)}\ntest("X-Demo-Client arrived", () => expect(res.body.headers["x-demo-client"]).to.equal("JanusAPI"));\ntest("the disabled X-Debug header was not sent", () => expect(res.body.headers).to.not.have.property("x-debug"));`,
  },
  'basics/post-item.req.yml': {
    name: 'Post item (JSON body)', method: 'POST', url: '{{baseUrl}}/items', seq: 3, about: 'POST with a JSON body; the mock answers 201 with the new item.',
    body: { type: 'json', content: '{\n  "name": "Sprocket",\n  "price": 4.25,\n  "tags": ["new"]\n}\n' },
    tests: `${status(201)}\ntest("returns the new item", () => expect(res.body).to.include({ id: 11, name: "Sprocket" }));`,
  },
  'basics/replace-item.req.yml': {
    name: 'Replace item (PUT)', method: 'PUT', url: ITEM_URL, seq: 4, about: 'PUT with a JSON body: a full update replaces every field.',
    body: { type: 'json', content: '{\n  "name": "Cog",\n  "price": 9.99,\n  "tags": ["replaced"]\n}\n' },
    tests: `${status(200)}\ntest("the item was replaced", () => expect(res.body.tags).to.deep.equal(["replaced"]));`,
  },
  'basics/patch-item.req.yml': {
    name: 'Patch item (PATCH)', method: 'PATCH', url: ITEM_URL, seq: 5, about: 'PATCH with a JSON body: only price changes, the rest is kept.',
    body: { type: 'json', content: '{ "price": 12.5 }\n' },
    tests: `${status(200)}\ntest("only the price changed", () => expect(res.body).to.include({ name: "Cog", price: 12.5 }));`,
  },
  'basics/remove-item.req.yml': {
    name: 'Remove item', method: 'DELETE', url: ITEM_URL, seq: 6, about: 'DELETE: the mock answers 204 No Content (it keeps no state, so nothing is really removed).',
    tests: status(204),
  },
  'basics/item-count-head.req.yml': {
    name: 'Item count (HEAD)', method: 'HEAD', url: '{{baseUrl}}/items', seq: 7, about: 'HEAD: headers only, no body. X-Total-Count says how many items there are.',
    tests: `${status(200)}\ntest("X-Total-Count is 10", () => expect(res.headers["x-total-count"]).to.equal("10"));`,
  },
  'basics/allowed-methods.req.yml': {
    name: 'Allowed methods (OPTIONS)', method: 'OPTIONS', url: ITEM_URL, seq: 8, about: 'OPTIONS: the Allow header lists the methods an item supports.',
    tests: `${status(204)}\ntest("Allow lists PATCH", () => expect(res.headers.allow).to.contain("PATCH"));`,
  },

  // bodies/: every body type, echoed back by /echo.
  'bodies/raw-text.req.yml': {
    name: 'Raw text body', method: 'POST', url: '{{baseUrl}}/echo', seq: 0, about: 'A raw text body, sent as text/plain.',
    body: { type: 'text', content: 'Plain text from JanusAPI.\nLine two.\n' },
    tests: `${status(200)}\ntest("echoed as text", () => expect(res.body).to.include({ contentType: "text/plain", body: "Plain text from JanusAPI.\\nLine two.\\n" }));`,
  },
  'bodies/json-body.req.yml': {
    name: 'JSON body', method: 'POST', url: '{{baseUrl}}/echo', seq: 1, about: 'A JSON body, sent as application/json.',
    body: { type: 'json', content: '{\n  "name": "Sprocket",\n  "inStock": true,\n  "size": { "w": 2, "h": 3 }\n}\n' },
    tests: `${status(200)}\ntest("echoed as JSON", () => expect(res.body.body.size).to.deep.equal({ w: 2, h: 3 }));`,
  },
  'bodies/form-urlencoded.req.yml': {
    name: 'Form URL-encoded body', method: 'POST', url: '{{baseUrl}}/echo', seq: 2, about: 'An application/x-www-form-urlencoded body; the internal field is disabled, so it is not sent.',
    body: { type: 'form-urlencoded', fields: [{ name: 'name', value: 'Sprocket' }, { name: 'color', value: 'green' }, { name: 'internal', value: 'yes', enabled: false }] },
    tests: `${status(200)}\ntest("the fields arrived", () => expect(res.body.body).to.deep.equal({ name: "Sprocket", color: "green" }));\ntest("the disabled field was not sent", () => expect(res.body.body).to.not.have.property("internal"));`,
  },
  'bodies/multipart.req.yml': {
    name: 'Multipart form (text fields)', method: 'POST', url: '{{baseUrl}}/echo', seq: 3, about: 'A multipart/form-data body with text fields. A field can also be a file: see Upload a file (multipart).',
    body: { type: 'multipart', fields: [{ name: 'name', value: 'Sprocket' }, { name: 'note', value: 'Text fields only' }] },
    tests: `${status(200)}\ntest("the parts arrived", () => expect(res.body.body).to.deep.equal({ name: "Sprocket", note: "Text fields only" }));`,
  },
  'bodies/xml-body.req.yml': {
    name: 'XML body', method: 'POST', url: '{{baseUrl}}/echo', seq: 4, about: 'An XML body: a text body with Content-Type: application/xml.',
    headers: [{ name: 'Content-Type', value: 'application/xml' }],
    body: { type: 'text', content: '<?xml version="1.0" encoding="UTF-8"?>\n<item>\n  <name>Sprocket</name>\n</item>\n' },
    tests: `${status(200)}\ntest("echoed as XML", () => { expect(res.body.contentType).to.equal("application/xml"); expect(res.body.body).to.contain("<name>Sprocket</name>"); });`,
  },

  // responses/: every response type and the statuses worth seeing.
  'responses/json.req.yml': {
    name: 'JSON response', method: 'GET', url: '{{baseUrl}}/formats/json', seq: 0, about: 'A JSON response, shown pretty-printed.',
    tests: `${status(200)}\ntest("is JSON", () => { expect(res.headers["content-type"]).to.contain("application/json"); expect(res.body.format).to.equal("json"); });`,
  },
  'responses/xml.req.yml': {
    name: 'XML response', method: 'GET', url: '{{baseUrl}}/formats/xml', seq: 1, about: 'An XML response.',
    tests: `${status(200)}\ntest("is XML", () => { expect(res.headers["content-type"]).to.contain("application/xml"); expect(res.body).to.contain("<format>xml</format>"); });`,
  },
  'responses/html.req.yml': {
    name: 'HTML page', method: 'GET', url: '{{baseUrl}}/formats/html', seq: 2, about: 'An HTML response: Raw shows its source, and Preview renders it in a sandbox with no scripts and no network.',
    tests: `${status(200)}\ntest("is HTML", () => { expect(res.headers["content-type"]).to.contain("text/html"); expect(res.body).to.contain("<h1>"); });`,
  },
  'responses/plain-text.req.yml': {
    name: 'Plain text response', method: 'GET', url: '{{baseUrl}}/formats/text', seq: 3, about: 'A plain text response.',
    tests: `${status(200)}\ntest("is plain text", () => { expect(res.headers["content-type"]).to.contain("text/plain"); expect(res.body).to.contain("plain text"); });`,
  },
  'responses/png-image.req.yml': {
    name: 'PNG image', method: 'GET', url: '{{baseUrl}}/formats/png', seq: 4, about: 'A binary response: a small PNG image.',
    tests: `${status(200)}\ntest("is a PNG", () => expect(res.headers["content-type"]).to.equal("image/png"));`,
  },
  'responses/large-json.req.yml': {
    name: 'Large JSON (about 220 KB)', method: 'GET', url: '{{baseUrl}}/formats/large', seq: 5, about: 'A large JSON array (about 220 KB): the response shows its size and only the first part until you ask for the full body. Try the JSON filter, for example $.items[0:2].',
    tests: `${status(200)}\ntest("has 1000 records", () => expect(res.body.items).to.have.length(1000));`,
  },
  'responses/not-found.req.yml': {
    name: 'Not found (404)', method: 'GET', url: '{{baseUrl}}/status/404', seq: 6, about: 'A 404 error status. The tests expect it, so the runner counts this request as passed.',
    tests: `${status(404)}\ntest("says Not Found", () => expect(res.body.message).to.equal("Not Found"));`,
  },
  'responses/server-error.req.yml': {
    name: 'Server error (500)', method: 'GET', url: '{{baseUrl}}/status/500', seq: 7, about: 'A 500 error status. The tests expect it, so the runner counts this request as passed.',
    tests: `${status(500)}\ntest("says Internal Server Error", () => expect(res.body.message).to.equal("Internal Server Error"));`,
  },
  'responses/redirect.req.yml': {
    name: 'Redirect (302)', method: 'GET', url: '{{baseUrl}}/redirect', seq: 8, about: 'A 302 redirect to /formats/json, followed automatically.',
    tests: `${status(200)}\ntest("landed on the JSON endpoint", () => expect(res.body.format).to.equal("json"));`,
  },
  'responses/slow.req.yml': {
    name: 'Slow response (1.5 s)', method: 'GET', url: '{{baseUrl}}/delay', seq: 9, about: 'A slow response: the mock waits ms milliseconds (at most 2000). See the Timing tab.',
    params: [{ name: 'ms', value: '1500' }],
    tests: `${status(200)}\ntest("took at least 1.4 s", () => expect(res.time).to.be.at.least(1400));`,
  },
  'responses/custom-headers.req.yml': {
    name: 'Custom response headers', method: 'GET', url: '{{baseUrl}}/response-headers', seq: 10, about: 'A response with custom headers (rate limit, ETag, Cache-Control): see the Headers tab.',
    tests: `${status(200)}\ntest("rate limit headers", () => { expect(res.headers["x-ratelimit-limit"]).to.equal("100"); expect(res.headers["x-ratelimit-remaining"]).to.equal("99"); });\ntest("has an ETag", () => expect(res.headers.etag).to.equal('"demo-v1"'));`,
  },

  // auth/: the other auth types (Basic, Bearer and JWT are above), and folder-level auth.
  'auth/folder-bearer/inherited-bearer.req.yml': {
    name: 'Inherited bearer', method: 'GET', url: '{{baseUrl}}/auth/bearer', auth: { type: 'inherit' }, about: 'Auth set to inherit: the folder-bearer folder (folder.yml) sends the API key as a Bearer token.',
    tests: `${status(200)}\ntest("authenticated with the folder's bearer token", () => expect(res.body.scheme).to.equal("bearer"));`,
  },
  'auth/api-key-header.req.yml': {
    name: 'API key in header', method: 'GET', url: '{{baseUrl}}/auth/apikey', seq: 3, about: 'API key auth, sent in the X-Api-Key header.',
    auth: { type: 'apikey', key: 'X-Api-Key', value: '{{API_KEY}}', in: 'header' },
    tests: `${status(200)}\ntest("accepted from the header", () => expect(res.body.in).to.equal("header"));`,
  },
  'auth/api-key-query.req.yml': {
    name: 'API key in query', method: 'GET', url: '{{baseUrl}}/auth/apikey', seq: 4, about: 'API key auth, sent as the api_key query param.',
    auth: { type: 'apikey', key: 'api_key', value: '{{API_KEY}}', in: 'query' },
    tests: `${status(200)}\ntest("accepted from the query", () => expect(res.body.in).to.equal("query"));`,
  },
  'auth/oauth2-client-credentials.req.yml': {
    name: 'OAuth2 client credentials', method: 'GET', url: '{{baseUrl}}/auth/oauth2', seq: 5,
    about: 'OAuth2 client credentials: JanusAPI gets a token from the mock /oauth/token with the demo client id and secret, then sends it as a Bearer token.',
    auth: { type: 'oauth2', grant: 'client_credentials', tokenUrl: '{{baseUrl}}/oauth/token', clientId: '{{OAUTH_CLIENT_ID}}', clientSecret: '{{OAUTH_CLIENT_SECRET}}', scope: 'items:read' },
    tests: `${status(200)}\ntest("authenticated with an OAuth2 token", () => expect(res.body.scheme).to.equal("oauth2"));`,
  },
  'auth/no-auth.req.yml': {
    name: 'No auth', method: 'GET', url: '{{baseUrl}}/auth/public', seq: 6, about: 'No auth: nothing is added, not even what a folder or the collection sets.',
    auth: { type: 'none' },
    tests: `${status(200)}\ntest("a public endpoint", () => expect(res.body.authenticated).to.equal(false));`,
  },
  'auth/digest-auth.req.yml': {
    name: 'Digest auth', method: 'GET', url: '{{baseUrl}}/auth/digest', seq: 7,
    about: 'Digest auth: the request goes out, the mock answers 401 with a SHA-256 and an MD5 challenge, and JanusAPI answers the strongest once with {{DIGEST_PASSWORD}}. The next send reuses the nonce.',
    auth: { type: 'digest', username: 'demo', password: '{{DIGEST_PASSWORD}}' },
    tests: `${status(200)}\ntest("authenticated with Digest SHA-256", () => expect(res.body).to.include({ scheme: "digest", algorithm: "SHA-256" }));`,
  },
  'auth/aws-signature.req.yml': {
    name: 'AWS Signature v4', method: 'GET', url: '{{baseUrl}}/auth/aws', seq: 8,
    about: 'AWS Signature Version 4: every send is signed with {{AWS_ACCESS_KEY_ID}} and {{AWS_SECRET_ACCESS_KEY}} for {{AWS_REGION}}; the mock recomputes the signature.',
    params: [{ name: 'page', value: '1' }],
    auth: { type: 'awsv4', accessKeyId: '{{AWS_ACCESS_KEY_ID}}', secretAccessKey: '{{AWS_SECRET_ACCESS_KEY}}', region: '{{AWS_REGION}}', service: AWS_SERVICE },
    tests: `${status(200)}\ntest("the signature matched", () => expect(res.body).to.include({ scheme: "awsv4", region: "${AWS_REGION}" }));`,
  },

  // scripts/: pre-request scripts, tests (native and pm.*), chaining and a failure.
  'scripts/pre-request-script.req.yml': {
    name: 'Pre-request script', method: 'GET', url: '{{baseUrl}}/echo', seq: 0, about: 'The pre-request script adds an X-Request-Id header and saves it (and a timestamp) as runtime variables.',
    script: '// Runs before the request is sent.\nconst id = crypto.randomUUID();\nreq.setHeader("X-Request-Id", id);\nenv.set("requestId", id);\nenv.set("sentAt", new Date().toISOString());\n',
    tests: `${status(200)}\ntest("the script's header arrived", () => expect(res.body.headers["x-request-id"]).to.equal(env.get("requestId")));\ntest("the folder script's header arrived", () => expect(res.body.headers["x-demo-folder"]).to.equal("scripts"));`,
  },
  'scripts/tests-native.req.yml': {
    name: 'Tests (native API)', method: 'GET', url: ITEM_URL, seq: 1, about: 'Tests with the native test/expect API: status, a JSON field, a header and the response time.',
    tests: `${status(200)}\ntest("name is Cog", () => expect(res.body.name).to.equal("Cog"));\ntest("is JSON", () => expect(res.headers["content-type"]).to.contain("application/json"));\ntest("under 2 s", () => expect(res.time).to.be.below(2000));`,
  },
  'scripts/tests-pm.req.yml': {
    name: 'Tests (pm API)', method: 'GET', url: ITEM_URL, seq: 2, about: 'The same tests written in Postman (pm.*) style.',
    tests: 'pm.test("status is 200", () => pm.response.to.have.status(200));\npm.test("name is Cog", () => pm.expect(pm.response.json().name).to.eql("Cog"));\npm.test("is JSON", () => pm.expect(pm.response.headers.get("Content-Type")).to.include("application/json"));\npm.test("under 2 s", () => pm.expect(pm.response.responseTime).to.be.below(2000));',
  },
  'scripts/chain-get-token.req.yml': {
    name: 'Chain 1: Get token', method: 'POST', url: '{{baseUrl}}/chain/token', seq: 3, auth: { type: 'none' }, about: 'Chaining, step 1: the test script saves the token from the response with env.set("token", ...).',
    tests: `${status(200)}\nenv.set("token", res.body.token);\ntest("saved the token", () => expect(env.get("token")).to.equal(res.body.token));`,
  },
  'scripts/chain-use-token.req.yml': {
    name: 'Chain 2: Use token', method: 'GET', url: '{{baseUrl}}/chain/me', seq: 4, auth: { type: 'bearer', token: '{{token}}' },
    about: 'Chaining, step 2: sends Bearer {{token}}, the runtime variable step 1 saved. Send step 1 first.',
    tests: `${status(200)}\ntest("the saved token works", () => expect(res.body.authenticated).to.equal(true));`,
  },
  'scripts/failing-test.req.yml': {
    name: 'Failing test (on purpose)', method: 'GET', url: ITEM_URL, seq: 5, about: 'A deliberately failing test, to show how a failure looks. The runner counts this request as failed.',
    tests: `${status(200)}\ntest("fails on purpose: expects a name the API never returns", () => expect(res.body.name).to.equal("Gizmo"));`,
  },
  'scripts/variables-after-script.req.yml': {
    name: 'Variables after the script', method: 'GET', url: '{{baseUrl}}/echo', seq: 6,
    about: '{{stamp}} is set by this request\'s own pre-request script: {{variables}} are resolved after every pre-request script runs, so the same send uses it.',
    params: [{ name: 'stamp', value: '{{stamp}}' }],
    headers: [{ name: 'X-Stamp', value: '{{stamp}}' }],
    script: '// Sets {{stamp}}; the URL and the X-Stamp header use it in this same send.\nenv.set("stamp", "stamp-" + Date.now());\n',
    tests: `${status(200)}\ntest("the header used the value the script set", () => expect(res.body.headers["x-stamp"]).to.equal(env.get("stamp")));\ntest("the URL used it too", () => expect(res.body.query.stamp).to.equal(env.get("stamp")));\ntest("the folder script's header arrived", () => expect(res.body.headers["x-demo-folder"]).to.equal("scripts"));`,
  },

  // variables/: where {{values}} come from.
  'variables/environment-variable.req.yml': {
    name: 'Environment variable', method: 'GET', url: ITEM_URL, seq: 0, about: 'Uses {{itemId}} from the Demo environment, and saves the item name as the runtime variable savedItemName.',
    tests: `${status(200)}\nenv.set("savedItemName", res.body.name);\ntest("used itemId from the environment", () => expect(res.body.id).to.equal(Number(env.get("itemId"))));`,
  },
  'variables/collection-variable.req.yml': {
    name: 'Collection variable', method: 'GET', url: '{{baseUrl}}/echo', seq: 1, about: 'Uses {{apiVersion}} and {{appName}}, collection variables from apijanus.yml.',
    headers: [{ name: 'X-Api-Version', value: '{{apiVersion}}' }, { name: 'X-App-Name', value: '{{appName}}' }],
    tests: `${status(200)}\ntest("sent the collection variables", () => expect(res.body.headers).to.include({ "x-api-version": "2026-10", "x-app-name": "JanusAPI Demo" }));`,
  },
  'variables/secret-variable.req.yml': {
    name: 'Secret variable', method: 'GET', url: '{{baseUrl}}/vars/secret', seq: 2, about: 'Sends {{DEMO_SECRET}}, a secret environment variable: its value lives in the secret store and is masked everywhere.',
    headers: [{ name: 'X-Demo-Secret', value: '{{DEMO_SECRET}}' }],
    tests: `${status(200)}\ntest("the secret was accepted", () => expect(res.body.secretAccepted).to.equal(true));`,
  },
  // data-driven/: one request run once per row of data/users.csv (choose it as the Runner's data file).
  'data-driven/create-user.req.yml': {
    name: 'Create user (data-driven)', method: 'POST', url: '{{baseUrl}}/echo', seq: 0,
    about: 'A data-driven request: in the Runner, choose data/users.csv (in this collection) as the data file and run this folder. Each row is one iteration, so {{name}} and {{email}} come from that row, and the test checks the echo against iteration.data. Sent on its own, without a data file, the placeholders are sent as they are and only the status is checked.',
    body: { type: 'json', content: '{\n  "name": "{{name}}",\n  "email": "{{email}}"\n}\n' },
    tests: `${status(200)}\n(pm.iterationData.has("name") ? test : pm.test.skip)("the echo matches the data row", () => {\n  expect(res.body.body.name).to.equal(iteration.data.name);\n  expect(res.body.body.email).to.equal(iteration.data.email);\n});`,
  },
  'variables/runtime-variable.req.yml': {
    name: 'Runtime variable', method: 'GET', url: '{{baseUrl}}/echo', seq: 3, about: 'Uses {{savedItemName}}, a runtime variable the Environment variable request saved. Send that one first.',
    params: [{ name: 'name', value: '{{savedItemName}}' }],
    tests: `${status(200)}\ntest("sent the saved runtime variable", () => expect(res.body.query.name).to.equal(env.get("savedItemName")));`,
  },
};

export const DEMO_FILES: Record<string, string> = {
  'apijanus.yml': 'apijanus: 1\nname: JanusAPI Demo\nvariables:\n  - { name: apiVersion, value: "2026-10" }\n  - { name: appName, value: JanusAPI Demo }\n'
    + 'tests: |\n  // The collection\'s test script: runs after every request, before its folder\'s and its own tests.\n'
    + '  test("[demo] response time under 30s", () => expect(res.time).to.be.below(30000));\n',
  'scripts/folder.yml': 'apijanus: 1\nscript: |\n  // The scripts folder\'s pre-request script: runs for every request in scripts/, after the collection\'s and before the request\'s own.\n'
    + '  req.setHeader("X-Demo-Folder", "scripts");\n',
  'auth/folder-bearer/folder.yml': 'apijanus: 1\nauth: { type: bearer, token: "{{API_KEY}}" }\n',
  'users/get-user.req.yml': 'apijanus: 1\nname: Get user\nmethod: GET\nurl: "{{baseUrl}}/users/42"\nheaders:\n  - { name: X-Api-Key, value: "{{API_KEY}}" }\n',
  'articles/create-article.req.yml': 'apijanus: 1\nname: Create article\nmethod: POST\nurl: "{{baseUrl}}/articles"\nauth: { type: bearer, token: "{{API_KEY}}" }\nbody:\n  type: json\n  content: |\n    { "title": "Hello" }\ntests: |\n  test("created", () => expect(res.status).to.equal(201));\n',
  'auth/basic-auth.req.yml': 'apijanus: 1\nname: Basic auth\nmethod: GET\nurl: "{{baseUrl}}/auth/basic"\nauth: { type: basic, username: demo, password: "{{BASIC_PASSWORD}}" }\nseq: 0\n',
  'auth/bearer-token.req.yml': 'apijanus: 1\nname: Bearer token\nmethod: GET\nurl: "{{baseUrl}}/auth/bearer"\nauth: { type: bearer, token: "{{API_KEY}}" }\nseq: 1\n',
  'auth/jwt-bearer.req.yml': 'apijanus: 1\nname: JWT bearer\nmethod: GET\nurl: "{{baseUrl}}/auth/jwt"\nauth:\n  type: jwt\n  algorithm: HS256\n  secret: "{{JWT_SECRET}}"\n  payload: \'{"sub":"demo-user","role":"tester"}\'\n  addIssuedAt: true\n  expiresInSeconds: 300\n  in: header\nseq: 2\n',
  'session/login.req.yml': 'apijanus: 1\nname: Login (cookie)\nmethod: POST\nurl: "{{baseUrl}}/session/login"\nauth: { type: none }\nseq: 0\n',
  'session/who-am-i.req.yml': 'apijanus: 1\nname: Who am I (cookie)\nmethod: GET\nurl: "{{baseUrl}}/session/me"\nauth: { type: none }\nseq: 1\n',
  'graphql/get-user.req.yml': 'apijanus: 1\nname: Get user (GraphQL)\nmethod: POST\nurl: "{{baseUrl}}/graphql"\nauth: { type: bearer, token: "{{API_KEY}}" }\nbody:\n  type: graphql\n  query: |\n    query GetUser($id: ID!) { user(id: $id) { id name } }\n  variables: \'{"id":"42"}\'\n',
  'graphql/create-article.req.yml': 'apijanus: 1\nname: Create article (GraphQL)\nmethod: POST\nurl: "{{baseUrl}}/graphql"\nauth: { type: bearer, token: "{{API_KEY}}" }\nbody:\n  type: graphql\n  query: |\n    mutation CreateArticle($title: String!) { createArticle(title: $title) { id title } }\n  variables: \'{"title":"Hello"}\'\n',
  ...Object.fromEntries(Object.entries({ ...SAMPLES, ...uploadSamples() }).map(([file, r]) => [file, sample(r)])),
};

/** Files the upload samples send, written next to the requests (never overwriting one the user changed). */
export const DEMO_UPLOAD_FILES = (): Record<string, string | Buffer> => ({ 'files/sample.txt': DEMO_SAMPLE_TEXT, 'files/logo.png': demoPng() });

/** The data file for Create user (data-driven): one Runner iteration per row. */
export const DEMO_USERS_CSV = 'name,email,role\nAlice Example,alice@example.com,admin\nBob Example,bob@example.com,editor\nCarol Example,carol@example.com,viewer\n';
export const DEMO_DATA_FILES = (): Record<string, string> => ({ 'data/users.csv': DEMO_USERS_CSV });

const envFile = (baseUrl: string) => `apijanus: 1\nname: Demo\nvariables:\n  - { name: baseUrl, value: "${baseUrl}" }\n  - { name: itemId, value: "3" }\n  - { name: AWS_REGION, value: ${AWS_REGION} }\n${DEMO_SECRETS.map(([n]) => `  - { name: ${n}, secret: true }\n`).join('')}`;

async function refuseLinks(dir: string, parents: string[]): Promise<void> {
  for (const p of parents) {
    const st = await lstat(join(dir, p)).catch(() => undefined);
    if (st?.isSymbolicLink()) throw new Error('The demo folder contains a link; remove it and try again');
  }
}

export async function writeDemo(dir: string, baseUrl: string, opts: { graphql?: boolean } = {}): Promise<void> {
  const withGraphql = opts.graphql ?? features.graphql;
  const files: [string, string | Buffer][] = [...Object.entries(DEMO_FILES).filter(([rel]) => withGraphql || !rel.startsWith('graphql/')), ...Object.entries(DEMO_UPLOAD_FILES()), ...Object.entries(DEMO_DATA_FILES())];
  await refuseLinks(dir, [...new Set([...files.map(([r]) => r).map((r) => dirname(r)).filter((d) => d !== '.'), 'environments'])]);
  for (const [rel, content] of files) {
    const file = join(dir, rel);
    // An untouched apijanus.yml from an older demo gains the collection variables and test; an edited one is left alone.
    if (rel === 'apijanus.yml' && LEGACY_DEMO_ROOTS.includes((await readFileNoFollow(file)) ?? '')) { await writeFileAtomic(file, content as string); continue; }
    try { await access(file); continue; } catch { /* missing: create it */ }
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content, { flag: 'wx' }).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST') throw e; });
  }
  await mkdir(join(dir, 'environments'), { recursive: true });
  await writeFileAtomic(join(dir, ENV_ID), envFile(baseUrl));
}

/** An OpenAPI 3.0 description of the mock's own routes, served at /openapi.yaml so the import can be tried on it. */
export function mockSpec(url: string): string {
  return `openapi: 3.0.3
info: { title: JanusAPI Demo API, version: 1.0.0 }
servers:
  - url: ${JSON.stringify(url)}
security: [ { bearerAuth: [] } ]
tags: [ { name: users }, { name: articles } ]
paths:
  /users/{id}:
    get:
      tags: [users]
      operationId: getUser
      summary: Get user
      parameters:
        - { name: id, in: path, required: true, schema: { type: integer }, example: 42 }
      responses:
        "200": { description: The user }
        "401": { description: Missing or wrong API key }
  /articles:
    post:
      tags: [articles]
      operationId: createArticle
      summary: Create article
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [title]
              properties: { title: { type: string } }
            example: { title: Hello }
      responses:
        "201": { description: The created article }
        "401": { description: Missing or wrong API key }
components:
  securitySchemes:
    bearerAuth: { type: http, scheme: bearer }
`;
}

export interface MockApi { url: string; close(): Promise<void> }

export interface MockCall { method: string; path: string; body: unknown; authorised: boolean; graphql?: { query: string; variables?: unknown; data?: unknown; errors?: unknown } }

/** Equal strings, compared in constant time (as bytes); false for an empty expected value. */
function same(given: string, expected: string | undefined): boolean {
  if (!expected) return false;
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Checks an HS256 JWT signed with secret: its header says HS256, the signature matches, the payload is a JSON object and
 * its exp, when present, has not passed. Returns the claims or why it was refused (never quoting the token or secret).
 */
export function verifyDemoJwt(token: string, secret: string | undefined): { claims: Record<string, unknown> } | { refused: string } {
  if (!secret) return { refused: 'The demo JWT secret is not set' };
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return { refused: 'Send a JWT (header.payload.signature)' };
  const [h, p, sig] = parts as [string, string, string];
  let header: unknown;
  let claims: unknown;
  try {
    header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  } catch {
    return { refused: 'The JWT header and payload must be base64url JSON' };
  }
  if (!header || typeof header !== 'object' || (header as { alg?: unknown }).alg !== 'HS256') return { refused: 'Sign the JWT with HS256' };
  if (!same(sig, createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url'))) return { refused: 'The JWT signature does not match: sign it with {{JWT_SECRET}}' };
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return { refused: 'The JWT payload must be a JSON object' };
  const exp = (claims as { exp?: unknown }).exp;
  if (exp !== undefined && (typeof exp !== 'number' || exp * 1000 <= Date.now())) return { refused: 'The JWT has expired: send a fresh one' };
  return { claims: claims as Record<string, unknown> };
}

/** The longest delay /delay waits, whatever ms asks for. */
export const DEMO_MAX_DELAY_MS = 2000;

const ITEM_NAMES = ['Anvil', 'Bolt', 'Cog', 'Dynamo', 'Escapement', 'Flywheel', 'Gear', 'Hinge', 'Insulator', 'Joist'];
const ITEMS = ITEM_NAMES.map((name, i) => ({ id: i + 1, name, price: Math.round((i + 1) * 3.5 * 100) / 100, tags: ['demo'] }));
const ALLOW_ITEMS = 'GET, HEAD, POST, OPTIONS';
const ALLOW_ITEM = 'GET, HEAD, PUT, PATCH, DELETE, OPTIONS';

let large: string | undefined;
/** About 220 KB of deterministic JSON: 1000 records. */
export function demoLargeJson(): string {
  large ??= JSON.stringify({
    total: 1000,
    items: Array.from({ length: 1000 }, (_, i) => ({
      id: i + 1, sku: `SKU-${String(i + 1).padStart(5, '0')}`, label: `Record ${i + 1}`, price: Math.round(((i * 37) % 1000) + 99) / 100,
      inStock: i % 3 !== 0, tags: ['demo', 'bulk', i % 2 ? 'odd' : 'even'],
      note: 'A deterministic filler record that shows how JanusAPI handles a large response: its size, then the first part.',
    })),
  });
  return large;
}

const XML_DOC = '<?xml version="1.0" encoding="UTF-8"?>\n<response>\n  <format>xml</format>\n  <item id="3">\n    <name>Cog</name>\n    <price>10.5</price>\n  </item>\n</response>\n';
const HTML_DOC = '<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>JanusAPI demo</title></head>\n<body>\n  <h1>JanusAPI demo</h1>\n  <p>An HTML response from the mock API.</p>\n</body>\n</html>\n';
const TEXT_DOC = 'This is a plain text response from the JanusAPI demo mock.\nIt has two lines.\n';

/** Text fields of a multipart/form-data body; a file part shows only its name and size. */
function parseMultipart(raw: string, type: string): Record<string, unknown> | undefined {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(type);
  const boundary = m?.[1] ?? m?.[2]?.trim();
  if (!boundary) return undefined;
  const out: Record<string, unknown> = {};
  for (const part of raw.split(`--${boundary}`).slice(1)) {
    if (part.startsWith('--')) break;
    const split = part.indexOf('\r\n\r\n');
    if (split < 0) continue;
    const head = part.slice(0, split);
    const value = part.slice(split + 4).replace(/\r\n$/, '');
    const name = /name="([^"]*)"/i.exec(head)?.[1];
    if (name === undefined) continue;
    const file = /filename="([^"]*)"/i.exec(head)?.[1];
    out[name] = file === undefined ? value : { filename: file, size: Buffer.byteLength(value) };
  }
  return out;
}

/** The largest multipart body /upload reads (it keeps the body to split its parts); /upload/binary streams any size. */
const UPLOAD_LIMIT = 10 * 1024 * 1024;

/**
 * The parts of a multipart/form-data body (RFC 7578): text parts with their value, file parts with their file name (filename*
 * preferred), content type, size and SHA-256, never their bytes.
 */
export function uploadParts(body: Buffer, type: string): Record<string, unknown>[] | undefined {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(type);
  const boundary = m?.[1] ?? m?.[2]?.trim();
  if (!boundary) return undefined;
  const delim = Buffer.from(`--${boundary}`);
  const next = Buffer.from(`\r\n--${boundary}`);
  const out: Record<string, unknown>[] = [];
  let pos = body.indexOf(delim);
  if (pos < 0) return undefined;
  pos += delim.length;
  while (body.subarray(pos, pos + 2).toString() === '\r\n') {
    const headEnd = body.indexOf('\r\n\r\n', pos);
    if (headEnd < 0) return undefined;
    const end = body.indexOf(next, headEnd + 4);
    if (end < 0) return undefined;
    const head = body.subarray(pos + 2, headEnd).toString('utf8');
    const data = body.subarray(headEnd + 4, end);
    const name = /name="([^"]*)"/i.exec(head)?.[1] ?? '';
    const star = /filename\*=UTF-8''([^;\r\n]+)/i.exec(head)?.[1];
    let filename = /filename="([^"]*)"/i.exec(head)?.[1];
    if (star) { try { filename = decodeURIComponent(star); } catch { /* keep the plain filename */ } }
    if (filename === undefined) out.push({ name, value: data.toString('utf8') });
    else {
      const contentType = /^content-type:\s*(.+)$/im.exec(head)?.[1]?.trim() ?? null;
      out.push({ name, filename, contentType, size: data.length, sha256: createHash('sha256').update(data).digest('hex') });
    }
    pos = end + next.length;
  }
  return out;
}

/** Request headers /echo never shows: credentials, and the demo's secret header. */
const HIDDEN_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'x-api-key', 'x-demo-secret', 'host', 'connection', 'content-length']);

/** Keeps a bounded set of the most recent tokens handed out. */
function tokenSet(max = 500) {
  const set = new Set<string>();
  return {
    issue(prefix: string): string {
      const t = `${prefix}${randomBytes(16).toString('hex')}`;
      set.add(t);
      if (set.size > max) set.delete(set.values().next().value!);
      return t;
    },
    has: (t: string) => set.has(t),
  };
}

/**
 * `opts.onRequest` is an opt-in recorder (used by the live evaluation); it sees every request that reached a route.
 * `basicPassword` and `jwtSecret` give the demo's Basic password and JWT signing secret for /auth/basic and /auth/jwt;
 * without them those routes refuse everything. The sample routes (/echo, /items, /formats/*, /status/:code, /redirect,
 * /delay, /response-headers, /auth/apikey, /auth/oauth2, /auth/public, /oauth/token, /chain/*, /vars/secret) are
 * deterministic, capped (request bodies at 64 KB, delays at DEMO_MAX_DELAY_MS) and never echo a demo secret.
 */
export interface MockOptions {
  onRequest?: (call: MockCall) => void;
  basicPassword?: () => string | undefined;
  jwtSecret?: () => string | undefined;
  /** The OAuth2 client /oauth/token accepts; without both it refuses every client. */
  oauthClientId?: () => string | undefined;
  oauthClientSecret?: () => string | undefined;
  /** The value /vars/secret expects in X-Demo-Secret. */
  demoSecret?: () => string | undefined;
  /** The password of the user demo at /auth/digest. */
  digestPassword?: () => string | undefined;
  /** The keys /auth/aws checks SigV4 signatures with. */
  awsAccessKeyId?: () => string | undefined;
  awsSecretAccessKey?: () => string | undefined;
  /** The mock's clock (Digest nonce expiry, AWS clock skew); Date.now by default. */
  now?: () => number;
}

const DIGEST_REALM = 'JanusAPI demo';
/** How long a Digest nonce is good for; an older one is answered with stale=true. */
const DIGEST_NONCE_MS = 5 * 60_000;
/** The largest clock difference /auth/aws accepts (as AWS does). */
const AWS_MAX_SKEW_MS = 15 * 60_000;
const digestHash = (alg: string, s: string) => createHash(alg === 'SHA-256' ? 'sha256' : 'md5').update(s).digest('hex');

/** The time of an x-amz-date (20150830T123600Z), or NaN. */
function amzTime(v: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(v);
  return m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) : NaN;
}

export async function startMockApi(apiKey: () => string | undefined, opts: MockOptions = {}): Promise<MockApi> {
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const authorised = (req: IncomingMessage) => {
    const key = apiKey();
    return same(req.headers.authorization ?? '', key ? `Bearer ${key}` : undefined);
  };
  let port = 0;
  const oauthTokens = tokenSet();
  const chainTokens = tokenSet();
  const bearerOf = (req: IncomingMessage) => /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? '';
  /** Every demo secret that is set, so /echo can blank any that a request carried in a value it echoes. */
  const knownSecrets = () => [apiKey(), opts.basicPassword?.(), opts.jwtSecret?.(), opts.oauthClientId?.(), opts.oauthClientSecret?.(), opts.demoSecret?.(),
    opts.digestPassword?.(), opts.awsAccessKeyId?.(), opts.awsSecretAccessKey?.()]
    .filter((v): v is string => typeof v === 'string' && v.length >= 4);
  const scrub = (v: unknown, secrets: string[]): unknown => {
    if (typeof v === 'string') return secrets.reduce((t, x) => t.split(x).join('[redacted]'), v);
    if (Array.isArray(v)) return v.map((x) => scrub(x, secrets));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [scrub(k, secrets) as string, scrub(x, secrets)]));
    return v;
  };
  // Session ids handed out by /session/login (kept for the mock's lifetime).
  const sessions = new Set<string>();
  const now = opts.now ?? Date.now;
  // Digest: nonces this mock issued, with their expiry and the highest nonce count used (a replay is refused). At most 500.
  const nonces = new Map<string, { expires: number; nc: number }>();
  const opaque = randomBytes(12).toString('hex');
  /** A 401 offering Digest with SHA-256 and MD5 under a fresh nonce; stale says the answer was right but its nonce had expired. */
  const digestChallenge = (res: ServerResponse, hint: string, stale = false) => {
    const nonce = randomBytes(16).toString('hex');
    nonces.set(nonce, { expires: now() + DIGEST_NONCE_MS, nc: 0 });
    while (nonces.size > 500) nonces.delete(nonces.keys().next().value!);
    const offer = (alg: string) => `Digest realm="${DIGEST_REALM}", qop="auth", algorithm=${alg}, nonce="${nonce}", opaque="${opaque}"${stale ? ', stale=true' : ''}`;
    res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': [offer('SHA-256'), offer('MD5')] });
    res.end(JSON.stringify({ error: 'unauthorized', hint }));
  };
  /** GET /auth/digest: checks a Digest answer (RFC 7616) for the user demo, its nonce, nonce count and request URI. */
  const digestAuth = (req: IncomingMessage, res: ServerResponse) => {
    const hint = 'Use Digest auth with the user demo and the password {{DIGEST_PASSWORD}}.';
    const password = opts.digestPassword?.();
    const c = parseAuthChallenges(req.headers.authorization ?? '')[0];
    if (!password || !c || c.scheme !== 'digest') return digestChallenge(res, hint);
    const p = c.params;
    const alg = p.algorithm ?? 'MD5';
    const entry = p.nonce === undefined ? undefined : nonces.get(p.nonce);
    if (!entry || (alg !== 'SHA-256' && alg !== 'MD5') || p.username !== 'demo' || p.realm !== DIGEST_REALM || p.uri !== req.url
      || p.qop !== 'auth' || p.opaque !== opaque || !/^[0-9a-f]{8}$/i.test(p.nc ?? '') || !p.cnonce) return digestChallenge(res, hint);
    const expected = digestHash(alg, `${digestHash(alg, `demo:${DIGEST_REALM}:${password}`)}:${p.nonce}:${p.nc}:${p.cnonce}:auth:${digestHash(alg, `${req.method}:${p.uri}`)}`);
    if (!same(p.response ?? '', expected)) return digestChallenge(res, hint);
    if (entry.expires <= now()) {
      nonces.delete(p.nonce!);
      return digestChallenge(res, 'The Digest nonce expired: answer the new challenge.', true);
    }
    const nc = parseInt(p.nc!, 16);
    if (nc <= entry.nc) return digestChallenge(res, 'That nonce count was used already: send the next one.');
    entry.nc = nc;
    return json(res, 200, { authenticated: true, scheme: 'digest', user: 'demo', algorithm: alg });
  };
  /** GET /auth/aws: recomputes the request's AWS Signature Version 4 with the demo keys and compares in constant time. */
  const awsAuth = (req: IncomingMessage, res: ServerResponse, body: string) => {
    const refuse = (hint: string) => json(res, 401, { error: 'unauthorized', hint });
    const hint = `Sign with AWS Signature v4: {{AWS_ACCESS_KEY_ID}}, {{AWS_SECRET_ACCESS_KEY}}, region ${AWS_REGION}, service ${AWS_SERVICE}.`;
    const ak = opts.awsAccessKeyId?.();
    const sk = opts.awsSecretAccessKey?.();
    const m = /^AWS4-HMAC-SHA256 Credential=([^/\s,]+)\/(\d{8})\/([^/\s,]+)\/([^/\s,]+)\/aws4_request,\s*SignedHeaders=([a-z0-9;-]+),\s*Signature=([0-9a-f]{64})$/
      .exec(req.headers.authorization ?? '');
    if (!ak || !sk || !m) return refuse(hint);
    const [, key, day, region, service, signedHeaders, signature] = m as unknown as string[];
    if (!same(key!, ak) || region !== AWS_REGION || service !== AWS_SERVICE) return refuse(hint);
    const given = req.headers['x-amz-date'];
    const date = typeof given === 'string' ? given : '';
    const at = amzTime(date);
    if (Number.isNaN(at) || date.slice(0, 8) !== day) return refuse(hint);
    if (Math.abs(now() - at) > AWS_MAX_SKEW_MS) return refuse('The X-Amz-Date is more than 15 minutes from the mock\'s clock: check your clock and send again.');
    const names = signedHeaders!.split(';');
    if (!names.includes('host') || !names.includes('x-amz-date')) return refuse(hint);
    const headers: [string, string][] = [];
    for (const n of names) {
      const v = req.headers[n];
      if (v === undefined) return refuse(hint);
      headers.push([n, Array.isArray(v) ? v.join(',') : v]);
    }
    const target = req.url ?? '/';
    const q = target.indexOf('?');
    const own = req.headers['x-amz-content-sha256'];
    const payloadHash = typeof own === 'string' ? own : createHash('sha256').update(body).digest('hex');
    const expected = sigV4({ method: req.method ?? 'GET', path: q < 0 ? target : target.slice(0, q), query: q < 0 ? '' : target.slice(q + 1), headers, payloadHash },
      { accessKeyId: ak, secretAccessKey: sk, region: AWS_REGION, service: AWS_SERVICE }, date);
    if (!same(signature!, expected.signature)) return refuse(hint);
    return json(res, 200, { authenticated: true, scheme: 'awsv4', region, service });
  };
  const sessionOf = (req: IncomingMessage) => {
    for (const part of (req.headers.cookie ?? '').split(';')) {
      const m = /^\s*session=([0-9a-f]{32})\s*$/.exec(part);
      if (m && sessions.has(m[1]!)) return m[1];
    }
    return undefined;
  };
  /** POST /upload (multipart) and PUT /upload/binary: report what arrived (names, sizes, SHA-256), never the file bytes. */
  const upload = (req: IncomingMessage, res: ServerResponse, path: string) => {
    const binary = path === '/upload/binary';
    if (binary ? req.method !== 'PUT' && req.method !== 'POST' : req.method !== 'POST') {
      req.resume();
      return json(res, 405, { error: 'method_not_allowed' });
    }
    const type = (req.headers['content-type'] ?? '').trim();
    const hash = createHash('sha256');
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (binary) { hash.update(c); return; }
      if (size > UPLOAD_LIMIT) {
        if (!tooBig) { tooBig = true; res.writeHead(413, { 'content-type': 'application/json', connection: 'close' }); res.end(JSON.stringify({ error: 'body too large' }), () => req.destroy()); }
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return;
      if (binary) {
        const out = { size, contentType: type.split(';')[0]!.trim() || null, sha256: hash.digest('hex') };
        opts.onRequest?.({ method: req.method ?? '', path, body: out, authorised: authorised(req) });
        return json(res, 200, out);
      }
      const parts = /^multipart\/form-data/i.test(type) ? uploadParts(Buffer.concat(chunks), type) : undefined;
      if (!parts) return json(res, 400, { error: 'Send a multipart/form-data body' });
      const shown = scrub({ parts }, knownSecrets()) as { parts: unknown[] };
      opts.onRequest?.({ method: req.method ?? '', path, body: shown, authorised: authorised(req) });
      return json(res, 200, shown);
    });
  };
  const server = createServer((req, res) => {
    let raw = '';
    const host = req.headers.host;
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      res.writeHead(400, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify({ error: 'bad host' }), () => req.destroy());
      return;
    }
    const early = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (early === '/upload' || early === '/upload/binary') return upload(req, res, early);
    let size = 0;
    let tooBig = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 65_536) {
        if (!tooBig) { tooBig = true; res.writeHead(413, { 'content-type': 'application/json', connection: 'close' }); res.end(JSON.stringify({ error: 'body too large' }), () => req.destroy()); }
        return;
      }
      raw += c.toString('utf8');
    });
    req.on('end', () => {
      if (tooBig) return;
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      const user = /^\/users\/(\d+)$/.exec(path);
      if (req.method === 'GET' && path === '/openapi.yaml') {
        res.writeHead(200, { 'content-type': 'application/yaml; charset=utf-8' });
        res.end(mockSpec(`http://127.0.0.1:${port}`));
        return;
      }
      if (path === '/graphql' && (req.method === 'GET' || req.method === 'POST')) {
        let input: { query?: unknown; variables?: unknown; operationName?: unknown } | undefined;
        try {
          if (req.method === 'GET') {
            const sp = new URL(req.url ?? '/', 'http://localhost').searchParams;
            const vars = sp.get('variables');
            input = { query: sp.get('query') ?? undefined, variables: vars ? JSON.parse(vars) : undefined, operationName: sp.get('operationName') ?? undefined };
          } else {
            const b: unknown = JSON.parse(raw || '{}');
            input = b && typeof b === 'object' && !Array.isArray(b) ? b as typeof input : undefined;
          }
        } catch {
          input = undefined;
        }
        const ok = authorised(req);
        const query = typeof input?.query === 'string' ? input.query : undefined;
        if (!ok || query === undefined) {
          opts.onRequest?.({ method: req.method ?? '', path, body: input, authorised: ok });
          return ok ? json(res, 400, { errors: [{ message: 'Send a JSON body with a query' }] }) : json(res, 401, { error: 'unauthorized', hint: 'Send the API key as a Bearer token in the Authorization header.' });
        }
        const variables = input?.variables && typeof input.variables === 'object' && !Array.isArray(input.variables) ? input.variables as Record<string, unknown> : undefined;
        void executeGraphql({ schema: demoSchema, source: query, rootValue: demoRoot, variableValues: variables, operationName: typeof input?.operationName === 'string' ? input.operationName : undefined })
          .then((result) => {
            const plain = JSON.parse(JSON.stringify(result)) as { data?: unknown; errors?: unknown };
            opts.onRequest?.({ method: req.method ?? '', path, body: input, authorised: true, graphql: { query, ...(variables ? { variables } : {}), ...plain } });
            json(res, 200, plain);
          }, (e: unknown) => json(res, 500, { errors: [{ message: e instanceof Error ? e.message : String(e) }] }));
        return;
      }
      if (opts.onRequest) {
        let parsed: unknown = raw || undefined;
        try { if (raw) parsed = JSON.parse(raw); } catch { /* keep the raw text */ }
        opts.onRequest({ method: req.method ?? '', path, body: parsed, authorised: authorised(req) });
      }
      const unauthorised = { error: 'unauthorized', hint: 'Send the API key as a Bearer token in the Authorization header.' };
      // A cookie session: login sets an HttpOnly session cookie, which the cookie jar then sends to /session/me.
      if (req.method === 'POST' && path === '/session/login') {
        const id = randomBytes(16).toString('hex');
        sessions.add(id);
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': `session=${id}; Path=/; HttpOnly; SameSite=Lax` });
        res.end(JSON.stringify({ loggedIn: true, user: 'demo' }));
        return;
      }
      if (req.method === 'GET' && path === '/session/me') {
        return sessionOf(req)
          ? json(res, 200, { authenticated: true, scheme: 'cookie', user: 'demo' })
          : json(res, 401, { error: 'unauthorized', hint: 'Send Login (cookie) first: its session cookie is stored and sent automatically.' });
      }
      if (req.method === 'GET' && path.startsWith('/auth/')) {
        const given = req.headers.authorization ?? '';
        const refuse = (hint: string) => json(res, 401, { error: 'unauthorized', hint });
        if (path === '/auth/basic') {
          const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(given);
          const pair = m ? Buffer.from(m[1]!, 'base64').toString('utf8') : '';
          const colon = pair.indexOf(':');
          const ok = colon >= 0 && pair.slice(0, colon) === 'demo' && same(pair.slice(colon + 1), opts.basicPassword?.());
          return ok ? json(res, 200, { authenticated: true, scheme: 'basic', user: 'demo' }) : refuse('Use Basic auth with the user demo and the password {{BASIC_PASSWORD}}.');
        }
        if (path === '/auth/bearer') {
          return authorised(req) ? json(res, 200, { authenticated: true, scheme: 'bearer' }) : refuse('Send the API key as a Bearer token in the Authorization header.');
        }
        if (path === '/auth/digest') return digestAuth(req, res);
        if (path === '/auth/aws') return awsAuth(req, res, raw);
        if (path === '/auth/jwt') {
          const m = /^Bearer\s+(\S+)$/i.exec(given);
          if (!m) return refuse('Send a JWT signed with {{JWT_SECRET}} (HS256) as a Bearer token.');
          const v = verifyDemoJwt(m[1]!, opts.jwtSecret?.());
          return 'claims' in v ? json(res, 200, { authenticated: true, scheme: 'jwt', claims: v.claims }) : refuse(v.refused);
        }
      }
      if (path === '/auth/apikey' && req.method === 'GET') {
        const header = req.headers['x-api-key'];
        const query = url.searchParams.get('api_key');
        const key = apiKey();
        if (typeof header === 'string' && same(header, key)) return json(res, 200, { authenticated: true, scheme: 'apikey', in: 'header' });
        if (query !== null && same(query, key)) return json(res, 200, { authenticated: true, scheme: 'apikey', in: 'query' });
        return json(res, 401, { error: 'unauthorized', hint: 'Send {{API_KEY}} in the X-Api-Key header or the api_key query param.' });
      }
      if (path === '/auth/oauth2' && req.method === 'GET') {
        return oauthTokens.has(bearerOf(req))
          ? json(res, 200, { authenticated: true, scheme: 'oauth2', scope: 'items:read' })
          : json(res, 401, { error: 'unauthorized', hint: 'Send a token from /oauth/token (OAuth2 client credentials) as a Bearer token.' });
      }
      if (path === '/auth/public' && req.method === 'GET') return json(res, 200, { authenticated: false, scheme: 'none', message: 'A public endpoint: no auth needed.' });
      if (path === '/oauth/token') {
        if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
        const form = new URLSearchParams(raw);
        let id = form.get('client_id') ?? '';
        let secret = form.get('client_secret') ?? '';
        const basicCreds = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(req.headers.authorization ?? '');
        if (basicCreds) {
          const pair = Buffer.from(basicCreds[1]!, 'base64').toString('utf8');
          const colon = pair.indexOf(':');
          if (colon >= 0) { id = decodeURIComponent(pair.slice(0, colon)); secret = decodeURIComponent(pair.slice(colon + 1)); }
        }
        if (form.get('grant_type') !== 'client_credentials') return json(res, 400, { error: 'unsupported_grant_type', error_description: 'The demo token endpoint supports client_credentials only.' });
        if (!same(id, opts.oauthClientId?.()) || !same(secret, opts.oauthClientSecret?.())) {
          return json(res, 401, { error: 'invalid_client', error_description: 'Use {{OAUTH_CLIENT_ID}} and {{OAUTH_CLIENT_SECRET}} from the Demo environment.' });
        }
        return json(res, 200, { access_token: oauthTokens.issue('oat-'), token_type: 'Bearer', expires_in: 3600, scope: 'items:read' });
      }
      if (path === '/chain/token' && req.method === 'POST') return json(res, 200, { token: chainTokens.issue('chain-'), expires_in: 600 });
      if (path === '/chain/me' && req.method === 'GET') {
        return chainTokens.has(bearerOf(req))
          ? json(res, 200, { authenticated: true, scheme: 'chained token' })
          : json(res, 401, { error: 'unauthorized', hint: 'Send Chain 1: Get token first: its test saves {{token}}.' });
      }
      if (path === '/vars/secret' && req.method === 'GET') {
        const given = req.headers['x-demo-secret'];
        return typeof given === 'string' && same(given, opts.demoSecret?.())
          ? json(res, 200, { secretAccepted: true })
          : json(res, 401, { error: 'unauthorized', hint: 'Send {{DEMO_SECRET}} in the X-Demo-Secret header.' });
      }
      if (path === '/echo') {
        const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
        let body: unknown = raw === '' ? null : raw;
        if (raw !== '' && /[/+]json$/.test(type)) {
          try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'The body is not valid JSON' }); }
        } else if (type === 'application/x-www-form-urlencoded') {
          body = Object.fromEntries(new URLSearchParams(raw));
        } else if (type === 'multipart/form-data') {
          body = parseMultipart(raw, req.headers['content-type'] ?? '') ?? raw;
        }
        const headers = Object.fromEntries(Object.entries(req.headers).filter(([k, v]) => !HIDDEN_HEADERS.has(k) && typeof v === 'string'));
        const echo = { method: req.method, path, query: Object.fromEntries(url.searchParams), headers, contentType: type || null, body };
        return json(res, 200, scrub(echo, knownSecrets()));
      }
      if (path === '/items' || /^\/items\/\d+$/.test(path)) {
        const id = path === '/items' ? undefined : Number(path.slice('/items/'.length));
        const item = id === undefined ? undefined : ITEMS.find((x) => x.id === id);
        const allow = id === undefined ? ALLOW_ITEMS : ALLOW_ITEM;
        const readBody = (): Record<string, unknown> | undefined => {
          try {
            const b: unknown = JSON.parse(raw || '{}');
            return b && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : undefined;
          } catch { return undefined; }
        };
        const pick = (b: Record<string, unknown>) => ({
          ...(typeof b.name === 'string' ? { name: b.name.slice(0, 200) } : {}),
          ...(typeof b.price === 'number' ? { price: b.price } : {}),
          ...(Array.isArray(b.tags) ? { tags: b.tags.filter((t) => typeof t === 'string').slice(0, 20) } : {}),
        });
        if (req.method === 'OPTIONS') { res.writeHead(204, { allow }); res.end(); return; }
        if (id !== undefined && !item) return json(res, 404, { error: 'not found', hint: `Items have ids 1 to ${ITEMS.length}.` });
        if (id === undefined) {
          if (req.method === 'HEAD') { res.writeHead(200, { 'content-type': 'application/json', 'x-total-count': String(ITEMS.length) }); res.end(); return; }
          if (req.method === 'GET') {
            const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? ITEMS.length) || ITEMS.length, 1), ITEMS.length);
            const sort = url.searchParams.get('sort') === 'name' ? 'name' : 'id';
            const items = [...ITEMS].sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name) : a.id - b.id)).slice(0, limit);
            return json(res, 200, { total: ITEMS.length, limit, sort, debug: url.searchParams.has('debug'), items });
          }
          if (req.method === 'POST') {
            const b = readBody();
            if (!b || typeof b.name !== 'string') return json(res, 400, { error: 'Send a JSON body with a name' });
            return json(res, 201, { id: ITEMS.length + 1, price: 0, tags: [], ...pick(b) });
          }
        } else {
          if (req.method === 'GET') return json(res, 200, item);
          if (req.method === 'HEAD') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(); return; }
          if (req.method === 'PUT') {
            const b = readBody();
            if (!b || typeof b.name !== 'string') return json(res, 400, { error: 'PUT replaces the whole item: send a JSON body with a name' });
            return json(res, 200, { id, price: 0, tags: [], ...pick(b) });
          }
          if (req.method === 'PATCH') {
            const b = readBody();
            if (!b) return json(res, 400, { error: 'Send a JSON object with the fields to change' });
            return json(res, 200, { ...item, ...pick(b), id });
          }
          if (req.method === 'DELETE') { res.writeHead(204); res.end(); return; }
        }
        res.writeHead(405, { 'content-type': 'application/json', allow });
        res.end(JSON.stringify({ error: 'method not allowed' }));
        return;
      }
      if (req.method === 'GET' && path.startsWith('/formats/')) {
        const send = (type: string, body: string | Buffer) => { res.writeHead(200, { 'content-type': type }); res.end(body); };
        switch (path.slice('/formats/'.length)) {
          case 'json': return json(res, 200, { format: 'json', item: ITEMS[2], tags: ['a', 'b'], nested: { ok: true, count: 3 } });
          case 'xml': return send('application/xml; charset=utf-8', XML_DOC);
          case 'html': return send('text/html; charset=utf-8', HTML_DOC);
          case 'text': return send('text/plain; charset=utf-8', TEXT_DOC);
          case 'png': return send('image/png', demoPng());
          case 'large': return send('application/json', demoLargeJson());
        }
      }
      const code = /^\/status\/(\d{3})$/.exec(path);
      if (code) {
        const n = Number(code[1]);
        if (n < 200 || n > 599) return json(res, 400, { error: 'Ask for a status from 200 to 599' });
        if (n === 204 || n === 304) { res.writeHead(n); res.end(); return; }
        return json(res, n, { status: n, message: STATUS_CODES[n] ?? 'Unknown', ...(n >= 400 ? { error: STATUS_CODES[n] ?? 'error' } : {}) });
      }
      if (path === '/redirect') { res.writeHead(302, { location: '/formats/json', 'content-type': 'application/json' }); res.end('{"redirect":"/formats/json"}'); return; }
      if (path === '/delay') {
        const asked = Number(url.searchParams.get('ms') ?? 1000);
        const ms = Number.isFinite(asked) ? Math.min(Math.max(Math.round(asked), 0), DEMO_MAX_DELAY_MS) : 0;
        const timer = setTimeout(() => json(res, 200, { delayedMs: ms, maxMs: DEMO_MAX_DELAY_MS }), ms);
        res.on('close', () => clearTimeout(timer));
        return;
      }
      if (path === '/response-headers') {
        res.writeHead(200, {
          'content-type': 'application/json', 'x-request-id': 'demo-request-0001', 'x-ratelimit-limit': '100', 'x-ratelimit-remaining': '99',
          'cache-control': 'no-store', etag: '"demo-v1"', 'x-powered-by': 'JanusAPI demo mock',
        });
        res.end(JSON.stringify({ message: 'See the Headers tab for the custom response headers.' }));
        return;
      }
      if (req.method === 'GET' && user) {
        if (!authorised(req)) return json(res, 401, unauthorised);
        return json(res, 200, { id: Number(user[1]), name: 'Ada Lovelace', email: 'ada@example.com' });
      }
      if (req.method === 'POST' && path === '/articles') {
        if (!authorised(req)) return json(res, 401, unauthorised);
        let body: unknown = {};
        try { body = JSON.parse(raw || '{}'); } catch { return json(res, 400, { error: 'body must be JSON' }); }
        return json(res, 201, { id: 1, ...(body && typeof body === 'object' ? body : {}) });
      }
      return json(res, 404, { error: 'not found' });
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

export class DemoService {
  private mock?: Promise<MockApi>;
  constructor(private d: { dir: string; secrets: SecretStore; session: AppSession; graphql?: boolean }) {}

  async open(discardUnsaved: boolean): Promise<CollectionSnapshot | null> {
    this.d.session.assertCanSwitch(discardUnsaved);
    const scope = `env:${ENV_ID}`;
    for (const [name, make] of DEMO_SECRETS) {
      if (!this.d.secrets.get(this.d.dir, scope, name)) await this.d.secrets.set(this.d.dir, scope, name, make());
    }
    const secret = (name: string) => () => this.d.secrets.get(this.d.dir, scope, name);
    this.mock ??= startMockApi(secret(KEY), {
      basicPassword: secret(BASIC_PASSWORD), jwtSecret: secret(JWT_SECRET),
      oauthClientId: secret(OAUTH_CLIENT_ID), oauthClientSecret: secret(OAUTH_CLIENT_SECRET), demoSecret: secret(DEMO_SECRET),
      digestPassword: secret(DIGEST_PASSWORD), awsAccessKeyId: secret(AWS_ACCESS_KEY_ID), awsSecretAccessKey: secret(AWS_SECRET_ACCESS_KEY),
    }).catch((e) => { this.mock = undefined; throw e; });
    const mock = await this.mock;
    await writeDemo(this.d.dir, mock.url, this.d.graphql === undefined ? {} : { graphql: this.d.graphql });
    return this.d.session.openAt(this.d.dir, discardUnsaved);
  }

  async close(): Promise<void> {
    const m = this.mock;
    this.mock = undefined;
    if (m) await (await m).close();
  }
}

export function demoHandlers(demo: DemoService): Record<'collection:openDemo', Handler> {
  return {
    'collection:openDemo': {
      schema: schemas['collection:openDemo'],
      run: (i: { discardUnsaved?: true }) => demo.open(i.discardUnsaved === true),
    },
  };
}
