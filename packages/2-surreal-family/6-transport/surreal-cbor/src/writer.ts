/** A growable output buffer. Doubling beats `[...spread]` on every hot path. */
export class CborWriter {
  private buffer: Uint8Array;
  private view: DataView;
  private offset = 0;

  constructor(initialSize = 256) {
    this.buffer = new Uint8Array(initialSize);
    this.view = new DataView(this.buffer.buffer);
  }

  private reserve(extra: number): void {
    const needed = this.offset + extra;
    if (needed <= this.buffer.length) return;
    let size = this.buffer.length * 2;
    while (size < needed) size *= 2;
    const grown = new Uint8Array(size);
    grown.set(this.buffer.subarray(0, this.offset));
    this.buffer = grown;
    this.view = new DataView(grown.buffer);
  }

  byte(value: number): void {
    this.reserve(1);
    this.buffer[this.offset++] = value;
  }

  bytes(value: Uint8Array): void {
    this.reserve(value.length);
    this.buffer.set(value, this.offset);
    this.offset += value.length;
  }

  /**
   * Writes a major type and its argument in the shortest form CBOR allows.
   * Canonical-length encoding is not merely tidy: SurrealDB's own encoder
   * emits it, so matching it keeps a re-encoded value byte-identical to the
   * one that arrived.
   */
  head(major: number, argument: number | bigint): void {
    const base = major << 5;
    if (typeof argument === 'bigint') {
      if (argument < 0x100000000n) {
        this.head(major, Number(argument));
        return;
      }
      this.reserve(9);
      this.buffer[this.offset++] = base | 27;
      this.view.setBigUint64(this.offset, argument);
      this.offset += 8;
      return;
    }
    if (argument < 24) {
      this.byte(base | argument);
      return;
    }
    if (argument < 0x100) {
      this.reserve(2);
      this.buffer[this.offset++] = base | 24;
      this.buffer[this.offset++] = argument;
      return;
    }
    if (argument < 0x10000) {
      this.reserve(3);
      this.buffer[this.offset++] = base | 25;
      this.view.setUint16(this.offset, argument);
      this.offset += 2;
      return;
    }
    if (argument < 0x100000000) {
      this.reserve(5);
      this.buffer[this.offset++] = base | 26;
      this.view.setUint32(this.offset, argument);
      this.offset += 4;
      return;
    }
    this.reserve(9);
    this.buffer[this.offset++] = base | 27;
    this.view.setBigUint64(this.offset, BigInt(argument));
    this.offset += 8;
  }

  float64(value: number): void {
    this.reserve(9);
    this.buffer[this.offset++] = 0xfb;
    this.view.setFloat64(this.offset, value);
    this.offset += 8;
  }

  take(): Uint8Array {
    return this.buffer.subarray(0, this.offset);
  }
}
