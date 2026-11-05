import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  evaluateHealth,
  Heartbeat,
  HEALTH_MAX_AGE_MS,
  type HealthStatus,
} from '../../../src/app/heartbeat.js';

const NOW = Date.parse('2026-11-05T12:00:00.000Z');

function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { status: 'ready', updatedAt: new Date(NOW).toISOString(), pid: 1234, ...overrides };
}

describe('evaluateHealth', () => {
  it('accepts a fresh ready snapshot', () => {
    expect(evaluateHealth(snapshot(), NOW)).toEqual({ ok: true });
  });

  it('accepts a snapshot that is exactly at the age limit', () => {
    const updatedAt = new Date(NOW - HEALTH_MAX_AGE_MS).toISOString();
    expect(evaluateHealth(snapshot({ updatedAt }), NOW)).toEqual({ ok: true });
  });

  it('rejects a snapshot older than the age limit', () => {
    const updatedAt = new Date(NOW - HEALTH_MAX_AGE_MS - 1).toISOString();
    expect(evaluateHealth(snapshot({ updatedAt }), NOW)).toEqual({
      ok: false,
      reason: expect.stringContaining('устарел') as unknown,
    });
  });

  it.each(['starting', 'stopping'] as const)('rejects a %s status', (status) => {
    expect(evaluateHealth(snapshot({ status }), NOW)).toEqual({
      ok: false,
      reason: expect.stringContaining(status) as unknown,
    });
  });

  it.each([
    ['a value that is not an object', null],
    ['a snapshot without a status', { updatedAt: new Date(NOW).toISOString(), pid: 1 }],
    ['an unknown status', snapshot({ status: 'exploded' })],
    ['a timestamp that is not a date', snapshot({ updatedAt: 'yesterday' })],
  ])('rejects %s', (_label, raw) => {
    expect(evaluateHealth(raw, NOW).ok).toBe(false);
  });
});

describe('Heartbeat', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'melody-health-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes the current status, creates the directory, and leaves no temporary files', async () => {
    const file = join(dir, 'nested', 'health.json');
    let status: HealthStatus = 'starting';
    const heartbeat = new Heartbeat({
      file,
      currentStatus: () => status,
      now: () => new Date(NOW),
      onError: vi.fn(),
      intervalMs: 60_000,
    });

    heartbeat.start();
    await heartbeat.flush();
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      status: 'starting',
      updatedAt: new Date(NOW).toISOString(),
      pid: process.pid,
    });

    status = 'ready';
    await heartbeat.stop('stopping');
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ status: 'stopping' });
    expect(await readdir(join(dir, 'nested'))).toEqual(['health.json']);
  });

  it('reports a failed write through onError and keeps running', async () => {
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, 'a regular file, so nothing can live under it');
    const onError = vi.fn();
    const heartbeat = new Heartbeat({
      file: join(blocker, 'health.json'),
      currentStatus: () => 'ready',
      now: () => new Date(NOW),
      onError,
      intervalMs: 60_000,
    });

    heartbeat.start();
    await heartbeat.flush();

    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    await heartbeat.stop('stopping').catch(() => undefined);
  });
});
