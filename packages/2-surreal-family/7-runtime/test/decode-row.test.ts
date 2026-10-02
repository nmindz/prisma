import type { CodecLookup } from '@internal/framework-components/codec';
import type { SurrealFieldShape, SurrealResultShape } from '@internal/surreal-query-ast/plan';
import { RecordId, SurrealDecimal } from '@internal/surreal-value';
import { describe, expect, it } from 'vitest';
import { decodeSurrealRow } from '../src/decode-row';

const codecs: CodecLookup = {
  get: (id) => {
    if (id === 'decimal') {
      return {
        id,
        encode: async (value: unknown) => value,
        decode: async (wire: unknown) => new SurrealDecimal(String(wire)),
        encodeJson: (value: unknown) => value as never,
        decodeJson: (json: unknown) => json,
      };
    }
    if (id === 'link') {
      return {
        id,
        encode: async (value: unknown) => value,
        decode: async (wire: unknown) => wire,
        encodeJson: (value: unknown) => value as never,
        decodeJson: (json: unknown) => json,
      };
    }
    return undefined;
  },
  targetTypesFor: () => undefined,
  renderOutputTypeFor: () => undefined,
};

const leaf = (codecId: string): SurrealFieldShape => ({ kind: 'leaf', codecId, nullable: false });
const record = (fields: Record<string, SurrealFieldShape>): SurrealResultShape => ({
  kind: 'record',
  fields,
});

describe('decodeSurrealRow', () => {
  it('passes a row through untouched when the shape is unknown', async () => {
    const row = { anything: 1 };
    expect(await decodeSurrealRow(row, { kind: 'unknown' }, codecs, {})).toBe(row);
  });

  it('decodes a leaf field through its codec', async () => {
    const decoded = await decodeSurrealRow(
      { balance: '12.34' },
      record({ balance: leaf('decimal') }),
      codecs,
      {},
    );
    expect(decoded).toEqual({ balance: new SurrealDecimal('12.34') });
  });

  it('leaves a field the shape does not mention alone', async () => {
    expect(
      await decodeSurrealRow({ extra: 'x' }, record({ balance: leaf('decimal') }), codecs, {}),
    ).toEqual({ extra: 'x' });
  });

  it('reads null as null without consulting a codec', async () => {
    expect(
      await decodeSurrealRow({ balance: null }, record({ balance: leaf('decimal') }), codecs, {}),
    ).toEqual({ balance: null });
  });

  it('names the missing codec rather than decoding silently wrong', async () => {
    await expect(
      decodeSurrealRow({ x: 1 }, record({ x: leaf('nope') }), codecs, {}),
    ).rejects.toThrow(/No codec registered for id 'nope'/);
  });

  it('decodes each element of an array field', async () => {
    expect(
      await decodeSurrealRow(
        { amounts: ['1.5', '2.5'] },
        record({ amounts: { kind: 'array', nullable: false, element: leaf('decimal') } }),
        codecs,
        {},
      ),
    ).toEqual({ amounts: [new SurrealDecimal('1.5'), new SurrealDecimal('2.5')] });
  });

  it('decodes a nested record shape', async () => {
    expect(
      await decodeSurrealRow(
        { meta: { balance: '3.5' } },
        record({
          meta: { kind: 'record', nullable: false, fields: { balance: leaf('decimal') } },
        }),
        codecs,
        {},
      ),
    ).toEqual({ meta: { balance: new SurrealDecimal('3.5') } });
  });

  it('decodes SELECT VALUE rows, which are bare values', async () => {
    expect(
      await decodeSurrealRow('9.99', { kind: 'value', element: leaf('decimal') }, codecs, {}),
    ).toEqual(new SurrealDecimal('9.99'));
  });

  describe('record links', () => {
    const shape = (fetched?: Record<string, SurrealFieldShape>): SurrealResultShape =>
      record({
        author: {
          kind: 'link',
          nullable: false,
          codecId: 'link',
          ...(fetched === undefined ? {} : { fetched }),
        },
      });

    it('parses an unfetched link into a RecordId', async () => {
      expect(await decodeSurrealRow({ author: 'person:alice' }, shape(), codecs, {})).toEqual({
        author: new RecordId('person', 'alice'),
      });
    });

    it('decodes a fetched link against its record shape', async () => {
      expect(
        await decodeSurrealRow(
          { author: { balance: '1.25' } },
          shape({ balance: leaf('decimal') }),
          codecs,
          {},
        ),
      ).toEqual({ author: { balance: new SurrealDecimal('1.25') } });
    });

    it('passes a fetched link through when the shape describes no fields', async () => {
      const author = { name: 'alice' };
      expect(await decodeSurrealRow({ author }, shape(), codecs, {})).toEqual({ author });
    });

    it('falls back to the codec when the string is not a record id', async () => {
      expect(await decodeSurrealRow({ author: 'not-an-id' }, shape(), codecs, {})).toEqual({
        author: 'not-an-id',
      });
    });
  });
});
