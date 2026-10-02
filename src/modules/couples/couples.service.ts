import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';

import { AppException } from '../../common/errors/app.exception.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { createPublicId } from '../../common/ids/public-id.js';
import { TransactionService } from '../../database/transaction.service.js';
import { UsersService } from '../users/users.service.js';
import { CoupleAccessService } from './couple-access.service.js';
import { Couple, isPublicCoupleStatus } from './couple.schema.js';
import {
  CoupleMembershipsService,
  isUserAlreadyInCoupleError,
} from './couple-memberships.service.js';
import { toCoupleDto, toCoupleSummaryDto } from './dto/couple.dto.js';

import type { ClientSession, Model, Types } from 'mongoose';
import type { AuthContext } from '../auth/auth-context.js';
import type { CoupleRecord } from './couple.schema.js';
import type { CreateCoupleDto, UpdateCoupleDto } from './dto/couple-request.dto.js';
import type { CoupleDto, CoupleSummaryDto } from './dto/couple.dto.js';

const alreadyInCouple = () =>
  new AppException(
    ErrorCode.ALREADY_IN_COUPLE,
    HttpStatus.CONFLICT,
    'You are already part of a couple.',
  );

const coupleNotFound = () =>
  new AppException(ErrorCode.COUPLE_NOT_FOUND, HttpStatus.NOT_FOUND, 'Couple not found.');

export const coupleNotPending = () =>
  new AppException(
    ErrorCode.COUPLE_NOT_PENDING,
    HttpStatus.CONFLICT,
    'This couple can no longer be edited.',
  );

/**
 * The couple domain. Couples are created `pending`; activation belongs to the join
 * transaction and cancellation to CoupleSetupService, both through the session-aware
 * conditional writes below. Logs carry public ids and field names only – never names or
 * dates.
 */
@Injectable()
export class CouplesService {
  private readonly logger = new Logger('Couples');

  constructor(
    @InjectModel(Couple.name) private readonly couples: Model<Couple>,
    private readonly memberships: CoupleMembershipsService,
    private readonly users: UsersService,
    private readonly access: CoupleAccessService,
    private readonly transactions: TransactionService,
  ) {}

  /** Couple + creator membership + creator's display name, all or nothing. */
  async create(auth: AuthContext, dto: CreateCoupleDto): Promise<CoupleDto> {
    const caller = await this.access.requireCaller(auth);
    if (await this.memberships.findActiveByUser(caller._id)) {
      throw alreadyInCouple();
    }

    let couple: CoupleRecord;
    try {
      couple = await this.transactions.run(async session => {
        const [created] = await this.couples.create(
          [
            {
              publicId: createPublicId('cpl'),
              status: 'pending',
              createdByUserId: caller._id,
              startDate: dto.startDate,
              pendingPartnerName: dto.partnerName,
            },
          ],
          { session },
        );
        // The partial unique index on memberships.userId is what really guarantees one
        // active couple per user: a concurrent create fails here and rolls back its couple.
        await this.memberships.create(
          { coupleId: created._id, userId: caller._id, role: 'creator' },
          session,
        );
        await this.users.updateDisplayName(caller._id, dto.ownerName, session);
        return created.toObject<CoupleRecord>();
      });
    } catch (error) {
      if (isUserAlreadyInCoupleError(error)) {
        this.logger.log({ userId: caller.publicId }, 'couple.create_conflict');
        throw alreadyInCouple();
      }
      throw error;
    }

    this.logger.log({ userId: caller.publicId, coupleId: couple.publicId }, 'couple.created');
    return this.toDetail(couple);
  }

  async getForMember(auth: AuthContext, couplePublicId: string): Promise<CoupleDto> {
    const { couple } = await this.access.requireMember(auth, couplePublicId);
    return this.toDetail(couple);
  }

  /**
   * Creator-only, pending-only. Order of checks: not a member → 404, not pending → 409,
   * not the creator → 403. "Still pending" is re-checked atomically in the write itself.
   */
  async update(
    auth: AuthContext,
    couplePublicId: string,
    dto: UpdateCoupleDto,
  ): Promise<CoupleDto> {
    const access = await this.access.requireMember(auth, couplePublicId);
    if (access.couple.status !== 'pending') {
      throw coupleNotPending();
    }
    this.access.requireCreator(access);

    const coupleChanges: Partial<Pick<Couple, 'startDate' | 'pendingPartnerName'>> = {};
    if (dto.startDate !== undefined) {
      coupleChanges.startDate = dto.startDate;
    }
    if (dto.partnerName !== undefined) {
      coupleChanges.pendingPartnerName = dto.partnerName;
    }
    const ownerName = dto.ownerName;

    const write = async (session?: ClientSession) => {
      // For a name-only edit `coupleChanges` is {}: Mongoose timestamps still add
      // `$set.updatedAt`, so this remains a real conditional write whose `matchedCount`
      // atomically re-checks "still pending". If timestamps are ever disabled, keep this
      // update non-empty or name-only edits would wrongly fail with COUPLE_NOT_PENDING.
      const result = await this.couples.updateOne(
        { _id: access.couple._id, status: 'pending' },
        { $set: coupleChanges },
        { session },
      );
      if (result.matchedCount !== 1) {
        throw coupleNotPending();
      }
      if (ownerName !== undefined) {
        await this.users.updateDisplayName(access.caller._id, ownerName, session);
      }
    };
    // Two documents change only when the owner's name is part of the edit.
    if (ownerName !== undefined) {
      await this.transactions.run(write);
    } else {
      await write();
    }

    this.logger.log(
      {
        coupleId: access.couple.publicId,
        fields: Object.keys(dto).filter(key => dto[key as keyof UpdateCoupleDto] !== undefined),
      },
      'couple.updated',
    );
    return this.getDetailById(access.couple._id);
  }

  /** For GET /v1/auth/me: the user's pending/active couple, or null. */
  async activeCoupleSummary(userId: Types.ObjectId): Promise<CoupleSummaryDto | null> {
    const membership = await this.memberships.findActiveByUser(userId);
    if (!membership) {
      return null;
    }
    const couple = await this.couples
      .findById(membership.coupleId)
      .select({ publicId: 1, status: 1 })
      .lean<Pick<CoupleRecord, 'publicId' | 'status'>>()
      .exec();
    // A cancelled couple never has an active membership (same transaction) – defensive only.
    return couple && isPublicCoupleStatus(couple.status)
      ? toCoupleSummaryDto({ publicId: couple.publicId, status: couple.status })
      : null;
  }

  findById(id: Types.ObjectId, session?: ClientSession): Promise<CoupleRecord | null> {
    return this.couples.findById(id, null, { session }).lean<CoupleRecord>().exec();
  }

  async getDetailById(id: Types.ObjectId): Promise<CoupleDto> {
    const couple = await this.findById(id);
    if (!couple) {
      throw coupleNotFound();
    }
    return this.toDetail(couple);
  }

  /*
   * Session-aware conditional writes. Every couple-setup transaction writes the couple
   * document, so concurrent transactions on one couple conflict and are serialised by
   * MongoDB; the `status: 'pending'` filter re-checks the state atomically. Issue,
   * regenerate and cancel write it first; join deliberately redeems the invite first (see
   * CoupleSetupService.join). Each returns false when the couple is not pending (or, where
   * a creator is given, not created by them).
   */

  /**
   * Claims the pending couple for this transaction without changing its fields. Mongoose
   * timestamps turn the empty `$set` into `$set.updatedAt`, so this is a real write (see
   * `update` above) – keep it non-empty if timestamps are ever disabled. `creatorId` is
   * defence in depth behind requireCreator: a non-creator never matches.
   */
  async lockPending(
    id: Types.ObjectId,
    creatorId: Types.ObjectId,
    session: ClientSession,
  ): Promise<boolean> {
    const result = await this.couples.updateOne(
      { _id: id, status: 'pending', createdByUserId: creatorId },
      { $set: {} },
      { session },
    );
    return result.matchedCount === 1;
  }

  /** pending → active; the partner placeholder name is dropped (the partner has their own). */
  async activatePending(id: Types.ObjectId, session: ClientSession): Promise<boolean> {
    const result = await this.couples.updateOne(
      { _id: id, status: 'pending' },
      { $set: { status: 'active' }, $unset: { pendingPartnerName: 1 } },
      { session },
    );
    return result.matchedCount === 1;
  }

  /** pending → cancelled, by its creator only. The record is kept; nothing is deleted. */
  async cancelPending(
    id: Types.ObjectId,
    creatorId: Types.ObjectId,
    session: ClientSession,
  ): Promise<boolean> {
    const result = await this.couples.updateOne(
      { _id: id, status: 'pending', createdByUserId: creatorId },
      { $set: { status: 'cancelled' } },
      { session },
    );
    return result.matchedCount === 1;
  }

  private async toDetail(couple: CoupleRecord): Promise<CoupleDto> {
    const { status } = couple;
    if (!isPublicCoupleStatus(status)) {
      // Unreachable through requireMember (a cancelled couple has no active member).
      throw coupleNotFound();
    }
    const memberships = await this.memberships.findActiveByCouple(couple._id);
    const users = await this.users.findByIds(memberships.map(membership => membership.userId));
    return toCoupleDto({ ...couple, status }, memberships, users);
  }
}
