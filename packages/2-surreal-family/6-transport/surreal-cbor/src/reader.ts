import { InternalError } from '@internal/utils/internal-error';

/** Decodes the half-precision floats SurrealDB uses for geometry coordinates. */
export function float16(bits: number): number {
  const exponent = (bits & 0x7c00) >> 10;
  const fraction = bits & 0x03ff;
  const sign = bits & 0x8000 ? -1 : 1;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 0x1f) return fraction === 0 ? sign * Number.POSITIVE_INFINITY : Number.NaN;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

/** Hoisted: constructing one per string dominated the decoder's cost. */
const TEXT_DECODER = new TextDecoder();

export class CborReader {
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  private offset = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get done(): boolean {
    return this.offset >= this.bytes.length;
  }

  private need(count: number): void {
    if (this.offset + count > this.bytes.length) {
      throw new InternalError('Truncated CBOR payload from SurrealDB');
    }
  }

  byte(): number {
    this.need(1);
    const value = this.bytes[this.offset];
    this.offset += 1;
    if (value === undefined) throw new InternalError('Truncated CBOR payload from SurrealDB');
    return value;
  }

  /**
   * Reads a header's argument. Returns a `bigint` only when the value exceeds
   * `Number.MAX_SAFE_INTEGER`, so ordinary lengths and counts stay numbers.
   */
  argument(additional: number): number | bigint {
    if (additional < 24) return additional;
    if (additional === 24) return this.byte();
    if (additional === 25) {
      this.need(2);
      const value = this.view.getUint16(this.offset);
      this.offset += 2;
      return value;
    }
    if (additional === 26) {
      this.need(4);
      const value = this.view.getUint32(this.offset);
      this.offset += 4;
      return value;
    }
    if (additional === 27) {
      this.need(8);
      const value = this.view.getBigUint64(this.offset);
      this.offset += 8;
      return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
    }
    throw new InternalError(`Unsupported CBOR additional information ${additional}`);
  }

  /**
   * Reads `length` bytes as UTF-8, without the intermediate copy `slice` makes:
   * the decoder is handed a view, and it copies into the string itself.
   */
  text(length: number): string {
    this.need(length);
    const value = TEXT_DECODER.decode(this.bytes.subarray(this.offset, this.offset + length));
    this.offset += length;
    return value;
  }

  slice(length: number): Uint8Array {
    this.need(length);
    const value = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  half(): number {
    this.need(2);
    const bits = this.view.getUint16(this.offset);
    this.offset += 2;
    return float16(bits);
  }

  single(): number {
    this.need(4);
    const value = this.view.getFloat32(this.offset);
    this.offset += 4;
    return value;
  }

  double(): number {
    this.need(8);
    const value = this.view.getFloat64(this.offset);
    this.offset += 8;
    return value;
  }
}
