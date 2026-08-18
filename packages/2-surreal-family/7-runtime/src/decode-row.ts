import type { CodecCallContext, CodecLookup } from '@internal/framework-components/codec';
import { runtimeError } from '@internal/framework-components/runtime';
import type { SurrealFieldShape, SurrealResultShape } from '@internal/surreal-query-ast/plan';
import { RecordId } from '@internal/surreal-value';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function decodeLeaf(
  value: unknown,
  codecId: string,
  codecs: CodecLookup,
  ctx: CodecCallContext,
): Promise<unknown> {
  const codec = codecs.get(codecId);
  if (codec === undefined) {
    throw runtimeError(
      'RUNTIME.CODEC_DESCRIPTOR_MISSING',
      `No codec registered for id '${codecId}'`,
      { codecId },
    );
  }
  return codec.decode(value, ctx);
}

/**
 * Decodes a record-link field.
 *
 * The same declared `record<person>` arrives two ways: as the record-id
 * string `"person:alice"` normally, and as a nested object once the query
 * said `FETCH author`. Deciding per value rather than per field is what lets
 * one contract serve both — a shape that guessed from the declaration alone
 * would be wrong for whichever of the two the caller did not use.
 */
async function decodeLink(
  value: unknown,
  shape: Extract<SurrealFieldShape, { kind: 'link' }>,
  codecs: CodecLookup,
  ctx: CodecCallContext,
): Promise<unknown> {
  if (isRecord(value)) {
    if (shape.fetched === undefined) return value;
    return decodeFields(value, shape.fetched, codecs, ctx);
  }
  if (typeof value === 'string') {
    const parsed = RecordId.parse(value);
    return parsed ?? decodeLeaf(value, shape.codecId, codecs, ctx);
  }
  return decodeLeaf(value, shape.codecId, codecs, ctx);
}

async function decodeField(
  value: unknown,
  shape: SurrealFieldShape,
  codecs: CodecLookup,
  ctx: CodecCallContext,
): Promise<unknown> {
  // SurrealDB renders both NONE and NULL as JSON null under the json
  // subprotocol, so an absent field and an explicitly empty one are
  // indistinguishable here. Neither is passed to a codec.
  if (value === null || value === undefined) return null;
  switch (shape.kind) {
    case 'unknown':
      return value;
    case 'leaf':
      return decodeLeaf(value, shape.codecId, codecs, ctx);
    case 'link':
      return decodeLink(value, shape, codecs, ctx);
    case 'array': {
      if (!Array.isArray(value)) return value;
      return Promise.all(value.map((item) => decodeField(item, shape.element, codecs, ctx)));
    }
    case 'record':
      return isRecord(value) ? decodeFields(value, shape.fields, codecs, ctx) : value;
    default: {
      const exhaustive: never = shape;
      return exhaustive;
    }
  }
}

async function decodeFields(
  row: Record<string, unknown>,
  fields: Readonly<Record<string, SurrealFieldShape>>,
  codecs: CodecLookup,
  ctx: CodecCallContext,
): Promise<Record<string, unknown>> {
  const decoded: Record<string, unknown> = {};
  const pending: Promise<void>[] = [];
  for (const [name, value] of Object.entries(row)) {
    const shape = fields[name];
    if (shape === undefined) {
      decoded[name] = value;
      continue;
    }
    pending.push(
      decodeField(value, shape, codecs, ctx).then((result) => {
        decoded[name] = result;
      }),
    );
  }
  await Promise.all(pending);
  return decoded;
}

/**
 * Decodes one row against the plan's result shape. A row whose shape is
 * `unknown` passes through untouched — that is the raw lane's contract.
 */
export async function decodeSurrealRow(
  row: unknown,
  shape: SurrealResultShape,
  codecs: CodecLookup,
  ctx: CodecCallContext,
): Promise<unknown> {
  switch (shape.kind) {
    case 'unknown':
      return row;
    case 'value':
      return decodeField(row, shape.element, codecs, ctx);
    default:
      return isRecord(row) ? decodeFields(row, shape.fields, codecs, ctx) : row;
  }
}
