import { HttpStatus, Injectable, Logger } from '@nestjs/common';

import { AppException } from '../../common/errors/app.exception.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { TransactionService } from '../../database/transaction.service.js';
import { UsersService } from '../users/users.service.js';
import { CoupleAccessService } from './couple-access.service.js';
import {
  CoupleInvitesService,
  isInviteCodeTakenError,
  isUsableInvite,
} from './couple-invites.service.js';
import {
  CoupleMembershipsService,
  isCoupleRoleTakenError,
  isUserAlreadyInCoupleError,
} from './couple-memberships.service.js';
import { INVITE_CODE_ATTEMPTS } from './couples.constants.js';
import { CouplesService, coupleNotPending } from './couples.service.js';
import { toInviteDto } from './dto/invite.dto.js';
import { InviteCodeGenerator } from './invite-code.generator.js';

import type { Types } from 'mongoose';
import type { AuthContext } from '../auth/auth-context.js';
import type { UserRecord } from '../users/user.schema.js';
import type { CoupleAccess } from './couple-access.service.js';
import type { CoupleInviteRecord } from './couple-invite.schema.js';
import type { CoupleDto } from './dto/couple.dto.js';
import type { InviteDto, InvitePreviewDto } from './dto/invite.dto.js';

/** Why a code cannot be used – logged as the outcome (the code itself never is). */
type CodeOutcome = 'not_found' | 'expired' | 'revoked' | 'redeemed' | 'already_in_couple';

const alreadyInCouple = () =>
  new AppException(
    ErrorCode.ALREADY_IN_COUPLE,
    HttpStatus.CONFLICT,
    'You are already part of a couple.',
  );

const coupleNotFound = () =>
  new AppException(ErrorCode.COUPLE_NOT_FOUND, HttpStatus.NOT_FOUND, 'Couple not found.');

const CODE_ERRORS: Record<CodeOutcome, () => AppException> = {
  not_found: () =>
    new AppException(ErrorCode.INVITE_NOT_FOUND, HttpStatus.NOT_FOUND, 'Invite code not found.'),
  // INVITE_EXPIRED deliberately covers both: past `expiresAt`, and revoked (replaced by a
  // newer code or the couple was cancelled). Either way the partner needs a new code.
  expired: () =>
    new AppException(
      ErrorCode.INVITE_EXPIRED,
      HttpStatus.GONE,
      'This invite code is no longer usable (expired or replaced).',
    ),
  revoked: () => CODE_ERRORS.expired(),
  redeemed: () =>
    new AppException(
      ErrorCode.INVITE_ALREADY_REDEEMED,
      HttpStatus.CONFLICT,
      'This invite code has already been used.',
    ),
  already_in_couple: alreadyInCouple,
};

/** The join's compare-and-swap lost (invite redeemed/revoked/expired meanwhile). */
class InviteNoLongerUsable extends Error {}

type JoinResolution =
  | { kind: 'joinable'; invite: CoupleInviteRecord }
  | { kind: 'alreadyJoined'; coupleId: Types.ObjectId };

/**
 * Couple Setup after creation: the creator's invite (issue / regenerate), cancelling a
 * pending couple, and the partner's lookup and join.
 *
 * Every write path is a transaction that writes the couple document with a
 * `status: 'pending'` filter, so concurrent setup operations on one couple conflict, are
 * serialised by MongoDB (the loser's transaction is retried against the committed state)
 * and re-check the state atomically. Issue/regenerate and cancel write the couple first
 * (lockPending / cancelPending). Join is the deliberate exception: see `join`. Logs carry
 * public ids and outcome categories only – never invite codes or names.
 */
@Injectable()
export class CoupleSetupService {
  private readonly logger = new Logger('CoupleSetup');

  constructor(
    private readonly access: CoupleAccessService,
    private readonly couples: CouplesService,
    private readonly memberships: CoupleMembershipsService,
    private readonly invites: CoupleInvitesService,
    private readonly users: UsersService,
    private readonly transactions: TransactionService,
    private readonly codes: InviteCodeGenerator,
    private readonly config: AppConfigService,
  ) {}

  /**
   * The creator's usable invite: the current one if it is still usable (no write), else a
   * fresh one (an expired one is revoked). Concurrent calls return the same code.
   */
  async ensureInvite(auth: AuthContext, couplePublicId: string): Promise<InviteDto> {
    const access = await this.requirePendingCreator(auth, couplePublicId);
    const current = await this.invites.findActiveByCouple(access.couple._id);
    if (current && isUsableInvite(current, Date.now())) {
      return toInviteDto(current);
    }
    return this.issue(access, 'ensure');
  }

  /** Always a new code; the previous one (usable or not) stops working at commit. */
  async regenerateInvite(auth: AuthContext, couplePublicId: string): Promise<InviteDto> {
    const access = await this.requirePendingCreator(auth, couplePublicId);
    return this.issue(access, 'regenerate');
  }

  /**
   * Gives up a pending couple: couple → cancelled, creator membership → left, active
   * invite → revoked, all at once. Nothing is deleted; the user can create or join
   * another couple straight away.
   */
  async cancel(auth: AuthContext, couplePublicId: string): Promise<void> {
    const { caller, couple } = await this.requirePendingCreator(auth, couplePublicId);
    await this.transactions.run(async session => {
      if (!(await this.couples.cancelPending(couple._id, caller._id, session))) {
        throw coupleNotPending();
      }
      const ended = await this.memberships.end(
        { coupleId: couple._id, userId: caller._id, role: 'creator' },
        session,
      );
      if (!ended) {
        throw coupleNotFound();
      }
      await this.invites.revokeActiveByCouple(couple._id, new Date(), session);
    });
    this.logger.log({ coupleId: couple.publicId, userId: caller.publicId }, 'couple.cancelled');
  }

  /**
   * The partner's preview of a code. A caller who is already in a couple (including the
   * creator typing their own code) is refused before the code is even looked at.
   */
  async lookup(auth: AuthContext, code: string): Promise<InvitePreviewDto> {
    const caller = await this.access.requireCaller(auth);
    if (await this.memberships.findActiveByUser(caller._id)) {
      throw this.codeRejected(caller, 'invite.lookup', 'already_in_couple');
    }
    const invite = this.requireUsable(caller, 'invite.lookup', await this.invites.findByCode(code));

    // An active invite always belongs to a pending couple (join and cancel change both in
    // one transaction); anything else is treated as no longer usable.
    const couple = await this.couples.findById(invite.coupleId);
    const owner =
      couple?.status === 'pending' ? await this.users.findById(couple.createdByUserId) : null;
    if (!owner) {
      throw this.codeRejected(caller, 'invite.lookup', 'expired');
    }
    this.logger.log({ userId: caller.publicId, outcome: 'found' }, 'invite.lookup');
    return { ownerName: owner.displayName };
  }

  /**
   * Redeems the invite, activates the couple and adds the caller as partner – all or
   * nothing. Repeating a join that already succeeded returns the same couple (200) while
   * the redeemed invite is retained (INVITE_RETENTION_MS after redemption; once it is
   * purged the partner gets ALREADY_IN_COUPLE instead); every other caller of a used code
   * gets INVITE_ALREADY_REDEEMED.
   *
   * Write order is intentional and differs from the other setup transactions: the invite
   * redemption is the first gate, the couple write second. A join that loses to a
   * concurrent join, regenerate or cancel therefore fails on the invite and can answer
   * with the precise invite error (already redeemed / no longer usable) rather than a
   * generic COUPLE_NOT_PENDING. This is still race-safe: every competing transaction
   * writes the invite and/or the couple document, so MongoDB reports a write conflict to
   * the later writer, whose transaction is retried against the committed state.
   */
  async join(auth: AuthContext, code: string): Promise<CoupleDto> {
    const caller = await this.access.requireCaller(auth);
    const resolved = await this.resolveJoin(caller, code);
    if (resolved.kind === 'alreadyJoined') {
      return this.joinedCouple(caller, resolved.coupleId, 'couple.join_replayed');
    }
    const { invite } = resolved;

    try {
      await this.transactions.run(async session => {
        // Recomputed per attempt: the callback may be retried after a transient error.
        const now = new Date();
        // The first gate (see above): of concurrent joins on one invite exactly one matches,
        // and an invite revoked by a concurrent regenerate/cancel no longer does.
        if (!(await this.invites.redeem(invite._id, caller._id, now, session))) {
          throw new InviteNoLongerUsable();
        }
        if (!(await this.couples.activatePending(invite.coupleId, session))) {
          throw coupleNotPending();
        }
        // The partial unique indexes are the real guarantees: one active couple per user,
        // one partner per couple.
        await this.memberships.create(
          { coupleId: invite.coupleId, userId: caller._id, role: 'partner' },
          session,
        );
      });
    } catch (error) {
      if (error instanceof InviteNoLongerUsable) {
        // Someone (possibly this same user, in a parallel request) got there first.
        const again = await this.resolveJoin(caller, code);
        if (again.kind === 'alreadyJoined') {
          return this.joinedCouple(caller, again.coupleId, 'couple.join_replayed');
        }
        throw this.codeRejected(caller, 'invite.join_rejected', 'expired');
      }
      if (isUserAlreadyInCoupleError(error)) {
        throw this.codeRejected(caller, 'invite.join_rejected', 'already_in_couple');
      }
      if (isCoupleRoleTakenError(error)) {
        throw this.codeRejected(caller, 'invite.join_rejected', 'redeemed');
      }
      throw error;
    }

    return this.joinedCouple(caller, invite.coupleId, 'couple.joined');
  }

  private async requirePendingCreator(
    auth: AuthContext,
    couplePublicId: string,
  ): Promise<CoupleAccess> {
    const access = await this.access.requireMember(auth, couplePublicId);
    if (access.couple.status !== 'pending') {
      throw coupleNotPending();
    }
    this.access.requireCreator(access);
    return access;
  }

  /**
   * Issues a new invite in a transaction, retrying with a fresh code when the unique code
   * index reports a collision (a duplicate key aborts the transaction, so the retry loop
   * sits outside it). `ensure` returns an invite another request issued meanwhile instead
   * of replacing it.
   */
  private async issue(access: CoupleAccess, mode: 'ensure' | 'regenerate'): Promise<InviteDto> {
    const coupleId = access.couple._id;
    const ttlMs = this.config.couples.inviteTtlMs;

    for (let attempt = 1; attempt <= INVITE_CODE_ATTEMPTS; attempt += 1) {
      const code = this.codes.next();
      try {
        const result = await this.transactions.run(async session => {
          if (!(await this.couples.lockPending(coupleId, access.caller._id, session))) {
            throw coupleNotPending();
          }
          const now = new Date();
          const current = await this.invites.findActiveByCouple(coupleId, session);
          if (mode === 'ensure' && current && isUsableInvite(current, now.getTime())) {
            return { invite: current, reason: null };
          }
          if (current) {
            await this.invites.revokeActiveByCouple(coupleId, now, session);
          }
          const invite = await this.invites.insert(
            { coupleId, code, expiresAt: new Date(now.getTime() + ttlMs) },
            session,
          );
          const reason = mode === 'regenerate' ? 'regenerate' : current ? 'expired' : 'initial';
          return { invite, reason };
        });
        if (result.reason) {
          this.logger.log(
            {
              coupleId: access.couple.publicId,
              userId: access.caller.publicId,
              reason: result.reason,
            },
            'invite.issued',
          );
        }
        return toInviteDto(result.invite);
      } catch (error) {
        if (!isInviteCodeTakenError(error)) {
          throw error;
        }
        // The error object contains the code: log the attempt number only.
        this.logger.warn({ coupleId: access.couple.publicId, attempt }, 'invite.code_collision');
      }
    }
    this.logger.error({ coupleId: access.couple.publicId }, 'invite.code_exhausted');
    // No cause attached: the last duplicate-key error carries a code.
    throw new AppException(
      ErrorCode.SERVICE_UNAVAILABLE,
      HttpStatus.SERVICE_UNAVAILABLE,
      'Could not issue an invite code. Try again.',
    );
  }

  /**
   * Pre-check (and post-race re-check) for join. Throws the public error for an unusable
   * code; a caller already in a couple only learns more when it is their own earlier join.
   */
  private async resolveJoin(caller: UserRecord, code: string): Promise<JoinResolution> {
    const [membership, invite] = await Promise.all([
      this.memberships.findActiveByUser(caller._id),
      this.invites.findByCode(code),
    ]);
    if (membership) {
      const isOwnEarlierJoin =
        invite?.status === 'redeemed' &&
        invite.redeemedByUserId?.equals(caller._id) === true &&
        membership.role === 'partner' &&
        membership.coupleId.equals(invite.coupleId);
      if (isOwnEarlierJoin) {
        return { kind: 'alreadyJoined', coupleId: invite.coupleId };
      }
      throw this.codeRejected(caller, 'invite.join_rejected', 'already_in_couple');
    }
    return { kind: 'joinable', invite: this.requireUsable(caller, 'invite.join_rejected', invite) };
  }

  private requireUsable(
    caller: UserRecord,
    event: string,
    invite: CoupleInviteRecord | null,
  ): CoupleInviteRecord {
    if (!invite) {
      throw this.codeRejected(caller, event, 'not_found');
    }
    if (invite.status === 'redeemed') {
      throw this.codeRejected(caller, event, 'redeemed');
    }
    if (invite.status === 'revoked') {
      throw this.codeRejected(caller, event, 'revoked');
    }
    if (!isUsableInvite(invite, Date.now())) {
      throw this.codeRejected(caller, event, 'expired');
    }
    return invite;
  }

  private codeRejected(caller: UserRecord, event: string, outcome: CodeOutcome): AppException {
    this.logger.log({ userId: caller.publicId, outcome }, event);
    return CODE_ERRORS[outcome]();
  }

  private async joinedCouple(
    caller: UserRecord,
    coupleId: Types.ObjectId,
    event: 'couple.joined' | 'couple.join_replayed',
  ): Promise<CoupleDto> {
    const couple = await this.couples.getDetailById(coupleId);
    this.logger.log({ coupleId: couple.id, userId: caller.publicId }, event);
    return couple;
  }
}
