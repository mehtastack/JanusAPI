import { createRequire } from 'node:module';
import { generateKeyPairSync } from 'node:crypto';

// node-forge comes with the selfsigned dev dependency; it is loaded from there so tests add no dependency of their own.
const requireHere = createRequire(import.meta.url);
const forgeRequire = createRequire(requireHere.resolve('selfsigned'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const forge = forgeRequire('node-forge') as any;

export interface TestCa { cert: string; key: string; name: string }
export interface TestLeaf { cert: string; key: string }

function keyPair(): { pub: unknown; priv: unknown; pem: string } {
  // Generated natively (fast), then read into forge for signing.
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const priv = forge.pki.privateKeyFromPem(pem);
  const pub = forge.pki.setRsaPublicKey(priv.n, priv.e);
  return { pub, priv, pem };
}

let serial = 1;
function makeCert(opts: {
  subject: string; issuer?: { name: string; key: unknown }; pub: unknown; priv: unknown; ca?: boolean; altNames?: string[]; client?: boolean; days?: number;
}): string {
  const cert = forge.pki.createCertificate();
  cert.publicKey = opts.pub;
  cert.serialNumber = (serial++).toString(16).padStart(2, '0');
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + (opts.days ?? 2) * 86_400_000);
  cert.setSubject([{ name: 'commonName', value: opts.subject }, { name: 'organizationName', value: 'JanusAPI Test' }]);
  cert.setIssuer([{ name: 'commonName', value: opts.issuer?.name ?? opts.subject }, { name: 'organizationName', value: 'JanusAPI Test' }]);
  const ext: unknown[] = [{ name: 'basicConstraints', cA: opts.ca === true }];
  if (opts.ca) ext.push({ name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true });
  else ext.push({ name: 'keyUsage', digitalSignature: true, keyEncipherment: true }, { name: 'extKeyUsage', serverAuth: !opts.client, clientAuth: true });
  if (opts.altNames) {
    ext.push({ name: 'subjectAltName', altNames: opts.altNames.map((n) => (/^[\d.]+$/.test(n) || n.includes(':') ? { type: 7, ip: n } : { type: 2, value: n })) });
  }
  cert.setExtensions(ext);
  cert.sign((opts.issuer?.key ?? opts.priv), forge.md.sha256.create());
  return forge.pki.certificateToPem(cert);
}

/** A certificate authority for tests. */
export function testCa(name = 'JanusAPI Test CA'): TestCa & { priv: unknown } {
  const k = keyPair();
  return { cert: makeCert({ subject: name, pub: k.pub, priv: k.priv, ca: true }), key: k.pem, name, priv: k.priv };
}

/** A server certificate for localhost and 127.0.0.1 signed by ca. */
export function serverCert(ca: TestCa & { priv: unknown }, hosts = ['localhost', '127.0.0.1', '::1']): TestLeaf {
  const k = keyPair();
  return { cert: makeCert({ subject: hosts[0]!, issuer: { name: ca.name, key: ca.priv }, pub: k.pub, priv: k.priv, altNames: hosts }), key: k.pem };
}

/** A client certificate signed by ca. */
export function clientCert(ca: TestCa & { priv: unknown }, name = 'Test Client'): TestLeaf {
  const k = keyPair();
  return { cert: makeCert({ subject: name, issuer: { name: ca.name, key: ca.priv }, pub: k.pub, priv: k.priv, client: true }), key: k.pem };
}

/** A PKCS#12 (PFX) bundle of a certificate and its key, protected by passphrase. */
export function toPfx(leaf: TestLeaf, passphrase: string): Buffer {
  const key = forge.pki.privateKeyFromPem(leaf.key);
  const cert = forge.pki.certificateFromPem(leaf.cert);
  const asn1 = forge.pkcs12.toPkcs12Asn1(key, [cert], passphrase, { algorithm: 'aes256' });
  return Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary');
}

/** A private key PEM encrypted with passphrase. */
export function encryptedKey(leaf: TestLeaf, passphrase: string): string {
  const key = forge.pki.privateKeyFromPem(leaf.key);
  return forge.pki.encryptRsaPrivateKey(key, passphrase, { algorithm: 'aes256' });
}
