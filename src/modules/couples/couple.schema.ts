import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types } from 'mongoose';

import { User } from '../users/user.schema.js';

import type { CalendarDate } from '../../common/dates/calendar-date.js';

export const COUPLE_STATUSES = ['pending', 'active', 'cancelled'] as const;
/**
 * `pending`: created, partner not joined yet.
 * `active`: both partners connected – set exclusively by the join transaction.
 * `cancelled`: the creator gave up a pending couple (internal only: its membership ended
 * in the same transaction, so no API response ever shows this status).
 */
export type CoupleStatus = (typeof COUPLE_STATUSES)[number];

/** Statuses the API can return – a cancelled couple is never visible to anyone. */
export const PUBLIC_COUPLE_STATUSES = ['pending', 'active'] as const;
export type PublicCoupleStatus = (typeof PUBLIC_COUPLE_STATUSES)[number];

export function isPublicCoupleStatus(status: CoupleStatus): status is PublicCoupleStatus {
  return status !== 'cancelled';
}

@Schema({ collection: 'couples', timestamps: true })
export class Couple {
  /** `cpl_…` – the only couple identifier the API exposes. */
  @Prop({ required: true, immutable: true })
  publicId: string;

  @Prop({ type: String, enum: COUPLE_STATUSES, required: true })
  status: CoupleStatus;

  @Prop({ type: Types.ObjectId, ref: User.name, required: true, immutable: true })
  createdByUserId: Types.ObjectId;

  /**
   * Relationship start (Day 1) as a `YYYY-MM-DD` string – deliberately NOT a Date, so no
   * timezone can shift it. See common/dates/calendar-date.ts.
   */
  @Prop({ type: String, required: true })
  startDate: CalendarDate;

  /** The creator's name for their partner; only while pending (cleared on join). */
  @Prop({ type: String })
  pendingPartnerName?: string;

  createdAt: Date;
  updatedAt: Date;
}

export type CoupleRecord = Couple & { _id: Types.ObjectId };

export const CoupleSchema = SchemaFactory.createForClass(Couple);

CoupleSchema.index({ publicId: 1 }, { unique: true });
