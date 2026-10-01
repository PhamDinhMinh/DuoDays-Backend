import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';

import type { ClientSession, Connection } from 'mongoose';

/**
 * Runs multi-document work atomically. Built on Mongoose `connection.transaction()`, which
 * wraps the driver's `withTransaction`: the whole callback is retried on
 * TransientTransactionError (e.g. a write conflict with a concurrent transaction) and on
 * UnknownTransactionCommitResult, and Mongoose resets document state between attempts.
 *
 * Rules for callers:
 * - Pass `session` to every read and write inside the callback.
 * - The callback may run more than once – no side effects outside MongoDB in it
 *   (no HTTP calls, no events, no logging of "done").
 * - Throwing aborts the transaction and rethrows the error unchanged.
 */
@Injectable()
export class TransactionService {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  run<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
    return this.connection.transaction(work, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
    });
  }
}
