import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/utils/logger.js';

const TOKEN = 'redaction-fixture-secret-0123456789abcdef';

function captureStream(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString('utf8'));
      callback();
    },
  });
  return { stream, text: () => chunks.join('') };
}

describe('createLogger', () => {
  it('never writes the Discord token to the output, even inside errors and nested objects', () => {
    const output = captureStream();
    const logger = createLogger({ level: 'info', secrets: [TOKEN], destination: output.stream });

    logger.info({ token: TOKEN, nested: { header: `Bot ${TOKEN}` } }, `connecting with ${TOKEN}`);
    logger.error({ err: new Error(`login failed for ${TOKEN}`) }, 'login failed');

    expect(output.text()).not.toContain(TOKEN);
    expect(output.text()).toContain('connecting');
    expect(output.text()).toContain('login failed');
  });

  it('drops records below the configured level', () => {
    const output = captureStream();
    const logger = createLogger({ level: 'warn', secrets: [], destination: output.stream });

    logger.info('hidden message');
    logger.warn('visible message');

    expect(output.text()).not.toContain('hidden message');
    expect(output.text()).toContain('visible message');
  });
});
