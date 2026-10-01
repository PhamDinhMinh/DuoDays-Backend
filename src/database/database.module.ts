import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import mongoose from 'mongoose';

import { AppConfigService } from '../config/app-config.service.js';
import { TransactionService } from './transaction.service.js';

// Wrap any `$`-prefixed key in user-supplied filters in `$eq`, so request input can never
// smuggle query operators (`{ "email": { "$ne": null } }`).
mongoose.set('sanitizeFilter', true);
mongoose.set('strictQuery', true);

@Global()
@Module({
  imports: [
    MongooseModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        uri: config.mongo.uri,
        dbName: config.mongo.dbName,
        appName: 'duodays-backend',
        // Indexes are built by an explicit sync step on deploy, never implicitly in prod.
        autoIndex: !config.app.isProduction,
        serverSelectionTimeoutMS: 10_000,
        retryAttempts: config.app.isTest ? 0 : 3,
        retryDelay: 2_000,
      }),
    }),
  ],
  providers: [TransactionService],
  exports: [TransactionService],
})
export class DatabaseModule {}
