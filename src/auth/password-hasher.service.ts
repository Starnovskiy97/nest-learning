import { Injectable } from '@nestjs/common';
import { randomBytes, scrypt } from 'node:crypto';

@Injectable()
export class PasswordHasherService {
  async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    const N = 131072;
    const r = 8;
    const p = 1;

    const key = await new Promise<Buffer>((resolve, reject) => {
      scrypt(
        password,
        salt,
        64,
        { N, r, p, maxmem: 256 * 1024 * 1024 },
        (error, derivedKey) => {
          if (error) reject(error);
          else resolve(derivedKey);
        },
      );
    });

    return `scrypt$${N}$${r}$${p}$${salt.toString('hex')}$${key.toString('hex')}`;
  }
}
