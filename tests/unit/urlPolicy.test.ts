import { describe, expect, it } from 'vitest';
import {
  checkStreamUrl,
  isPublicIp,
  selectPublicAddress,
  type StreamUrlPolicy,
} from '../../src/security/urlPolicy.js';

const POLICY: StreamUrlPolicy = {
  allowedHosts: ['radio.example.org'],
  allowHttp: false,
  allowedPorts: [443],
};

describe('checkStreamUrl', () => {
  it('accepts an https URL on an allowlisted host', () => {
    expect(checkStreamUrl('https://radio.example.org/live.mp3', POLICY)).toMatchObject({
      ok: true,
    });
  });

  it('rejects plain http unless the catalog entry explicitly allows it', () => {
    const httpUrl = 'http://radio.example.org/live.mp3';

    expect(checkStreamUrl(httpUrl, POLICY)).toEqual({ ok: false, reason: 'UNSUPPORTED_SCHEME' });
    expect(
      checkStreamUrl(httpUrl, { ...POLICY, allowHttp: true, allowedPorts: [80, 443] }),
    ).toMatchObject({ ok: true });
  });

  it('rejects local file and other non-web schemes', () => {
    expect(checkStreamUrl('file:///etc/passwd', POLICY)).toEqual({
      ok: false,
      reason: 'UNSUPPORTED_SCHEME',
    });
  });

  it('rejects URLs that embed credentials', () => {
    expect(checkStreamUrl('https://user:secret@radio.example.org/live.mp3', POLICY)).toEqual({
      ok: false,
      reason: 'CREDENTIALS_NOT_ALLOWED',
    });
  });

  it('rejects public hosts that are not on the allowlist', () => {
    expect(checkStreamUrl('https://other.example.net/live.mp3', POLICY)).toEqual({
      ok: false,
      reason: 'HOST_NOT_ALLOWED',
    });
  });

  it('rejects loopback, link-local and metadata addresses even when they are listed', () => {
    const listed: StreamUrlPolicy = {
      allowedHosts: ['127.0.0.1', '169.254.169.254', '::1'],
      allowHttp: false,
      allowedPorts: [443],
    };

    expect(checkStreamUrl('https://127.0.0.1/stream', listed)).toEqual({
      ok: false,
      reason: 'PRIVATE_ADDRESS',
    });
    expect(checkStreamUrl('https://169.254.169.254/latest/meta-data/', listed)).toEqual({
      ok: false,
      reason: 'PRIVATE_ADDRESS',
    });
    expect(checkStreamUrl('https://[::1]/stream', listed)).toEqual({
      ok: false,
      reason: 'PRIVATE_ADDRESS',
    });
  });

  it('rejects ports outside the allowed list', () => {
    expect(checkStreamUrl('https://radio.example.org:8443/live.mp3', POLICY)).toEqual({
      ok: false,
      reason: 'PORT_NOT_ALLOWED',
    });
  });

  it('rejects malformed and overly long URLs', () => {
    expect(checkStreamUrl('not a url', POLICY)).toEqual({ ok: false, reason: 'INVALID_URL' });
    expect(checkStreamUrl(`https://radio.example.org/${'a'.repeat(2100)}`, POLICY)).toEqual({
      ok: false,
      reason: 'TOO_LONG',
    });
  });
});

describe('isPublicIp', () => {
  it.each<[string, boolean]>([
    ['8.8.8.8', true],
    ['172.32.0.1', true],
    ['100.128.0.1', true],
    ['127.0.0.1', false],
    ['10.1.2.3', false],
    ['172.16.0.1', false],
    ['192.168.1.1', false],
    ['169.254.169.254', false],
    ['100.64.0.1', false],
    ['0.0.0.0', false],
    ['224.0.0.1', false],
    ['255.255.255.255', false],
    ['192.0.2.5', false],
    ['2001:4860:4860::8888', true],
    ['::ffff:8.8.8.8', true],
    ['::1', false],
    ['::', false],
    ['::ffff:127.0.0.1', false],
    ['fc00::1', false],
    ['fe80::1', false],
    ['ff02::1', false],
    ['2001:db8::1', false],
    ['2002:7f00:1::', false],
    ['example.com', false],
  ])('classifies %s as public=%s', (address, expected) => {
    expect(isPublicIp(address)).toBe(expected);
  });
});

describe('selectPublicAddress', () => {
  it('returns the single public address', () => {
    expect(selectPublicAddress([{ address: '8.8.8.8', family: 4 }])).toEqual({
      ok: true,
      address: '8.8.8.8',
      family: 4,
    });
  });

  it('refuses a DNS answer that mixes public and private addresses', () => {
    expect(
      selectPublicAddress([
        { address: '8.8.8.8', family: 4 },
        { address: '10.0.0.5', family: 4 },
      ]),
    ).toEqual({ ok: false, reason: 'PRIVATE_ADDRESS' });
  });

  it('refuses an empty DNS answer', () => {
    expect(selectPublicAddress([])).toEqual({ ok: false, reason: 'NO_ADDRESS' });
  });
});
