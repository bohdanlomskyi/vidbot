export type AccessAction =
  | 'view'
  | 'enqueue'
  | 'join'
  | 'pause'
  | 'resume'
  | 'skip'
  | 'restart'
  | 'shuffle'
  | 'loop'
  | 'volume'
  | 'remove'
  | 'clear'
  | 'stop'
  | 'leave'
  | 'move'
  | 'admin';

export interface AccessActor {
  readonly userId: string;
  /** The user is in the voice channel the bot is currently using. */
  readonly inBotChannel: boolean;
  readonly inAnyVoiceChannel: boolean;
  readonly isDj: boolean;
  /** Has Manage Server or Administrator permission. */
  readonly isAdmin: boolean;
}

export interface AccessContext {
  readonly policy: 'everyone' | 'dj';
  /** The bot is connected to some voice channel. */
  readonly botConnected: boolean;
  /** The session is playing, paused, or has listeners. */
  readonly botBusy: boolean;
  /** The actor is the only human listener in the bot's channel. */
  readonly soleListener: boolean;
  readonly skipVoteEnabled: boolean;
}

export interface AccessTarget {
  readonly requesterId: string;
}

export type AccessDenialReason = 'NOT_IN_VOICE' | 'NOT_ALLOWED' | 'BOT_BUSY' | 'VOTE_REQUIRED';

export type AccessDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: AccessDenialReason };

const ALLOW: AccessDecision = { allowed: true };

function deny(reason: AccessDenialReason): AccessDecision {
  return { allowed: false, reason };
}

/**
 * Decides whether an actor may perform an action in the current session. The
 * function is pure, so the full rule matrix can be tested directly. Each rule
 * is documented in docs/architecture.md section 9.
 */
export function evaluateAccess(
  action: AccessAction,
  actor: AccessActor,
  context: AccessContext,
  target?: AccessTarget,
): AccessDecision {
  const manages = actor.isDj || actor.isAdmin;

  switch (action) {
    case 'view':
      return ALLOW;

    case 'admin':
      return actor.isAdmin ? ALLOW : deny('NOT_ALLOWED');

    case 'move':
      return manages ? ALLOW : deny('NOT_ALLOWED');

    case 'enqueue':
    case 'join': {
      if (!actor.inAnyVoiceChannel) {
        return deny('NOT_IN_VOICE');
      }
      // A busy bot in another channel is never moved by an ordinary user.
      if (context.botConnected && context.botBusy && !actor.inBotChannel) {
        return deny('BOT_BUSY');
      }
      return ALLOW;
    }

    case 'remove': {
      if (!actor.inBotChannel) {
        return deny('NOT_IN_VOICE');
      }
      if (manages || (context.policy === 'everyone' && context.soleListener)) {
        return ALLOW;
      }
      return target?.requesterId === actor.userId ? ALLOW : deny('NOT_ALLOWED');
    }

    case 'clear':
    case 'stop':
    case 'leave': {
      if (!actor.inBotChannel) {
        return deny('NOT_IN_VOICE');
      }
      if (manages || (context.policy === 'everyone' && context.soleListener)) {
        return ALLOW;
      }
      return deny('NOT_ALLOWED');
    }

    case 'pause':
    case 'resume':
    case 'skip':
    case 'restart':
    case 'shuffle':
    case 'loop':
    case 'volume': {
      if (!actor.inBotChannel) {
        return deny('NOT_IN_VOICE');
      }
      if (manages) {
        return ALLOW;
      }
      if (context.policy === 'dj') {
        return deny('NOT_ALLOWED');
      }
      if (action === 'skip' && context.skipVoteEnabled && !context.soleListener) {
        return deny('VOTE_REQUIRED');
      }
      return ALLOW;
    }
  }
}
