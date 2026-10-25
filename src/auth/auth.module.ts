import 'dotenv/config';
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { UsersModule } from '../users/users.module';
import { ACCESS_TOKEN_TTL_SECONDS } from './auth.constants';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordHasherService } from './password-hasher.service';
import { JwtAuthGuard } from './jwt-auth.guard';

@Module({
  imports: [
    UsersModule,
    JwtModule.registerAsync({
      useFactory: () => {
        const secret = process.env.JWT_SECRET;

        if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
          throw new Error('JWT_SECRET must contain at least 32 bytes');
        }

        return {
          secret,
          signOptions: {
            algorithm: 'HS256',
            expiresIn: ACCESS_TOKEN_TTL_SECONDS,
            issuer: 'nest-learning',
            audience: 'nest-learning-api',
          },
          verifyOptions: {
            algorithms: ['HS256'],
            issuer: 'nest-learning',
            audience: 'nest-learning-api',
          },
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, PasswordHasherService, JwtAuthGuard],
})
export class AuthModule {}
