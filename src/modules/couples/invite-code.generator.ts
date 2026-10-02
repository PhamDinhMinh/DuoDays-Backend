import { randomInt } from 'node:crypto';

import { Injectable } from '@nestjs/common';

/** 100000–999999: always six digits, never a leading zero to lose in a number conversion. */
export const INVITE_CODE_MIN = 100_000;
export const INVITE_CODE_MAX_EXCLUSIVE = 1_000_000;
/** Accepted input: any six digits (a code outside the issued range is simply not found). */
export const INVITE_CODE_PATTERN = /^\d{6}$/;

/**
 * Invite codes from the CSPRNG (uniform, unpredictable, not sequential). A provider so
 * tests can force collisions; uniqueness itself is enforced by the `code_1` index.
 */
@Injectable()
export class InviteCodeGenerator {
  next(): string {
    return String(randomInt(INVITE_CODE_MIN, INVITE_CODE_MAX_EXCLUSIVE));
  }
}
