import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { UsersModule } from '../users/users.module.js';
import { CoupleAccessService } from './couple-access.service.js';
import { Couple, CoupleSchema } from './couple.schema.js';
import { CoupleMembership, CoupleMembershipSchema } from './couple-membership.schema.js';
import { CoupleMembershipsService } from './couple-memberships.service.js';
import { CouplesController } from './couples.controller.js';
import { CouplesService } from './couples.service.js';

@Module({
  imports: [
    UsersModule,
    MongooseModule.forFeature([
      { name: Couple.name, schema: CoupleSchema },
      { name: CoupleMembership.name, schema: CoupleMembershipSchema },
    ]),
  ],
  controllers: [CouplesController],
  providers: [CouplesService, CoupleMembershipsService, CoupleAccessService],
  // Reused by AuthModule (/auth/me bootstrap) and, in Phase 3, the invite/join module.
  exports: [CouplesService, CoupleMembershipsService, CoupleAccessService],
})
export class CouplesModule {}
