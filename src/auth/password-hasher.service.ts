import { Injectable } from '@nestjs/common';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const N = 131072;
const r = 8;
const p = 1;

@Injectable()
export class PasswordHasherService {
  async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    const key = await this.deriveKey(password, salt);

    return `scrypt$${N}$${r}$${p}$${salt.toString('hex')}$${key.toString('hex')}`;
  }

  async verify(password: string, storedHash: string | null): Promise<boolean> {
    const match =
      /^scrypt\$131072\$8\$1\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(
        storedHash ?? '',
      );

    // Still perform scrypt for an unknown user or invalid stored hash.
    const salt = match ? Buffer.from(match[1], 'hex') : Buffer.alloc(16);
    const expected = match ? Buffer.from(match[2], 'hex') : Buffer.alloc(64);
    const actual = await this.deriveKey(password, salt);
    const matches = timingSafeEqual(actual, expected);

    return match !== null && matches;
  }

  private deriveKey(password: string, salt: Buffer): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
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
  }
}
