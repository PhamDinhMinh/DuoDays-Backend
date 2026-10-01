import { getConnectionToken } from '@nestjs/mongoose';
import mongoose, { Schema } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { closeTestApp, createTestApp } from './support/test-app.js';

import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Connection, Model } from 'mongoose';
import type { TransactionService } from '../src/database/transaction.service.js';

interface Counter {
  key: string;
  value: number;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('database (mongodb-memory-server replica set)', () => {
  let app: NestExpressApplication;
  let connection: Connection;
  let transactions: TransactionService;
  let Counters: Model<Counter>;

  beforeAll(async () => {
    app = await createTestApp();
    connection = app.get<Connection>(getConnectionToken());
    // Resolve by class from the same (freshly imported) module graph the app uses.
    const { TransactionService } = await import('../src/database/transaction.service.js');
    transactions = app.get(TransactionService);
    Counters = connection.model<Counter>(
      'Counter',
      new Schema<Counter>({ key: { type: String, unique: true }, value: Number }),
    );
    await Counters.init();
  });

  afterAll(() => closeTestApp(app));

  beforeEach(async () => {
    await Counters.deleteMany({});
  });

  it('runs against a replica set', async () => {
    const hello = (await connection.db!.admin().command({ hello: 1 })) as { setName?: string };
    expect(hello.setName).toBeTruthy();
    expect(connection.readyState).toBe(1);
  });

  it('commits all writes when the callback resolves', async () => {
    const result = await transactions.run(async session => {
      await Counters.create([{ key: 'a', value: 1 }], { session });
      await Counters.create([{ key: 'b', value: 2 }], { session });
      return 'done';
    });
    expect(result).toBe('done');
    expect(await Counters.countDocuments()).toBe(2);
  });

  it('rolls back every write and rethrows when the callback throws', async () => {
    const failure = new Error('boom');
    await expect(
      transactions.run(async session => {
        await Counters.create([{ key: 'a', value: 1 }], { session });
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(await Counters.countDocuments()).toBe(0);
  });

  it('rolls back when a unique index rejects a later write', async () => {
    await Counters.create({ key: 'taken', value: 0 });
    await expect(
      transactions.run(async session => {
        await Counters.create([{ key: 'fresh', value: 1 }], { session });
        await Counters.create([{ key: 'taken', value: 1 }], { session });
      }),
    ).rejects.toMatchObject({ code: 11000 });
    expect(await Counters.exists({ key: 'fresh' })).toBeNull();
  });

  it('retries a transaction that hits a write conflict, so both increments land', async () => {
    await Counters.create({ key: 'shared', value: 0 });
    let secondAttempts = 0;

    const first = transactions.run(async session => {
      await Counters.updateOne({ key: 'shared' }, { $inc: { value: 1 } }, { session });
      await sleep(400); // hold the document while the second transaction collides
    });
    await sleep(100);
    const second = transactions.run(async session => {
      secondAttempts += 1;
      await Counters.updateOne({ key: 'shared' }, { $inc: { value: 1 } }, { session });
    });

    await Promise.all([first, second]);
    expect(secondAttempts).toBeGreaterThan(1);
    expect((await Counters.findOne({ key: 'shared' }).lean())?.value).toBe(2);
  });

  it('sanitizes query-operator injection in filters', async () => {
    await Counters.create({ key: 'only', value: 1 });
    const userInput = { $ne: 'nothing' } as unknown as string;
    // Through the raw driver the injected operator would match every document...
    expect(await Counters.collection.countDocuments({ key: userInput })).toBe(1);
    // ...through Mongoose it is wrapped in $eq and treated as a literal (uncastable) value.
    await expect(Counters.find({ key: userInput })).rejects.toMatchObject({ name: 'CastError' });
  });

  it('still runs operators the code marks as trusted', async () => {
    await Counters.create([
      { key: 'low', value: 1 },
      { key: 'high', value: 5 },
    ]);
    const found = await Counters.find({ value: mongoose.trusted({ $gt: 2 }) }).lean();
    expect(found.map(counter => counter.key)).toEqual(['high']);
  });
});
