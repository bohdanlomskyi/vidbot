import { createCipheriv, createDecipheriv, getCiphers, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

export interface NativeCheck {
  readonly ok: boolean;
  readonly detail: string;
}

/** 20 ms of stereo 16-bit PCM at 48 kHz: 960 samples per channel, 2 channels, 2 bytes each. */
const OPUS_FRAME_BYTES = 960 * 2 * 2;
const SAMPLE_RATE = 48_000;
const CHANNELS = 2;

interface OpusModule {
  readonly OpusEncoder: new (
    sampleRate: number,
    channels: number,
  ) => { encode(frame: Buffer): Buffer };
}

const requireNative = createRequire(import.meta.url);

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'неизвестная ошибка';
}

/** Loads the native Opus encoder and encodes one silent frame. The package is CommonJS, hence createRequire. */
export function checkOpus(): NativeCheck {
  try {
    const { OpusEncoder } = requireNative('@discordjs/opus') as OpusModule;
    const packet = new OpusEncoder(SAMPLE_RATE, CHANNELS).encode(Buffer.alloc(OPUS_FRAME_BYTES));
    return packet.length > 0
      ? { ok: true, detail: `Opus кодирует кадры по 20 мс, пакет ${String(packet.length)} байт` }
      : { ok: false, detail: 'Opus вернул пустой пакет' };
  } catch (error) {
    return { ok: false, detail: `Opus не загружается: ${describeError(error)}` };
  }
}

/** Loads the DAVE library and builds a key package, which exercises the native code path. */
export async function checkDave(): Promise<NativeCheck> {
  try {
    const dave = await import('@snazzah/davey');
    const session = new dave.DAVESession(dave.DAVE_PROTOCOL_VERSION, '1', '1');
    const keyPackage = session.getSerializedKeyPackage();
    return keyPackage.length > 0
      ? {
          ok: true,
          detail: `DAVE, протокол ${String(dave.DAVE_PROTOCOL_VERSION)}, библиотека ${dave.VERSION}`,
        }
      : { ok: false, detail: 'DAVE не создал пакет ключей' };
  } catch (error) {
    return { ok: false, detail: `DAVE не загружается: ${describeError(error)}` };
  }
}

/** The voice transport encrypts with AES-256-GCM. This checks that OpenSSL offers it and that it round-trips. */
export function checkCipher(): NativeCheck {
  if (!getCiphers().includes('aes-256-gcm')) {
    return { ok: false, detail: 'OpenSSL не содержит шифр aes-256-gcm' };
  }
  try {
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update('melody', 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
      'utf8',
    );
    return decrypted === 'melody'
      ? { ok: true, detail: 'AES-256-GCM работает' }
      : { ok: false, detail: 'AES-256-GCM вернул другое значение' };
  } catch (error) {
    return { ok: false, detail: `AES-256-GCM не работает: ${describeError(error)}` };
  }
}
