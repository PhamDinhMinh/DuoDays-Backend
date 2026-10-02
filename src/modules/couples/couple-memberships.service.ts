import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';

import { CoupleMembership } from './couple-membership.schema.js';

import type { ClientSession, Model, Types } from 'mongoose';
import type { CoupleMembershipRecord, MembershipRole } from './couple-membership.schema.js';

/**
 * Membership reads and writes. Every method accepts a session so it can run inside the
 * create, join and cancel transactions.
 */
@Injectable()
export class CoupleMembershipsService {
  constructor(
    @InjectModel(CoupleMembership.name) private readonly memberships: Model<CoupleMembership>,
  ) {}

  findActiveByUser(
    userId: Types.ObjectId,
    session?: ClientSession,
  ): Promise<CoupleMembershipRecord | null> {
    return this.memberships
      .findOne({ userId, status: 'active' }, null, { session })
      .lean<CoupleMembershipRecord>()
      .exec();
  }

  /** Creator first, then partner. */
  async findActiveByCouple(
    coupleId: Types.ObjectId,
    session?: ClientSession,
  ): Promise<CoupleMembershipRecord[]> {
    const members = await this.memberships
      .find({ coupleId, status: 'active' }, null, { session })
      .lean<CoupleMembershipRecord[]>()
      .exec();
    return members.sort((a, b) => roleOrder(a.role) - roleOrder(b.role));
  }

  /**
   * Inserts an active membership. Throws a Mongo duplicate-key error (11000) when the user
   * already has an active membership (`userId_1`) or the couple already has this role
   * (`coupleId_1_role_1`) – callers map that to a public error.
   */
  async create(
    input: { coupleId: Types.ObjectId; userId: Types.ObjectId; role: MembershipRole },
    session?: ClientSession,
  ): Promise<void> {
    await this.memberships.create([{ ...input, status: 'active' }], { session });
  }

  /** active → left. False when there is no such active membership. */
  async end(
    input: { coupleId: Types.ObjectId; userId: Types.ObjectId; role: MembershipRole },
    session: ClientSession,
  ): Promise<boolean> {
    const result = await this.memberships.updateOne(
      { ...input, status: 'active' },
      { $set: { status: 'left' } },
      { session },
    );
    return result.matchedCount === 1;
  }
}

function roleOrder(role: MembershipRole): number {
  return role === 'creator' ? 0 : 1;
}

/** True for the duplicate-key error raised by the one-active-couple-per-user index. */
export function isUserAlreadyInCoupleError(error: unknown): boolean {
  return isDuplicateKeyOn(error, 'userId');
}

/** True for the duplicate-key error raised by the one-creator-one-partner index. */
export function isCoupleRoleTakenError(error: unknown): boolean {
  return isDuplicateKeyOn(error, 'coupleId,role');
}

/**
 * A Mongo duplicate-key error on exactly these index keys (comma-joined, in order).
 *
 * Matched on `keyPattern` only: with the server/driver versions used here (MongoDB 8,
 * driver 7) the error carries no structured index name – its `index` field is the
 * write's position in the batch, and the name (`code_1`, …) appears only inside `errmsg`,
 * which we deliberately do not parse. Callers apply this only to errors from writes to
 * one known collection, and each collection's unique key patterns are distinct, so the
 * key pattern identifies the index.
 */
export function isDuplicateKeyOn(error: unknown, keys: string): boolean {
  const { code, keyPattern } = (error ?? {}) as { code?: unknown; keyPattern?: unknown };
  return (
    code === 11000 &&
    typeof keyPattern === 'object' &&
    keyPattern !== null &&
    Object.keys(keyPattern).join() === keys
  );
}
