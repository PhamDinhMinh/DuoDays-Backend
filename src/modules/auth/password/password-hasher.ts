import { randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { argon2id, hash, needsRehash, verify } from 'argon2';

/**
 * Argon2id at OWASP's minimum recommended cost. The encoded hash
 * (`$argon2id$v=19$m=19456,p=1,t=2$<salt>$<hash>`) carries its own parameters and a
 * random 16-byte salt, so raising these later only needs `needsRehash` on next login.
 */
export const ARGON2_OPTIONS = {
  type: argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * Passwords are hashed and verified exactly as received – never trimmed, case-folded or
 * Unicode-normalized.
 */
@Injectable()
export class PasswordHasher {
  /** Verified against when the account does not exist, so both paths cost the same. */
  private readonly dummyHash = hash(randomBytes(32).toString('base64url'), ARGON2_OPTIONS);

  hash(password: string): Promise<string> {
    return hash(password, ARGON2_OPTIONS);
  }

  /** False on mismatch and on a malformed stored hash – never throws. */
  async verify(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await verify(passwordHash, password);
    } catch {
      return false;
    }
  }

  needsRehash(passwordHash: string): boolean {
    return needsRehash(passwordHash, ARGON2_OPTIONS);
  }

  /** Spends one real verification and always reports failure. */
  async verifyDummy(password: string): Promise<false> {
    await this.verify(await this.dummyHash, password);
    return false;
  }
}
