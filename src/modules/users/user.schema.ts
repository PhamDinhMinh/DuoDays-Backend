import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

import type { HydratedDocument, Types } from 'mongoose';

@Schema({ collection: 'users', timestamps: true })
export class User {
  /** `usr_…` – the only user identifier the API exposes. */
  @Prop({ required: true, immutable: true })
  publicId: string;

  /** As entered (trimmed, case kept) – for display and future contact. */
  @Prop({ required: true })
  email: string;

  /** `email.trim().toLowerCase()` – uniqueness and login lookup. */
  @Prop({ required: true })
  emailNormalized: string;

  @Prop({ required: true })
  displayName: string;

  /**
   * Argon2id encoded hash (algorithm, parameters and salt included). Absent for accounts
   * without a password (future social sign-in). Never selected unless asked for.
   */
  @Prop({ select: false })
  passwordHash?: string;

  createdAt: Date;
  updatedAt: Date;
}

export type UserRecord = User & { _id: Types.ObjectId };
export type UserDocument = HydratedDocument<User>;

export const UserSchema = SchemaFactory.createForClass(User);

UserSchema.index({ publicId: 1 }, { unique: true });
UserSchema.index(
  { emailNormalized: 1 },
  { unique: true, partialFilterExpression: { emailNormalized: { $type: 'string' } } },
);
