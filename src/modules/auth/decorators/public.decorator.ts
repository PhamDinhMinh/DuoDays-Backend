import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'auth:isPublic';

/**
 * Opts a controller or route out of the global JwtAuthGuard. Everything else requires a
 * valid access token – new routes are protected by default.
 */
export const Public = () => SetMetadata(IS_PUBLIC, true);
