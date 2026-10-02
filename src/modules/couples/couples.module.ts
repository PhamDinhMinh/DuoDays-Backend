import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { UsersModule } from '../users/users.module.js';
import { CoupleAccessService } from './couple-access.service.js';
import { CoupleInvite, CoupleInviteSchema } from './couple-invite.schema.js';
import { CoupleInvitesService } from './couple-invites.service.js';
import { Couple, CoupleSchema } from './couple.schema.js';
import { CoupleMembership, CoupleMembershipSchema } from './couple-membership.schema.js';
import { CoupleMembershipsService } from './couple-memberships.service.js';
import { CoupleSetupService } from './couple-setup.service.js';
import { CouplesController } from './couples.controller.js';
import { CouplesService } from './couples.service.js';
import { InviteCodeGenerator } from './invite-code.generator.js';
import { InvitesController } from './invites.controller.js';

@Module({
  imports: [
    UsersModule,
    MongooseModule.forFeature([
      { name: Couple.name, schema: CoupleSchema },
      { name: CoupleMembership.name, schema: CoupleMembershipSchema },
      { name: CoupleInvite.name, schema: CoupleInviteSchema },
    ]),
  ],
  controllers: [CouplesController, InvitesController],
  providers: [
    CouplesService,
    CoupleMembershipsService,
    CoupleAccessService,
    CoupleInvitesService,
    CoupleSetupService,
    InviteCodeGenerator,
  ],
  // CouplesService is reused by AuthModule (/auth/me bootstrap).
  exports: [CouplesService, CoupleMembershipsService, CoupleAccessService],
})
export class CouplesModule {}
