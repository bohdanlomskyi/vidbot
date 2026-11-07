import {
  MessageFlags,
  type ActionRowBuilder,
  type ButtonBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type EmbedBuilder,
} from 'discord.js';

/** Discord waits 3 s for the first answer. Work that is still running then gets a placeholder. */
const DEFAULT_ACK_AFTER_MS = 1_500;

/** A private answer: plain text, or text with embeds and buttons. */
export type PrivatePayload =
  | string
  | {
      readonly content?: string;
      readonly embeds?: EmbedBuilder[];
      readonly components?: ActionRowBuilder<ButtonBuilder>[];
    };

/** Where a public answer ended up, so the player panel can move below it. */
export interface PublicMessage {
  readonly channelId: string;
  readonly messageId: string;
}

/** The parts of a command or button interaction the responder uses. */
export type ResponderInteraction = Pick<
  ChatInputCommandInteraction,
  'channelId' | 'deferReply' | 'reply' | 'editReply' | 'deleteReply' | 'followUp'
> &
  Partial<Pick<ButtonInteraction, 'deferUpdate'>>;

export interface ResponderOptions {
  readonly kind: 'command' | 'component';
  /** Sends text as a normal bot message into the channel. True when it was sent. */
  readonly postToChannel: (channelId: string, text: string) => Promise<boolean>;
  readonly onPublicMessage?: (message: PublicMessage) => void;
  readonly ackAfterMs?: number;
}

/**
 * - `none`: nothing sent yet.
 * - `private`: an ephemeral first answer exists (a deferred placeholder or a reply). It is edited.
 * - `public`: the first answer is a public message.
 * - `acked`: a button click was acknowledged without a message.
 * - `removed`: the private placeholder was deleted.
 */
type State = 'none' | 'private' | 'public' | 'acked' | 'removed';

const responders = new WeakMap<object, Responder>();

/** A private answer that replaces whatever the earlier one showed, and mentions nobody. */
export function privateBody(payload: PrivatePayload) {
  return {
    content: '',
    embeds: [],
    components: [],
    ...(typeof payload === 'string' ? { content: payload } : payload),
    allowedMentions: { parse: [] as [] },
  };
}

/** The responder handling this interaction, if a handler created one. Used to report errors. */
export function responderFor(interaction: object): Responder | undefined {
  return responders.get(interaction);
}

/**
 * Answers one interaction with as few Discord calls as possible. A quick action is answered with
 * one reply, public or private, with no "thinking" placeholder first. Only when the work is still
 * running shortly before Discord's 3 s limit is a private placeholder sent; a public answer then
 * goes to the chat as a normal message and the placeholder is deleted. A follow-up is never used
 * for a public answer: the first follow-up of a deferred reply replaces the private placeholder
 * and stays private. All calls run one after another, so a timed placeholder and an answer can
 * never both claim the first response.
 */
export class Responder {
  private state: State = 'none';
  private queue: Promise<unknown> = Promise.resolve();
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly interaction: ResponderInteraction,
    private readonly options: ResponderOptions,
  ) {
    responders.set(interaction, this);
    this.timer = setTimeout(() => {
      void this.acknowledge().catch(() => undefined);
    }, options.ackAfterMs ?? DEFAULT_ACK_AFTER_MS);
    this.timer.unref();
  }

  /** Sends a placeholder (a command) or acknowledges the click (a button), if nothing was sent yet. */
  acknowledge(): Promise<void> {
    return this.serial(async () => {
      if (this.state !== 'none') {
        return;
      }
      await this.firstAcknowledgement();
    });
  }

  /** An answer only the member sees. */
  private(payload: PrivatePayload): Promise<void> {
    this.answering();
    const body = privateBody(payload);
    return this.serial(async () => {
      switch (this.state) {
        case 'none':
          await this.interaction.reply({ ...body, flags: MessageFlags.Ephemeral });
          this.state = 'private';
          return;
        case 'private':
          await this.interaction.editReply(body);
          return;
        default:
          await this.interaction.followUp({ ...body, flags: MessageFlags.Ephemeral });
      }
    });
  }

  /** A message everybody in the chat sees. False when it could not be sent. */
  publish(text: string): Promise<boolean> {
    this.answering();
    return this.serial(async () => {
      if (this.state === 'none') {
        try {
          const response = await this.interaction.reply({
            content: text,
            allowedMentions: { parse: [] },
            withResponse: true,
          });
          this.state = 'public';
          const message = response.resource?.message;
          if (message !== null && message !== undefined) {
            this.options.onPublicMessage?.({ channelId: message.channelId, messageId: message.id });
          }
          return true;
        } catch {
          return false;
        }
      }
      // The answer stays where the member used the command, whether it was quick or slow.
      if (!(await this.options.postToChannel(this.interaction.channelId, text))) {
        return false;
      }
      if (this.state === 'private') {
        await this.interaction.deleteReply().catch(() => undefined);
        this.state = 'removed';
      }
      return true;
    });
  }

  /** Nothing to say: the interaction is acknowledged and no message stays behind. */
  dismiss(): Promise<void> {
    this.answering();
    return this.serial(async () => {
      if (this.state === 'none') {
        await this.firstAcknowledgement();
      }
      if (this.state === 'private') {
        await this.interaction.deleteReply().catch(() => undefined);
        this.state = 'removed';
      }
    });
  }

  /** A button click is acknowledged without a message; a command gets a private placeholder. */
  private async firstAcknowledgement(): Promise<void> {
    if (this.options.kind === 'component') {
      await this.interaction.deferUpdate?.();
      this.state = 'acked';
      return;
    }
    await this.interaction.deferReply({ flags: MessageFlags.Ephemeral });
    this.state = 'private';
  }

  /** Runs Discord calls one at a time, in the order they were asked for. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Any real answer makes the timed placeholder unnecessary. */
  private answering(): void {
    clearTimeout(this.timer);
  }
}
