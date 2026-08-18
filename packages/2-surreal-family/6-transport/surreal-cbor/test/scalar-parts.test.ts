import { describe, expect, it } from 'vitest';
import {
  bytesToUuid,
  datetimeToParts,
  durationToParts,
  partsToDatetime,
  partsToDuration,
  uuidToBytes,
} from '../src/scalar-parts';

describe('datetime parts', () => {
  it.each([
    ['2024-01-02T03:04:05Z', [1704164645, 0]],
    ['2024-01-02T03:04:05.123Z', [1704164645, 123000000]],
    ['2024-01-02T03:04:05.123456789Z', [1704164645, 123456789]],
    ['1970-01-01T00:00:00Z', [0, 0]],
    ['1969-12-31T23:59:59Z', [-1, 0]],
  ])('%s', (iso, expected) => {
    expect(datetimeToParts(iso)).toEqual(expected);
  });

  it('keeps an offset instant on the same timeline', () => {
    expect(datetimeToParts('2024-01-02T05:04:05+02:00')).toEqual([1704164645, 0]);
  });

  it('round-trips through both directions', () => {
    for (const iso of [
      '2024-01-02T03:04:05Z',
      '2024-01-02T03:04:05.123456789Z',
      '1969-12-31T23:59:59Z',
    ]) {
      const [seconds, nanos] = datetimeToParts(iso);
      expect(partsToDatetime(seconds, nanos)).toBe(iso);
    }
  });

  it('rejects text that is not an instant', () => {
    expect(() => datetimeToParts('not a date')).toThrow(/Unparseable datetime/);
  });
});

describe('duration parts', () => {
  it.each([
    ['1h30m', [5400, 0]],
    ['1h30m250ms', [5400, 250000000]],
    ['500ms', [0, 500000000]],
    ['1s500ms', [1, 500000000]],
    ['1500ms', [1, 500000000]],
    ['1y', [31536000, 0]],
    ['2w3d', [1468800, 0]],
    ['100ns', [0, 100]],
  ])('%s', (text, expected) => {
    expect(durationToParts(text)).toEqual(expected);
  });

  it('accepts the micro sign as well as us', () => {
    expect(durationToParts('5µs')).toEqual(durationToParts('5us'));
  });

  it('round-trips through both directions', () => {
    for (const text of ['1h30m', '1h30m250ms', '500ms', '1y', '100ns']) {
      const [seconds, nanos] = durationToParts(text);
      expect(partsToDuration(seconds, nanos)).toBe(text);
    }
  });

  it('renders a zero duration', () => {
    expect(partsToDuration(0, 0)).toBe('0ns');
  });

  it('rejects text it cannot account for in full', () => {
    expect(() => durationToParts('1h junk')).toThrow(/Unparseable duration/);
  });
});

describe('uuid bytes', () => {
  it('round-trips', () => {
    const text = '018e0d1e-0000-7000-8000-0000000000ff';
    expect(bytesToUuid(uuidToBytes(text))).toBe(text);
  });

  it('packs into 16 bytes', () => {
    expect(uuidToBytes('00000000-0000-0000-0000-000000000001')).toHaveLength(16);
  });

  it('rejects text of the wrong length', () => {
    expect(() => uuidToBytes('abc')).toThrow(/Unparseable uuid/);
  });

  it('rejects a byte string of the wrong length', () => {
    expect(() => bytesToUuid(new Uint8Array(4))).toThrow(/needs 16 bytes/);
  });
});
