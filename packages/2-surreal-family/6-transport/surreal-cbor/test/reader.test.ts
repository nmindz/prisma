import { describe, expect, it } from 'vitest';
import { CborReader } from '../src/reader';

const TRUNCATED = /Truncated CBOR payload/;

describe('CborReader throws on a truncated buffer for every multi-byte read', () => {
  it('reading a byte from an empty buffer', () => {
    expect(() => new CborReader(new Uint8Array([])).byte()).toThrow(TRUNCATED);
  });

  it('reading a 1-byte argument (additional 24) with no bytes left', () => {
    expect(() => new CborReader(new Uint8Array([])).argument(24)).toThrow(TRUNCATED);
  });

  it('reading a 2-byte argument (additional 25) short by a byte', () => {
    expect(() => new CborReader(new Uint8Array([0x00])).argument(25)).toThrow(TRUNCATED);
  });

  it('reading a 4-byte argument (additional 26) short by a byte', () => {
    expect(() => new CborReader(new Uint8Array([0x00, 0x00, 0x00])).argument(26)).toThrow(
      TRUNCATED,
    );
  });

  it('reading an 8-byte argument (additional 27) short by a byte', () => {
    expect(() =>
      new CborReader(new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])).argument(27),
    ).toThrow(TRUNCATED);
  });

  it('reading text longer than the buffer', () => {
    expect(() => new CborReader(new Uint8Array([0x61])).text(2)).toThrow(TRUNCATED);
  });

  it('slicing more bytes than the buffer holds', () => {
    expect(() => new CborReader(new Uint8Array([0x01])).slice(2)).toThrow(TRUNCATED);
  });

  it('reading a half-precision float short by a byte', () => {
    expect(() => new CborReader(new Uint8Array([0x00])).half()).toThrow(TRUNCATED);
  });

  it('reading a single-precision float short by a byte', () => {
    expect(() => new CborReader(new Uint8Array([0x00, 0x00, 0x00])).single()).toThrow(TRUNCATED);
  });

  it('reading a double-precision float short by a byte', () => {
    expect(() =>
      new CborReader(new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])).double(),
    ).toThrow(TRUNCATED);
  });
});

describe('CborReader.remaining', () => {
  it('reports how many bytes are left as reads consume the buffer', () => {
    const reader = new CborReader(new Uint8Array([1, 2, 3]));
    expect(reader.remaining).toBe(3);
    reader.byte();
    expect(reader.remaining).toBe(2);
  });
});
