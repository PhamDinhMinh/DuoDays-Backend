import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { isPublicId } from '../../../common/ids/public-id.js';
import { AppConfigService } from '../../../config/app-config.service.js';

import type { AuthContext } from '../auth-context.js';

export const ACCESS_TOKEN_ALGORITHM = 'HS256';

/** Exactly what the token carries: who (`sub`), which device session (`sid`) – nothing else. */
interface AccessTokenClaims {
  sub: string;
  sid: string;
}

export interface SignedAccessToken {
  token: string;
  expiresIn: number;
}

/** Stateless: access tokens are never stored and verification never hits the database. */
@Injectable()
export class AccessTokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: AppConfigService,
  ) {}

  async sign(auth: AuthContext): Promise<SignedAccessToken> {
    const { accessTokenTtlSeconds, issuer, audience } = this.config.auth;
    const token = await this.jwt.signAsync(
      { sid: auth.sessionId },
      {
        subject: auth.userId,
        algorithm: ACCESS_TOKEN_ALGORITHM,
        expiresIn: accessTokenTtlSeconds,
        issuer,
        audience,
      },
    );
    return { token, expiresIn: accessTokenTtlSeconds };
  }

  /** Null for any token that is malformed, forged, expired or minted for someone else. */
  async verify(token: string): Promise<AuthContext | null> {
    const { issuer, audience } = this.config.auth;
    let claims: Partial<AccessTokenClaims>;
    try {
      claims = await this.jwt.verifyAsync<AccessTokenClaims>(token, {
        algorithms: [ACCESS_TOKEN_ALGORITHM],
        issuer,
        audience,
      });
    } catch {
      return null;
    }
    if (!isPublicId(claims.sub, 'usr') || !isPublicId(claims.sid, 'ses')) {
      return null;
    }
    return { userId: claims.sub, sessionId: claims.sid };
  }
}
