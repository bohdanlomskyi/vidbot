const PREFIX = 'melody';
const MAX_LENGTH = 100;
const NAME_PATTERN = /^[a-z0-9_-]{1,32}$/;
const ARGUMENT_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

export interface ParsedCustomId {
  readonly feature: string;
  readonly action: string;
  readonly args: readonly string[];
}

/**
 * Builds a Discord component identifier of the form `melody:<feature>:<action>[:args]`.
 * Discord limits identifiers to 100 characters, and the colon separator must never
 * appear inside a segment. Both are enforced here, because either mistake is a bug in
 * the caller.
 */
export function buildCustomId(feature: string, action: string, ...args: string[]): string {
  if (!NAME_PATTERN.test(feature) || !NAME_PATTERN.test(action)) {
    throw new RangeError(`Invalid custom id name: ${feature}:${action}`);
  }
  for (const arg of args) {
    if (!ARGUMENT_PATTERN.test(arg)) {
      throw new RangeError('Invalid custom id argument');
    }
  }

  const id = [PREFIX, feature, action, ...args].join(':');
  if (id.length > MAX_LENGTH) {
    throw new RangeError('Custom id exceeds the Discord limit of 100 characters');
  }
  return id;
}

/** Parses a component identifier. Returns null for identifiers that are not Melody's or are malformed. */
export function parseCustomId(id: string): ParsedCustomId | null {
  const [prefix, feature, action, ...args] = id.split(':');
  if (prefix !== PREFIX || feature === undefined || action === undefined) {
    return null;
  }
  if (!NAME_PATTERN.test(feature) || !NAME_PATTERN.test(action)) {
    return null;
  }
  if (args.some((arg) => !ARGUMENT_PATTERN.test(arg))) {
    return null;
  }
  return { feature, action, args };
}
