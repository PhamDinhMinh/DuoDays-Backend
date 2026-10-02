import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types } from 'mongoose';

import { User } from '../users/user.schema.js';
import { Couple } from './couple.schema.js';

/**
 * Persisted invite states. Expiry is NOT a stored state – it is derived from `expiresAt`:
 *
 *   active ──join──────────────────────────────────→ redeemed  (terminal)
 *   active ──regenerate / reissue / cancel couple──→ revoked   (terminal)
 *
 * Usable ⇔ `status === 'active' && now < expiresAt` (server clock).
 */
export const INVITE_STATUSES = ['active', 'redeemed', 'revoked'] as const;
export type InviteStatus = (typeof INVITE_STATUSES)[number];

/**
 * A code the creator shares so their partner can join a pending couple. Never exposed by
 * id; the API addresses invites by couple (creator) or by code (partner).
 */
@Schema({ collection: 'couple_invites', timestamps: true })
export class CoupleInvite {
  @Prop({ type: Types.ObjectId, ref: Couple.name, required: true, immutable: true })
  coupleId: Types.ObjectId;

  /** 6 digits, generated server-side. A secret: never logged, never in a URL. */
  @Prop({ type: String, required: true, immutable: true })
  code: string;

  @Prop({ type: String, enum: INVITE_STATUSES, required: true, default: 'active' })
  status: InviteStatus;

  /** Business expiry. Correctness never depends on the TTL index below. */
  @Prop({ type: Date, required: true, immutable: true })
  expiresAt: Date;

  /** Who joined with it – lets a retried join be recognised as the same success. */
  @Prop({ type: Types.ObjectId, ref: User.name })
  redeemedByUserId?: Types.ObjectId;

  /** Server time of the active → redeemed transition (set in the join transaction). */
  @Prop({ type: Date })
  redeemedAt?: Date;

  /**
   * Cleanup only: the TTL index deletes the document at this time. Always later than
   * `expiresAt` (active) or the terminal transition (redeemed/revoked), plus retention.
   */
  @Prop({ type: Date, required: true })
  purgeAt: Date;

  createdAt: Date;
  updatedAt: Date;
}

export type CoupleInviteRecord = CoupleInvite & { _id: Types.ObjectId };

export const CoupleInviteSchema = SchemaFactory.createForClass(CoupleInvite);

/**
 * One document per code until it is purged – including redeemed/revoked ones – so a stale
 * code can never point at another couple's newer invite. Invariant-critical.
 */
CoupleInviteSchema.index({ code: 1 }, { unique: true });

/** At most one active invite per couple. Also the "current invite" lookup. Invariant-critical. */
CoupleInviteSchema.index(
  { coupleId: 1 },
  { unique: true, partialFilterExpression: { status: 'active' } },
);

CoupleInviteSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });
