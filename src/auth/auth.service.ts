import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import type { User } from '../users/user.interface';
import { UsersService } from '../users/users.service';
import { RegisterDto } from './dto/register.dto';
import { PasswordHasherService } from './password-hasher.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly passwordHasher: PasswordHasherService,
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
}
