import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types } from 'mongoose';

import { User } from '../users/user.schema.js';
import { Couple } from './couple.schema.js';

export const MEMBERSHIP_ROLES = ['creator', 'partner'] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

/**
 * `active`: the user is in this (pending or connected) couple.
 * `left`: the membership ended (today only by cancelling a pending couple). Both unique
 * indexes below are partial on `active`, so ended memberships stop counting automatically.
 */
export const MEMBERSHIP_STATUSES = ['active', 'left'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

/** A user's place in a couple. `createdAt` is when they joined. */
@Schema({ collection: 'couple_memberships', timestamps: true })
export class CoupleMembership {
  @Prop({ type: Types.ObjectId, ref: Couple.name, required: true, immutable: true })
  coupleId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: User.name, required: true, immutable: true })
  userId: Types.ObjectId;

  @Prop({ type: String, enum: MEMBERSHIP_ROLES, required: true, immutable: true })
  role: MembershipRole;

  @Prop({ type: String, enum: MEMBERSHIP_STATUSES, required: true, default: 'active' })
  status: MembershipStatus;

  createdAt: Date;
  updatedAt: Date;
}

export type CoupleMembershipRecord = CoupleMembership & { _id: Types.ObjectId };

export const CoupleMembershipSchema = SchemaFactory.createForClass(CoupleMembership);

const ACTIVE_ONLY = { partialFilterExpression: { status: 'active' } };

/**
 * One active (pending or connected) couple per user – enforced by MongoDB, not just by
 * application checks. Also the "which couple is this user in" lookup.
 */
CoupleMembershipSchema.index({ userId: 1 }, { unique: true, ...ACTIVE_ONLY });

/**
 * At most one active creator and one active partner per couple, i.e. never more than two
 * members. Also serves "members of this couple" lookups (coupleId prefix).
 */
CoupleMembershipSchema.index({ coupleId: 1, role: 1 }, { unique: true, ...ACTIVE_ONLY });
