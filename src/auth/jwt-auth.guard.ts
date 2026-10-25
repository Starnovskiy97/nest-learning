import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import type { User } from '../users/user.interface';
import { UsersService } from '../users/users.service';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly usersService: UsersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: User }>();
    const token = /^Bearer (\S+)$/i.exec(
      request.get('Authorization') ?? '',
    )?.[1];

    if (!token) {
      throw new UnauthorizedException('Invalid or expired access token');
    }

    let payload: Record<string, unknown>;
    try {
      payload =
        await this.jwtService.verifyAsync<Record<string, unknown>>(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }

    if (
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      typeof payload.sub !== 'number' ||
      !Number.isInteger(payload.sub) ||
      payload.sub < 1 ||
      payload.sub > 2147483647 ||
      typeof payload.exp !== 'number'
    ) {
      throw new UnauthorizedException('Invalid or expired access token');
    }

    try {
      request.user = await this.usersService.findOne(payload.sub);
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw new UnauthorizedException('Invalid or expired access token');
      }

      throw error;
    }

    return true;
  }
}
