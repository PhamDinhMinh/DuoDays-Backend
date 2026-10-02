import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import mongoose from 'mongoose';

import { createPublicId } from '../../common/ids/public-id.js';
import { normalizeEmail } from './email.js';
import { User } from './user.schema.js';

import type { ClientSession, Model, Types } from 'mongoose';
import type { UserRecord } from './user.schema.js';

export interface NewPasswordUser {
  email: string;
  displayName: string;
  passwordHash: string;
}

@Injectable()
export class UsersService {
  constructor(@InjectModel(User.name) private readonly users: Model<User>) {}

  /** Throws a Mongo duplicate-key error if the normalized email is taken (index-enforced). */
  async createWithPassword(input: NewPasswordUser, session?: ClientSession): Promise<UserRecord> {
    const [created] = await this.users.create(
      [
        {
          publicId: createPublicId('usr'),
          email: input.email,
          emailNormalized: normalizeEmail(input.email),
          displayName: input.displayName,
          passwordHash: input.passwordHash,
        },
      ],
      { session },
    );
    const { passwordHash: _omit, ...user } = created.toObject<UserRecord>();
    return user;
  }

  async existsByEmail(email: string): Promise<boolean> {
    return (await this.users.exists({ emailNormalized: normalizeEmail(email) })) !== null;
  }

  /** The only read that includes the password hash. */
  findForLogin(email: string): Promise<UserRecord | null> {
    return this.users
      .findOne({ emailNormalized: normalizeEmail(email) })
      .select('+passwordHash')
      .lean<UserRecord>()
      .exec();
  }

  findById(id: Types.ObjectId): Promise<UserRecord | null> {
    return this.users.findById(id).lean<UserRecord>().exec();
  }

  findByIds(ids: Types.ObjectId[]): Promise<UserRecord[]> {
    return this.users
      .find({ _id: mongoose.trusted({ $in: ids }) })
      .lean<UserRecord[]>()
      .exec();
  }

  findByPublicId(publicId: string): Promise<UserRecord | null> {
    return this.users.findOne({ publicId }).lean<UserRecord>().exec();
  }

  /** Renames the user; pass `session` to take part in a transaction. */
  async updateDisplayName(
    id: Types.ObjectId,
    displayName: string,
    session?: ClientSession,
  ): Promise<void> {
    await this.users.updateOne({ _id: id }, { $set: { displayName } }, { session }).exec();
  }

  async updatePasswordHash(id: Types.ObjectId, passwordHash: string): Promise<void> {
    await this.users.updateOne({ _id: id }, { $set: { passwordHash } }).exec();
  }
}
