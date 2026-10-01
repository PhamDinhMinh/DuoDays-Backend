import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { ApiErrorResponses } from '../../common/swagger/api-error-responses.decorator.js';
import { AUTH_THROTTLE } from './auth.constants.js';
import { AuthService } from './auth.service.js';
import { CurrentUser } from './decorators/current-user.decorator.js';
import { Public } from './decorators/public.decorator.js';
import { LoginDto, RefreshTokenDto, RegisterDto } from './dto/auth-request.dto.js';
import { AuthSessionDto, MeResponseDto, RefreshResponseDto } from './dto/auth-response.dto.js';

import type { AuthContext } from './auth-context.js';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Throttle(AUTH_THROTTLE.register)
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create an account with email and password and sign in' })
  @ApiCreatedResponse({ type: AuthSessionDto })
  @ApiErrorResponses(400, 409, 429)
  register(@Body() dto: RegisterDto): Promise<AuthSessionDto> {
    return this.auth.register(dto);
  }

  @Public()
  @Throttle(AUTH_THROTTLE.login)
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign in with email and password (starts a new device session)' })
  @ApiOkResponse({ type: AuthSessionDto })
  @ApiErrorResponses(400, 401, 429)
  login(@Body() dto: LoginDto): Promise<AuthSessionDto> {
    return this.auth.login(dto);
  }

  @Public()
  @Throttle(AUTH_THROTTLE.refresh)
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Exchange a refresh token for a new token pair (rotation)' })
  @ApiOkResponse({ type: RefreshResponseDto })
  @ApiErrorResponses(400, 401, 429)
  refresh(@Body() dto: RefreshTokenDto): Promise<RefreshResponseDto> {
    return this.auth.refresh(dto.refreshToken);
  }

  @Public()
  @Throttle(AUTH_THROTTLE.logout)
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'End the device session of this refresh token (idempotent)' })
  @ApiNoContentResponse()
  @ApiErrorResponses(400, 429)
  async logout(@Body() dto: RefreshTokenDto): Promise<void> {
    await this.auth.logout(dto.refreshToken);
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'The signed-in user' })
  @ApiOkResponse({ type: MeResponseDto })
  @ApiErrorResponses(401)
  me(@CurrentUser() auth: AuthContext): Promise<MeResponseDto> {
    return this.auth.me(auth);
  }
}
