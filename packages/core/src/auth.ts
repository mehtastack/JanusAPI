import type { Auth, CollectionConfig, FolderConfig } from './schema';
import type { PreparedRequest } from './http';
import { signJwt, placeJwt } from './jwt';
import { applyAwsV4 } from './awsv4';

export function effectiveAuth(request: Auth, folders: FolderConfig[], collection: CollectionConfig): Auth {
  if (request.type !== 'inherit') return request;
  for (let i = folders.length - 1; i >= 0; i--) {
    const a = folders[i].auth;
    if (a && a.type !== 'inherit') return a;
  }
  return collection.auth && collection.auth.type !== 'inherit' ? collection.auth : { type: 'none' };
}

export function setHeader(p: PreparedRequest, name: string, value: string): PreparedRequest {
  const lower = name.toLowerCase();
  return { ...p, headers: [...p.headers.filter(([k]) => k.toLowerCase() !== lower), [name, value]] };
}

/** vars resolve a JWT payload and header by position (resolveRequest leaves those templates alone). */
export function applyAuth(p: PreparedRequest, auth: Auth, vars?: ReadonlyMap<string, string>): PreparedRequest {
  switch (auth.type) {
    case 'none':
    case 'inherit':
      return p;
    case 'bearer':
      return setHeader(p, 'Authorization', `Bearer ${auth.token}`);
    case 'basic':
      return setHeader(p, 'Authorization', `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`);
    case 'apikey': {
      if (auth.in === 'header') return setHeader(p, auth.key, auth.value);
      const url = new URL(p.url);
      url.searchParams.set(auth.key, auth.value);
      return { ...p, url: url.toString() };
    }
    case 'jwt':
      // A fresh token for every send (resolve {{vars}} first: see resolveRequest).
      return placeJwt(p, auth, signJwt(auth, { vars }).token);
    case 'awsv4':
      return applyAwsV4(p, auth).prepared;
    case 'digest':
      // Digest answers a challenge: see sendWithDigest (runRequest).
      return p;
    case 'oauth2':
      throw new Error('OAuth2 is not available yet');
  }
}
