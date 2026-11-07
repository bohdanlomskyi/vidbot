import { MessageFlags } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Responder,
  responderFor,
  type ResponderInteraction,
} from '../../../src/commands/responder.js';

interface Call {
  readonly method: string;
  readonly options?: unknown;
}

function fakeInteraction(channelId = 'chat'): ResponderInteraction & { calls: Call[] } {
  const calls: Call[] = [];
  const record =
    (method: string) =>
    (options?: unknown): Promise<unknown> => {
      calls.push({ method, options });
      if (method === 'reply' && (options as { withResponse?: boolean }).withResponse === true) {
        return Promise.resolve({ resource: { message: { id: '900', channelId } } });
      }
      return Promise.resolve(undefined);
    };
  return {
    channelId,
    calls,
    deferReply: record('deferReply'),
    deferUpdate: record('deferUpdate'),
    reply: record('reply'),
    editReply: record('editReply'),
    deleteReply: record('deleteReply'),
    followUp: record('followUp'),
  } as unknown as ResponderInteraction & { calls: Call[] };
}

function methods(interaction: { calls: Call[] }): string[] {
  return interaction.calls.map((call) => call.method);
}

describe('Responder', () => {
  let posted: string[];
  let postedTo: string[];
  let publicMessages: unknown[];

  beforeEach(() => {
    vi.useFakeTimers();
    posted = [];
    postedTo = [];
    publicMessages = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function responder(
    interaction: ResponderInteraction,
    kind: 'command' | 'component',
    postWorks = true,
  ): Responder {
    return new Responder(interaction, {
      kind,
      ackAfterMs: 1_500,
      postToChannel: (channelId, text) => {
        posted.push(text);
        postedTo.push(channelId);
        return Promise.resolve(postWorks);
      },
      onPublicMessage: (message) => {
        publicMessages.push(message);
      },
    });
  }

  describe('for a slash command', () => {
    it('answers a quick action with one public reply, without deferring', async () => {
      const interaction = fakeInteraction();
      const r = responder(interaction, 'command');

      expect(await r.publish('⏸ Пауза.')).toBe(true);
      await vi.advanceTimersByTimeAsync(5_000);

      expect(methods(interaction)).toEqual(['reply']);
      expect(interaction.calls[0]?.options).toMatchObject({
        content: '⏸ Пауза.',
        withResponse: true,
      });
      expect(interaction.calls[0]?.options).not.toHaveProperty('flags');
      expect(publicMessages).toEqual([{ channelId: 'chat', messageId: '900' }]);
      expect(posted).toEqual([]);
    });

    it('answers privately with one ephemeral reply', async () => {
      const interaction = fakeInteraction();

      await responder(interaction, 'command').private('Нет прав.');

      expect(methods(interaction)).toEqual(['reply']);
      expect(interaction.calls[0]?.options).toMatchObject({
        content: 'Нет прав.',
        flags: MessageFlags.Ephemeral,
      });
    });

    it('defers privately when the work takes long, then posts to the chat and removes the placeholder', async () => {
      const interaction = fakeInteraction();
      const r = responder(interaction, 'command');

      await vi.advanceTimersByTimeAsync(1_500);
      expect(methods(interaction)).toEqual(['deferReply']);
      expect(interaction.calls[0]?.options).toEqual({ flags: MessageFlags.Ephemeral });

      expect(await r.publish('🎶 Сейчас играет')).toBe(true);

      expect(posted).toEqual(['🎶 Сейчас играет']);
      expect(methods(interaction)).toEqual(['deferReply', 'deleteReply']);
    });

    it('never uses followUp for a public message after a deferred reply', async () => {
      // The first follow-up of a deferred reply replaces the private placeholder, so it would stay private.
      const interaction = fakeInteraction();
      const r = responder(interaction, 'command');
      await vi.advanceTimersByTimeAsync(1_500);

      await r.publish('text');

      expect(methods(interaction)).not.toContain('followUp');
    });

    it('posts a slow result into the channel where the command was used', async () => {
      const interaction = fakeInteraction('general');
      const r = responder(interaction, 'command');
      await vi.advanceTimersByTimeAsync(1_500);

      await r.publish('⏭ Пропущено.');

      expect(postedTo).toEqual(['general']);
      expect(methods(interaction)).toEqual(['deferReply', 'deleteReply']);
    });

    it('reports failure when the chat message cannot be sent, so the caller answers privately', async () => {
      const interaction = fakeInteraction();
      const r = responder(interaction, 'command', false);
      await vi.advanceTimersByTimeAsync(1_500);

      expect(await r.publish('text')).toBe(false);
      await r.private('text');

      expect(methods(interaction)).toEqual(['deferReply', 'editReply']);
    });

    it('edits the private placeholder for progress and the final private answer', async () => {
      const interaction = fakeInteraction();
      const r = responder(interaction, 'command');

      await r.private('⏳ Ищу…');
      await r.private({ content: '', embeds: [], components: [] });

      expect(methods(interaction)).toEqual(['reply', 'editReply']);
    });

    it('acknowledges silently when there is nothing to say', async () => {
      const interaction = fakeInteraction();

      await responder(interaction, 'command').dismiss();

      expect(methods(interaction)).toEqual(['deferReply', 'deleteReply']);
    });

    it('removes a deferred placeholder when there is nothing to say', async () => {
      const interaction = fakeInteraction();
      const r = responder(interaction, 'command');
      await vi.advanceTimersByTimeAsync(1_500);

      await r.dismiss();

      expect(methods(interaction)).toEqual(['deferReply', 'deleteReply']);
    });
  });

  describe('for a panel button', () => {
    it('answers with one public reply when the action is quick', async () => {
      const interaction = fakeInteraction();

      await responder(interaction, 'component').publish('⏸ Пауза.');

      expect(methods(interaction)).toEqual(['reply']);
      expect(publicMessages).toHaveLength(1);
    });

    it('acknowledges the click when the work takes long, then posts to the chat', async () => {
      const interaction = fakeInteraction();
      const r = responder(interaction, 'component');
      await vi.advanceTimersByTimeAsync(1_500);

      await r.publish('⏭ Пропущено.');

      expect(methods(interaction)).toEqual(['deferUpdate']);
      expect(posted).toEqual(['⏭ Пропущено.']);
    });

    it('sends private answers as ephemeral follow-ups once the click was acknowledged', async () => {
      const interaction = fakeInteraction();
      const r = responder(interaction, 'component');
      await vi.advanceTimersByTimeAsync(1_500);

      await r.private('Нет прав.');

      expect(methods(interaction)).toEqual(['deferUpdate', 'followUp']);
      expect(interaction.calls[1]?.options).toMatchObject({ flags: MessageFlags.Ephemeral });
    });

    it('only acknowledges the click when there is nothing to say', async () => {
      const interaction = fakeInteraction();

      await responder(interaction, 'component').dismiss();

      expect(methods(interaction)).toEqual(['deferUpdate']);
    });
  });

  it('is found again by its interaction, so an error is answered in the right way', async () => {
    const interaction = fakeInteraction();
    const r = responder(interaction, 'command');
    await vi.advanceTimersByTimeAsync(1_500);

    expect(responderFor(interaction)).toBe(r);
    await responderFor(interaction)?.private('Ошибка.');

    expect(methods(interaction)).toEqual(['deferReply', 'editReply']);
  });

  it('runs a timed acknowledgement and an answer one after the other, never both as first response', async () => {
    let finishDefer: () => void = () => undefined;
    const interaction = fakeInteraction();
    const calls = interaction.calls;
    (interaction as unknown as { deferReply: () => Promise<void> }).deferReply = () => {
      calls.push({ method: 'deferReply' });
      return new Promise<void>((resolve) => {
        finishDefer = resolve;
      });
    };
    const r = responder(interaction, 'command');
    await vi.advanceTimersByTimeAsync(1_500);

    const answer = r.private('Готово.');
    await vi.advanceTimersByTimeAsync(0);
    expect(methods(interaction)).toEqual(['deferReply']);
    finishDefer();
    await answer;

    expect(methods(interaction)).toEqual(['deferReply', 'editReply']);
  });
});
