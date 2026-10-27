import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);

// Real Nginx, fake upstream: no NestJS, passwords, application data or database.
async function main(): Promise<void> {
  let loginRequests = 0;
  const upstream = createServer((req, res) => {
    if (/^\/auth\/login\/?(?:\?|$)/i.test(req.url ?? '')) loginRequests++;
    req.resume();
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        authorization: req.headers.authorization,
        forwardedFor: req.headers['x-forwarded-for'],
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    upstream.once('error', reject);
    upstream.listen(0, '0.0.0.0', resolve);
  });

  const name = `nest-proxy-test-${randomUUID()}`;
  let started = false;
  try {
    const address = upstream.address();
    assert(address && typeof address !== 'string');
    await exec(
      'docker',
      [
        'run',
        '--rm',
        '--detach',
        '--name',
        name,
        '--publish',
        '127.0.0.1::80',
        '--add-host',
        'host.docker.internal:host-gateway',
        '--env',
        `API_UPSTREAM=host.docker.internal:${address.port}`,
        '--env',
        'NGINX_ENVSUBST_FILTER=^API_UPSTREAM$',
        '--volume',
        `${resolve('infra/nginx/default.conf.template')}:/etc/nginx/templates/default.conf.template:ro`,
        'nginx:1.28-alpine',
      ],
      { timeout: 120000 },
    );
    started = true;
    const { stdout } = await exec('docker', ['port', name, '80/tcp']);
    const base = `http://${stdout.trim()}`;

    async function request(path: string, headers: Record<string, string> = {}) {
      return fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: '{}',
        signal: AbortSignal.timeout(5000),
      });
    }

    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const response = await request('/');
        await response.text();
        if (response.status === 200) {
          ready = true;
          break;
        }
      } catch {
        // Container startup is asynchronous.
      }
      await delay(250);
    }
    assert(ready, 'Nginx must be able to reach the mock upstream');
    await exec('docker', ['exec', name, 'nginx', '-t']);

    const statuses = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const response = await request('/auth/login');
        const body: unknown = await response.json();
        assert([200, 429].includes(response.status));
        if (response.status === 429) {
          assert.deepEqual(body, {
            statusCode: 429,
            message: 'Too many requests',
            error: 'Too Many Requests',
          });
          assert.equal(response.headers.get('cache-control'), 'no-store');
        }
        return response.status;
      }),
    );
    const forwarded = statuses.filter((status) => status === 200).length;
    assert(
      forwarded > 0 && forwarded < 20,
      'Allow a burst, then reject excess',
    );
    assert.equal(
      loginRequests,
      forwarded,
      'Rejected requests must not reach upstream',
    );

    // Case, slash, query and a spoofed IP must not create separate buckets.
    for (const path of [
      '/AUTH/LOGIN',
      '/auth/login/',
      '/auth/login?attempt=2',
    ]) {
      const response = await request(path, { 'X-Forwarded-For': randomUUID() });
      await response.text();
      assert.equal(response.status, 429, path);
    }
    assert.equal(loginRequests, forwarded);

    const response = await request('/tasks', {
      Authorization: 'Bearer proxy-test-token',
      'X-Forwarded-For': '192.0.2.123',
    });
    const body = (await response.json()) as {
      authorization: string;
      forwardedFor: string;
    };
    assert.equal(
      response.status,
      200,
      'Other routes must not use the login limit',
    );
    assert.equal(body.authorization, 'Bearer proxy-test-token');
    assert(body.forwardedFor && body.forwardedFor !== '192.0.2.123');

    // 10r/m replenishes roughly one slot every six seconds.
    await delay(6500);
    const recovered = await request('/auth/login');
    await recovered.text();
    assert.equal(
      recovered.status,
      200,
      'Requests must recover after cooling down',
    );
    assert.equal(loginRequests, forwarded + 1);
    console.log(
      `PASS: burst=${forwarded}, rejected=${20 - forwarded}; rejected requests never reached upstream.`,
    );
    console.log(
      'PASS: route variants, spoofed IP, header forwarding, other routes and recovery.',
    );
  } finally {
    try {
      if (started) await exec('docker', ['stop', name], { timeout: 15000 });
    } finally {
      upstream.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        upstream.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
