import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';

import { AppException } from '../../common/errors/app.exception.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { isPublicId } from '../../common/ids/public-id.js';
import { UsersService } from '../users/users.service.js';
import { Couple } from './couple.schema.js';
import { CoupleMembershipsService } from './couple-memberships.service.js';

import type { Model } from 'mongoose';
import type { AuthContext } from '../auth/auth-context.js';
import type { UserRecord } from '../users/user.schema.js';
import type { CoupleRecord } from './couple.schema.js';
import type { CoupleMembershipRecord } from './couple-membership.schema.js';

export interface CoupleAccess {
  caller: UserRecord;
  couple: CoupleRecord;
  membership: CoupleMembershipRecord;
}

const coupleNotFound = () =>
  new AppException(ErrorCode.COUPLE_NOT_FOUND, HttpStatus.NOT_FOUND, 'Couple not found.');

/**
 * Couple-scoped authorization for every couple endpoint (now and in later phases).
 * Status rules (pending/active) are NOT checked here – operations enforce them in their
 * own conditional writes, which is race-safe.
 */
@Injectable()
export class CoupleAccessService {
  constructor(
    @InjectModel(Couple.name) private readonly couples: Model<Couple>,
    private readonly memberships: CoupleMembershipsService,
    private readonly users: UsersService,
  ) {}

  /** The signed-in user's record; 401 if the account no longer exists (the guard is stateless). */
  async requireCaller(auth: AuthContext): Promise<UserRecord> {
    const caller = await this.users.findByPublicId(auth.userId);
    if (!caller) {
      throw new AppException(
        ErrorCode.UNAUTHENTICATED,
        HttpStatus.UNAUTHORIZED,
        'Authentication required.',
      );
    }
    return caller;
  }

  /**
   * The caller's view of a couple they belong to. A deleted caller is always 401 (checked
   * first, whatever the id looks like). For a valid caller, unknown id, malformed id and
   * "exists but you are not a member" are the same 404, so non-members cannot discover
   * couples.
   */
  async requireMember(auth: AuthContext, couplePublicId: string): Promise<CoupleAccess> {
    const caller = await this.requireCaller(auth);
    if (!isPublicId(couplePublicId, 'cpl')) {
      throw coupleNotFound();
    }
    const [couple, membership] = await Promise.all([
      this.couples.findOne({ publicId: couplePublicId }).lean<CoupleRecord>().exec(),
      this.memberships.findActiveByUser(caller._id),
    ]);
    if (!couple || !membership?.coupleId.equals(couple._id)) {
      throw coupleNotFound();
    }
    return { caller, couple, membership };
  }

  requireCreator(access: CoupleAccess): void {
    if (access.membership.role !== 'creator') {
      throw new AppException(
        ErrorCode.FORBIDDEN,
        HttpStatus.FORBIDDEN,
        'Only the couple’s creator can do this.',
      );
    }
  }
}
