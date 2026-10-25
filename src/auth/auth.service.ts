import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '../generated/prisma/client';
import type { User } from '../users/user.interface';
import { UsersService } from '../users/users.service';
import { ACCESS_TOKEN_TTL_SECONDS } from './auth.constants';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import type { LoginResponse } from './login-response.interface';
import { PasswordHasherService } from './password-hasher.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly passwordHasher: PasswordHasherService,
    private readonly jwtService: JwtService,
  ) {}

  async register(registerDto: RegisterDto): Promise<User> {
    const passwordHash = await this.passwordHasher.hash(registerDto.password);

    try {
      return await this.usersService.createRegistered({
        name: registerDto.name,
        email: registerDto.email,
        passwordHash,
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Email already registered');
      }

      throw error;
    }
  }

  async login(loginDto: LoginDto): Promise<LoginResponse> {
    const user = await this.usersService.findCredentialsByEmail(loginDto.email);
    const validPassword = await this.passwordHasher.verify(
      loginDto.password,
      user?.passwordHash ?? null,
    );

    if (!user || !validPassword) {
      throw new UnauthorizedException('Invalid email or password');
    }

    return {
      access_token: await this.jwtService.signAsync({ sub: user.id }),
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
    };
  }
}
