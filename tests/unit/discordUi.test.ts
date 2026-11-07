import { describe, expect, it } from 'vitest';
import {
  buildPanelPayload,
  buildQueuePage,
  type MessagePayload,
} from '../../src/discord/ui/panel.js';
import { buildSearchPicker } from '../../src/discord/ui/searchPicker.js';
import { parseCustomId } from '../../src/security/customIds.js';
import type { GuildSnapshot } from '../../src/music/engine/snapshot.js';
import type { Track } from '../../src/music/models/track.js';

function track(title: string, durationSec: number | null = 200): Track {
  return {
    id: `id-${title}`,
    source: 'local',
    sourceRef: title,
    title,
    artist: 'Artist',
    durationSec,
    thumbnailUrl: null,
    originalUrl: null,
    requesterId: '123456789012345678',
    createdAt: 0,
    metadata: {},
  };
}

function snapshot(overrides: Partial<GuildSnapshot> = {}): GuildSnapshot {
  return {
    guildId: 'g1',
    state: 'idle',
    voiceChannelId: null,
    nowPlaying: null,
    queue: [],
    queueLimit: 100,
    loop: 'off',
    volume: 70,
    listeners: 0,
    notice: null,
    ...overrides,
  };
}

interface ButtonView {
  readonly label: string;
  readonly customId: string;
  readonly disabled: boolean;
}

function buttonsOf(payload: MessagePayload): ButtonView[] {
  return payload.components.flatMap((row) =>
    row.components.map((button) => {
      const json = button.toJSON();
      return {
        label: 'label' in json ? (json.label ?? '') : '',
        customId: 'custom_id' in json ? json.custom_id : '',
        disabled: json.disabled === true,
      };
    }),
  );
}

describe('music panel', () => {
  it('invites the user to type /play when nothing is playing', () => {
    const payload = buildPanelPayload(snapshot(), 'Melody');

    expect(JSON.stringify(payload.embeds[0]?.toJSON())).toContain('/play');
  });

  it('disables the playback buttons when nothing is playing but keeps queue and loop available', () => {
    const buttons = buttonsOf(buildPanelPayload(snapshot(), 'Melody'));
    const byId = new Map(buttons.map((button) => [button.customId, button.disabled]));

    expect(byId.get('melody:panel:toggle')).toBe(true);
    expect(byId.get('melody:panel:skip')).toBe(true);
    expect(byId.get('melody:panel:queue')).toBe(false);
    expect(byId.get('melody:panel:loop')).toBe(false);
  });

  it('shows the current track, its requester, the queue size and the repeat mode while playing', () => {
    const payload = buildPanelPayload(
      snapshot({
        state: 'playing',
        nowPlaying: { track: track('Alpha'), elapsedMs: 42_000, paused: false },
        queue: [track('Beta')],
        loop: 'queue',
      }),
      'Melody',
    );
    const embed = payload.embeds[0]?.toJSON();
    const text = JSON.stringify(embed);

    expect(embed?.author?.name).toBe('🎵 Сейчас играет');
    expect(embed?.title).toBe('Alpha');
    expect(embed?.description).toContain('[0:42/3:20]');
    expect(text).toContain('<@123456789012345678>');
    expect(text).toContain('повтор: очередь');
    expect(text).toContain('Громкость');
  });

  it('marks a paused track in the header', () => {
    const payload = buildPanelPayload(
      snapshot({
        state: 'paused',
        nowPlaying: { track: track('Alpha'), elapsedMs: 0, paused: true },
      }),
      'Melody',
    );

    expect(payload.embeds[0]?.toJSON().author?.name).toBe('⏸ На паузе');
  });

  it('says the track is still loading instead of claiming it already plays', () => {
    const payload = buildPanelPayload(
      snapshot({
        state: 'buffering',
        voiceChannelId: 'c1',
        nowPlaying: { track: track('Alpha'), elapsedMs: 0, paused: false },
      }),
      'Melody',
    );

    expect(payload.embeds[0]?.toJSON().author?.name).toBe('⏳ Загружается');
  });

  it('escapes markdown in track titles so they cannot change the layout', () => {
    const payload = buildPanelPayload(
      snapshot({
        state: 'playing',
        nowPlaying: { track: track('*Bold* _it_'), elapsedMs: 0, paused: false },
      }),
      'Melody',
    );

    expect(payload.embeds[0]?.toJSON().title).toContain('\\*Bold\\* \\_it\\_');
  });

  it('has the buttons of a full player: previous, pause, skip, stop, shuffle, repeat, favorite, volume', () => {
    const buttons = buttonsOf(buildPanelPayload(snapshot(), 'Melody'));

    expect(buttons.map((button) => button.customId.split(':')[2])).toEqual([
      'previous',
      'toggle',
      'skip',
      'stop',
      'queue',
      'shuffle',
      'loop',
      'favorite',
      'voldown',
      'volup',
    ]);
  });

  it('turns the pause button into a resume button while paused', () => {
    const paused = buildPanelPayload(
      snapshot({
        state: 'paused',
        voiceChannelId: 'c1',
        nowPlaying: { track: track('Alpha'), elapsedMs: 0, paused: true },
      }),
      'Melody',
    );
    const playing = buildPanelPayload(
      snapshot({
        state: 'playing',
        voiceChannelId: 'c1',
        nowPlaying: { track: track('Alpha'), elapsedMs: 0, paused: false },
      }),
      'Melody',
    );

    const label = (payload: MessagePayload): string | undefined =>
      buttonsOf(payload).find((button) => button.customId === 'melody:panel:toggle')?.label;
    expect(label(paused)).toContain('Продолжить');
    expect(label(playing)).toContain('Пауза');
  });

  it('links the title to the video when the track has a link, and shows its cover', () => {
    const youtube: Track = {
      ...track('Alpha'),
      source: 'youtube',
      originalUrl: 'https://www.youtube.com/watch?v=lhCPiauHI-g',
      thumbnailUrl: 'https://i.ytimg.com/vi/lhCPiauHI-g/hq720.jpg',
    };
    const payload = buildPanelPayload(
      snapshot({ state: 'playing', nowPlaying: { track: youtube, elapsedMs: 0, paused: false } }),
      'Melody',
    );
    const embed = payload.embeds[0]?.toJSON();

    expect(embed?.url).toBe('https://www.youtube.com/watch?v=lhCPiauHI-g');
    expect(embed?.thumbnail?.url).toContain('lhCPiauHI-g');
  });

  it('keeps every custom identifier within the Discord limit', () => {
    for (const button of buttonsOf(buildPanelPayload(snapshot(), 'Melody'))) {
      expect(button.customId.length).toBeLessThanOrEqual(100);
      expect(button.customId.startsWith('melody:panel:')).toBe(true);
    }
  });
});

describe('queue pages', () => {
  it('splits a long queue into pages of ten and reports the page count', () => {
    const queue = Array.from({ length: 23 }, (_unused, index) => track(`t${String(index)}`));
    const page = buildQueuePage(snapshot({ queue }), 3, 10);

    expect(page.embeds[0]?.toJSON().footer?.text).toBe('Страница 3 из 3');
    expect(JSON.stringify(page.embeds[0]?.toJSON())).toContain('t20');
  });

  it('clamps an out-of-range page number to the existing pages', () => {
    const page = buildQueuePage(snapshot({ queue: [track('only')] }), 99, 10);

    expect(page.embeds[0]?.toJSON().footer?.text).toBe('Страница 1 из 1');
  });

  it('describes an empty queue plainly', () => {
    const text = JSON.stringify(buildQueuePage(snapshot(), 1, 10).embeds[0]?.toJSON());

    expect(text).toContain('Очередь пуста');
  });

  it('disables the previous page button on the first page and the next button on the last', () => {
    const queue = Array.from({ length: 15 }, (_unused, index) => track(`t${String(index)}`));

    const first = buttonsOf(buildQueuePage(snapshot({ queue }), 1, 10));
    const last = buttonsOf(buildQueuePage(snapshot({ queue }), 2, 10));

    expect(first.find((button) => button.customId === 'melody:queue:page:0')?.disabled).toBe(true);
    expect(last.find((button) => button.customId === 'melody:queue:page:3')?.disabled).toBe(true);
  });
});

describe('search picker', () => {
  const results = [
    {
      source: 'youtube' as const,
      sourceRef: 'lhCPiauHI-g',
      title: 'Lord Verity - *Master* of Humanity',
      artist: 'Horror Skunx',
      durationSec: 141,
      thumbnailUrl: 'https://i.ytimg.com/vi/lhCPiauHI-g/hq720.jpg',
      originalUrl: 'https://www.youtube.com/watch?v=lhCPiauHI-g',
      metadata: {},
    },
    {
      source: 'youtube' as const,
      sourceRef: 'b4iZR0G_sxc',
      title: 'Lyrics',
      artist: null,
      durationSec: 141,
      thumbnailUrl: null,
      originalUrl: 'https://www.youtube.com/watch?v=b4iZR0G_sxc',
      metadata: {},
    },
  ];

  it('lists each result with its channel and length, and escapes markdown in titles', () => {
    const embed = buildSearchPicker('lord verity', results, 'tok123').embeds[0]?.toJSON();

    expect(embed?.title).toContain('lord verity');
    expect(embed?.description).toContain('**1.**');
    expect(embed?.description).toContain('\\*Master\\*');
    expect(embed?.description).toContain('Horror Skunx');
    expect(embed?.description).toContain('2:21');
    expect(embed?.thumbnail?.url).toContain('lhCPiauHI-g');
  });

  it('has one numbered button per result and a cancel button, all with valid identifiers', () => {
    const buttons = buttonsOf(buildSearchPicker('x', results, 'tok123'));

    expect(buttons.map((button) => button.customId)).toEqual([
      'melody:search:pick:tok123:0',
      'melody:search:pick:tok123:1',
      'melody:search:cancel:tok123',
    ]);
    expect(buttons.map((button) => button.label)).toEqual(['1', '2', 'Отмена']);
    for (const button of buttons) {
      expect(parseCustomId(button.customId)).not.toBeNull();
      expect(button.customId.length).toBeLessThanOrEqual(100);
    }
  });
});
