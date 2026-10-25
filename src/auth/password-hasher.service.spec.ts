import { scrypt } from 'node:crypto';
import { PasswordHasherService } from './password-hasher.service';

describe('PasswordHasherService', () => {
  it('accepts the correct password and rejects an incorrect one', async () => {
    const hasher = new PasswordHasherService();
    const hash = await hasher.hash('a-long-test-password');

    expect(await hasher.verify('a-long-test-password', hash)).toBe(true);
    expect(await hasher.verify('wrong-password', hash)).toBe(false);
  });

  it.each([null, 'invalid-hash', 'scrypt$999999999$8$1$bad$bad'])(
    'rejects missing or unsupported hashes: %j',
    async (hash) => {
      const hasher = new PasswordHasherService();
      expect(await hasher.verify('a-long-test-password', hash)).toBe(false);
    },
  );

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
