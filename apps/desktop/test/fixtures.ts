import type { Cipher } from '../src/main/secrets';

export const testCipher: Cipher = {
  isAvailable: () => true,
  encrypt: (s) => Buffer.from(`enc:${s}`),
  decrypt: (b) => b.toString().slice(4),
};
