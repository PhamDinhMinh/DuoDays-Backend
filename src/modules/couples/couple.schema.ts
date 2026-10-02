import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types } from 'mongoose';

import { User } from '../users/user.schema.js';

import type { CalendarDate } from '../../common/dates/calendar-date.js';

export const COUPLE_STATUSES = ['pending', 'active'] as const;
/**
 * `pending`: created, partner not joined yet – the only status Phase 2 ever writes.
 * `active`: both partners connected – set exclusively by the Phase 3 join transaction.
 */
export type CoupleStatus = (typeof COUPLE_STATUSES)[number];

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

  /** The creator's name for their partner; only while pending (Phase 3 clears it on join). */
  @Prop({ type: String })
  pendingPartnerName?: string;

  createdAt: Date;
  updatedAt: Date;
}

export type CoupleRecord = Couple & { _id: Types.ObjectId };

export const CoupleSchema = SchemaFactory.createForClass(Couple);

CoupleSchema.index({ publicId: 1 }, { unique: true });
