import { z } from 'zod';

export const FORMAT_VERSION = 1;
export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

/** The largest GraphQL query, variables text or editor input the app accepts (256 KB). */
export const GRAPHQL_TEXT_LIMIT = 256 * 1024;

const version = z.number().int().positive();

export const KeyValueSchema = z.object({
  name: z.string(),
  value: z.string(),
  enabled: z.boolean().optional(),
});

/** JWT signing algorithms for jwt auth: HMAC (HS*), RSA PKCS#1 v1.5 (RS*), ECDSA (ES*) and RSA-PSS (PS256). */
export const JWT_ALGORITHMS = ['HS256', 'HS384', 'HS512', 'RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'PS256'] as const;

/** Digest algorithms JanusAPI answers, weakest first. */
export const DIGEST_ALGORITHMS = ['MD5', 'MD5-sess', 'SHA-256', 'SHA-256-sess'] as const;

export const AuthSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('inherit') }),
  z.object({ type: z.literal('bearer'), token: z.string() }),
  z.object({ type: z.literal('basic'), username: z.string(), password: z.string() }),
  z.object({ type: z.literal('apikey'), key: z.string(), value: z.string(), in: z.enum(['header', 'query']) }),
  z.object({
    type: z.literal('jwt'),
    algorithm: z.enum(JWT_ALGORITHMS),
    /** The HMAC secret, or a PEM private key for RS, ES and PS; usually {{SECRET}}. */
    secret: z.string(),
    /** The HMAC secret is base64-encoded. */
    secretBase64: z.boolean().optional(),
    /** The claims, as JSON text; {{vars}} are resolved before signing. */
    payload: z.string(),
    /** Extra JOSE header fields as JSON text (alg and typ are always set by JanusAPI). */
    header: z.string().optional(),
    addIssuedAt: z.boolean().optional(),
    expiresInSeconds: z.number().int().min(1).max(315_360_000).optional(),
    in: z.enum(['header', 'query']),
    /** Header placement: the scheme word before the token (default Bearer; empty sends the bare token). */
    headerPrefix: z.string().optional(),
    /** Query placement: the param name (default token). */
    queryParam: z.string().optional(),
  }),
  /**
   * HTTP Digest (RFC 7616, RFC 2617): the request goes out, and a 401 Digest challenge is answered once. Usually only the user
   * name and password are set; the rest override what the server's challenge says.
   */
  z.object({
    type: z.literal('digest'),
    username: z.string(),
    password: z.string(),
    algorithm: z.enum(DIGEST_ALGORITHMS).optional(),
    realm: z.string().optional(),
    nonce: z.string().optional(),
    qop: z.enum(['auth', 'auth-int']).optional(),
    opaque: z.string().optional(),
  }),
  /** AWS Signature Version 4: every send is signed after its variables are resolved. */
  z.object({
    type: z.literal('awsv4'),
    accessKeyId: z.string(),
    secretAccessKey: z.string(),
    sessionToken: z.string().optional(),
    region: z.string(),
    service: z.string(),
    /** false: the payload is not hashed (UNSIGNED-PAYLOAD). Default true; a streamed file is never hashed. */
    signBody: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('oauth2'),
    grant: z.enum(['client_credentials', 'password', 'authorization_code']),
    tokenUrl: z.string(),
    authUrl: z.string().optional(),
    clientId: z.string(),
    clientSecret: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    scope: z.string().optional(),
  }),
]);

/**
 * A file to upload: a relative POSIX path (inside the collection, resolved against its root at send time; it may never climb out
 * with ..) or an explicit absolute path (a file outside the collection, which teammates won't have). contentType overrides the
 * type found from the file's extension.
 */
export const FileRefSchema = z.object({
  path: z.string().max(4096),
  contentType: z.string().max(255).optional(),
});

/** A multipart field: text (the default, so older files stay valid) or a file read from disk at send time. */
export const MultipartFieldSchema = z.object({
  name: z.string(),
  value: z.string(),
  enabled: z.boolean().optional(),
  kind: z.enum(['text', 'file']).optional(),
  file: FileRefSchema.optional(),
});

export const BodySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('json'), content: z.string() }),
  z.object({ type: z.literal('text'), content: z.string() }),
  z.object({ type: z.literal('form-urlencoded'), fields: z.array(KeyValueSchema) }),
  z.object({ type: z.literal('multipart'), fields: z.array(MultipartFieldSchema) }),
  /** The bytes of one file, streamed from disk as the whole body. */
  z.object({ type: z.literal('binary'), file: FileRefSchema }),
  z.object({
    type: z.literal('graphql'),
    query: z.string().max(GRAPHQL_TEXT_LIMIT),
    variables: z.string().max(GRAPHQL_TEXT_LIMIT).optional(),
    operationName: z.string().max(1024).optional(),
  }),
]);

export const RequestSchema = z.object({
  apijanus: version,
  name: z.string().min(1),
  method: z.enum(METHODS),
  url: z.string(),
  params: z.array(KeyValueSchema).default([]),
  headers: z.array(KeyValueSchema).default([]),
  auth: AuthSchema.default({ type: 'inherit' }),
  body: BodySchema.default({ type: 'none' }),
  script: z.string().optional(),
  tests: z.string().optional(),
  seq: z.number().int().min(0).max(1_000_000).optional(),
  /** false: "Don't send or save cookies" (the cookie jar neither adds a Cookie header nor stores Set-Cookie). */
  cookies: z.literal(false).optional(),
  /** false: "Don't use proxy" (every hop of this request connects directly, whatever the app's proxy settings). */
  proxy: z.literal(false).optional(),
});

export const EnvVarSchema = z.object({
  name: z.string().min(1),
  value: z.string().optional(),
  secret: z.boolean().optional(),
});

export const EnvironmentSchema = z.object({
  apijanus: version,
  name: z.string().min(1),
  variables: z.array(EnvVarSchema).default([]),
});

export const CollectionConfigSchema = z.object({
  apijanus: version,
  name: z.string().min(1),
  auth: AuthSchema.optional(),
  headers: z.array(KeyValueSchema).default([]),
  variables: z.array(EnvVarSchema).default([]),
  allowSelfSigned: z.boolean().default(false),
  /** Pre-request script run before every request's own (and its folders'). */
  script: z.string().optional(),
  /** Test script run after every response, before its folders' and the request's own. */
  tests: z.string().optional(),
});

export const FolderConfigSchema = z.object({
  apijanus: version,
  auth: AuthSchema.optional(),
  headers: z.array(KeyValueSchema).default([]),
  /** Pre-request script run for every request in the folder (and its subfolders), after the collection's and outer folders'. */
  script: z.string().optional(),
  /** Test script run for every request in the folder, after the collection's and outer folders' tests. */
  tests: z.string().optional(),
});

export type KeyValue = z.infer<typeof KeyValueSchema>;
export type Auth = z.infer<typeof AuthSchema>;
export type Body = z.infer<typeof BodySchema>;
export type FileRef = z.infer<typeof FileRefSchema>;
export type MultipartField = z.infer<typeof MultipartFieldSchema>;
export type GraphqlBody = Extract<Body, { type: 'graphql' }>;
export type Request = z.infer<typeof RequestSchema>;
export type EnvVar = z.infer<typeof EnvVarSchema>;
export type Environment = z.infer<typeof EnvironmentSchema>;
export type CollectionConfig = z.infer<typeof CollectionConfigSchema>;
export type FolderConfig = z.infer<typeof FolderConfigSchema>;
