import { scrypt } from 'node:crypto';
import { PasswordHasherService } from './password-hasher.service';

describe('PasswordHasherService', () => {
  it('uses a random salt and stores a verifiable scrypt hash', async () => {
    const hasher = new PasswordHasherService();
    const password = ' A long password with spaces ';
    const first = await hasher.hash(password);
    const second = await hasher.hash(password);

    expect(first).not.toBe(second);
    expect(first).toMatch(
      /^scrypt\$131072\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{128}$/,
    );

    const [, cost, blockSize, parallelization, salt, expectedKey] =
      first.split('$');
    const key = await new Promise<Buffer>((resolve, reject) => {
      scrypt(
        password,
        Buffer.from(salt, 'hex'),
        64,
        {
          N: Number(cost),
          r: Number(blockSize),
          p: Number(parallelization),
          maxmem: 256 * 1024 * 1024,
        },
        (error, derivedKey) => {
          if (error) reject(error);
          else resolve(derivedKey);
        },
      );
    });

    expect(key.toString('hex')).toBe(expectedKey);
  });
});
