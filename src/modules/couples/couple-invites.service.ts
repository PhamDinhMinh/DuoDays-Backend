import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import mongoose from 'mongoose';

import { CoupleInvite } from './couple-invite.schema.js';
import { isDuplicateKeyOn } from './couple-memberships.service.js';
import { INVITE_RETENTION_MS } from './couples.constants.js';

import type { ClientSession, Model, Types } from 'mongoose';
import type { CoupleInviteRecord } from './couple-invite.schema.js';

/** Usable ⇔ still `active` and the server clock is strictly before `expiresAt`. */
export function isUsableInvite(
  invite: Pick<CoupleInviteRecord, 'status' | 'expiresAt'>,
  nowMs: number,
): boolean {
  return invite.status === 'active' && nowMs < invite.expiresAt.getTime();
}

/**
 * Invite persistence. State changes are single conditional updates so they compose into
 * the issue, cancel and join transactions (every method takes the session).
 */
@Injectable()
export class CoupleInvitesService {
  constructor(@InjectModel(CoupleInvite.name) private readonly invites: Model<CoupleInvite>) {}

  /** The couple's `active` invite (usable or already expired), if any. */
  findActiveByCouple(
    coupleId: Types.ObjectId,
    session?: ClientSession,
  ): Promise<CoupleInviteRecord | null> {
    return this.invites
      .findOne({ coupleId, status: 'active' }, null, { session })
      .lean<CoupleInviteRecord>()
      .exec();
  }

  /** Codes are unique until purged, so this is at most one document in any state. */
  findByCode(code: string): Promise<CoupleInviteRecord | null> {
    return this.invites.findOne({ code }).lean<CoupleInviteRecord>().exec();
  }

  /**
   * Inserts an active invite. Throws a duplicate-key error on `code_1` when the code is
   * taken (see isInviteCodeTakenError) – the caller retries with a new code.
   */
  async insert(
    input: { coupleId: Types.ObjectId; code: string; expiresAt: Date },
    session: ClientSession,
  ): Promise<CoupleInviteRecord> {
    const [created] = await this.invites.create(
      [
        {
          ...input,
          status: 'active',
          purgeAt: new Date(input.expiresAt.getTime() + INVITE_RETENTION_MS),
        },
      ],
      { session },
    );
    return created.toObject<CoupleInviteRecord>();
  }

  /** active → revoked for the couple's current invite (at most one exists). */
  async revokeActiveByCouple(
    coupleId: Types.ObjectId,
    now: Date,
    session: ClientSession,
  ): Promise<void> {
    await this.invites.updateMany(
      { coupleId, status: 'active' },
      { $set: { status: 'revoked', purgeAt: new Date(now.getTime() + INVITE_RETENTION_MS) } },
      { session },
    );
  }

  /**
   * The join's compare-and-swap: active and unexpired → redeemed, stamped with the server
   * time. False when the invite was meanwhile redeemed, revoked or has expired.
   */
  async redeem(
    inviteId: Types.ObjectId,
    userId: Types.ObjectId,
    now: Date,
    session: ClientSession,
  ): Promise<boolean> {
    const result = await this.invites.updateOne(
      { _id: inviteId, status: 'active', expiresAt: mongoose.trusted({ $gt: now }) },
      {
        $set: {
          status: 'redeemed',
          redeemedByUserId: userId,
          redeemedAt: now,
          purgeAt: new Date(now.getTime() + INVITE_RETENTION_MS),
        },
      },
      { session },
    );
    return result.matchedCount === 1;
  }
}

/** The generated code is already taken (unique `code_1`). The error carries the code – never log it. */
export function isInviteCodeTakenError(error: unknown): boolean {
  return isDuplicateKeyOn(error, 'code');
}
