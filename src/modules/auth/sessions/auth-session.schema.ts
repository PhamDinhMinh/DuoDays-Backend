import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types } from 'mongoose';

import { User } from '../../users/user.schema.js';

export type SessionRevokedReason = 'logout' | 'reuse';

/**
 * One signed-in device. Holds hashes of the current and the immediately previous refresh
 * secret – never a raw refresh token, never an access token.
 */
@Schema({ collection: 'auth_sessions', timestamps: true })
export class AuthSession {
  /** `ses_…` – embedded in the refresh token and the access token's `sid` claim. */
  @Prop({ required: true, immutable: true })
  publicId: string;

  @Prop({ type: Types.ObjectId, ref: User.name, required: true, immutable: true })
  userId: Types.ObjectId;

  /** HMAC of the current refresh secret. */
  @Prop({ required: true })
  tokenHash: string;

  /** HMAC of the secret this session was rotated away from (one generation only). */
  @Prop()
  previousTokenHash?: string;

  @Prop({ required: true, default: 0 })
  generation: number;

  @Prop()
  lastRotatedAt?: Date;

  /** Idle expiry; moves forward on rotation, never past `absoluteExpiresAt`. */
  @Prop({ required: true })
  expiresAt: Date;

  /** Hard limit from sign-in; never extended. */
  @Prop({ required: true, immutable: true })
  absoluteExpiresAt: Date;

  @Prop({ type: Date, default: null })
  revokedAt: Date | null;

  @Prop({ type: String, enum: ['logout', 'reuse'] })
  revokedReason?: SessionRevokedReason;

  /** The TTL index deletes the document at this time (expiry/revocation + retention). */
  @Prop({ required: true })
  purgeAt: Date;

  createdAt: Date;
  updatedAt: Date;
}

export type AuthSessionRecord = AuthSession & { _id: Types.ObjectId };

export const AuthSessionSchema = SchemaFactory.createForClass(AuthSession);

AuthSessionSchema.index({ publicId: 1 }, { unique: true });
AuthSessionSchema.index({ userId: 1 });
AuthSessionSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });
