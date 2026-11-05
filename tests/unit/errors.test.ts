import { describe, expect, it } from 'vitest';
import { AppError, isAppError, toUserMessage } from '../../src/utils/errors.js';

describe('AppError', () => {
  it('keeps the user-facing message separate from the internal cause', () => {
    const cause = new Error('ECONNRESET on 10.0.0.5');
    const error = new AppError('VOICE_FAILED', 'Не удалось подключиться к голосовому каналу.', {
      cause,
    });

    expect(error.code).toBe('VOICE_FAILED');
    expect(error.userMessage).toBe('Не удалось подключиться к голосовому каналу.');
    expect(error.cause).toBe(cause);
  });

  it('is recognised by isAppError while plain errors are not', () => {
    expect(isAppError(new AppError('NOT_ALLOWED', 'Нет доступа.'))).toBe(true);
    expect(isAppError(new Error('plain'))).toBe(false);
  });
});

describe('toUserMessage', () => {
  it('returns the user message of an application error', () => {
    expect(toUserMessage(new AppError('NOT_ALLOWED', 'Нет доступа.'), 'Ошибка.')).toBe(
      'Нет доступа.',
    );
  });

  it('returns the fallback for internal errors so paths and stack details never reach users', () => {
    const internal = new Error('SQLITE_BUSY: /srv/secret/melody.sqlite locked');

    expect(toUserMessage(internal, 'Внутренняя ошибка. Попробуйте позже.')).toBe(
      'Внутренняя ошибка. Попробуйте позже.',
    );
  });
});
