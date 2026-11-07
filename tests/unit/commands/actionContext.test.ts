import { describe, expect, it, vi } from 'vitest';
import { confirm, run, type ActionContext } from '../../../src/commands/actionContext.js';
import type { AnnounceKind } from '../../../src/discord/announcer.js';

interface Fake {
  readonly ctx: ActionContext;
  readonly reply: ReturnType<typeof vi.fn>;
  readonly publish: ReturnType<typeof vi.fn>;
  readonly requestRefresh: ReturnType<typeof vi.fn>;
}

function fake(options: { allowed?: readonly AnnounceKind[]; publishWorks?: boolean } = {}): Fake {
  const allowed = options.allowed ?? ['important', 'info'];
  const reply = vi.fn(() => Promise.resolve());
  const publish = vi.fn(() => Promise.resolve(options.publishWorks ?? true));
  const requestRefresh = vi.fn();
  const ctx = {
    guildId: 'g1',
    member: { id: '111' },
    reply,
    publish,
    services: {
      announcer: { allows: (_guild: string, kind: AnnounceKind) => allowed.includes(kind) },
      panel: { requestRefresh },
      engine: {
        snapshot: () => ({ voiceChannelId: 'vc', state: 'playing', queue: [], listeners: 1 }),
      },
      settings: { get: () => ({}) },
    },
  } as unknown as ActionContext;
  return { ctx, reply, publish, requestRefresh };
}

describe('confirm', () => {
  it('publishes a short message that names the member when announcements allow it', async () => {
    const { ctx, publish, reply } = fake();

    await confirm(ctx, 'important', '⏸ Пауза.');

    expect(publish).toHaveBeenCalledWith('⏸ Пауза. · <@111>');
    expect(reply).not.toHaveBeenCalled();
  });

  it('answers only the member when the mode hides this kind of message', async () => {
    const { ctx, publish, reply } = fake({ allowed: ['important'] });

    await confirm(ctx, 'info', '🔊 Громкость: 50 %.');

    expect(publish).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith('🔊 Громкость: 50 %.');
  });

  it('falls back to a private answer when the public message cannot be sent', async () => {
    const { ctx, reply } = fake({ publishWorks: false });

    await confirm(ctx, 'important', '⏹ Остановлено.');

    expect(reply).toHaveBeenCalledWith('⏹ Остановлено.');
  });
});

describe('run', () => {
  it('does not perform the action for a member who is not in the bot channel', async () => {
    const { ctx, publish } = fake();
    const perform = vi.fn(() => Promise.resolve('done'));
    // The fake member is not in a voice channel, so the pause policy denies the action.
    (ctx.member as unknown as { voice: unknown }).voice = { channelId: null };

    await expect(run(ctx, 'pause', perform)).rejects.toBeDefined();
    expect(perform).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});
