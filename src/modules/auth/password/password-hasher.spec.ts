import { hash } from 'argon2';
import { describe, expect, it } from 'vitest';

import { PasswordHasher } from './password-hasher.js';

describe('PasswordHasher', () => {
  const hasher = new PasswordHasher();

  it('produces salted Argon2id hashes with m=19456, t=2, p=1', async () => {
    const [first, second] = await Promise.all([
      hasher.hash('same password'),
      hasher.hash('same password'),
    ]);
    expect(first).toMatch(/^\$argon2id\$v=19\$m=19456,p=1,t=2\$[^$]+\$[^$]+$/);
    expect(first).not.toBe(second);
    expect(first).not.toContain('same password');
  });

  it('verifies the exact password only – no trimming, case folding or normalization', async () => {
    const password = ' Pass Word ';
    const stored = await hasher.hash(password);
    expect(await hasher.verify(stored, password)).toBe(true);
    for (const variant of ['Pass Word', ' pass word ', ' PASS WORD ', ' Pass Word  ']) {
      expect(await hasher.verify(stored, variant)).toBe(false);
    }
    const nfc = 'Mật khẩu'.normalize('NFC');
    const nfcHash = await hasher.hash(nfc);
    expect(await hasher.verify(nfcHash, nfc.normalize('NFD'))).toBe(false);
  });

  it('returns false (never throws) for a malformed stored hash', async () => {
    expect(await hasher.verify('not-a-hash', 'anything')).toBe(false);
    expect(await hasher.verify('', 'anything')).toBe(false);
  });

  it('flags hashes made with other parameters for rehash', async () => {
    expect(hasher.needsRehash(await hasher.hash('x'))).toBe(false);
    const weaker = await hash('x', { memoryCost: 8192, timeCost: 1, parallelism: 1 });
    expect(hasher.needsRehash(weaker)).toBe(true);
  });

  it('dummy verification always fails but does real work', async () => {
    const started = performance.now();
    expect(await hasher.verifyDummy('anything')).toBe(false);
    expect(performance.now() - started).toBeGreaterThan(1);
  });
});
