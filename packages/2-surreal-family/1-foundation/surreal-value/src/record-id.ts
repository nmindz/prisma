import { SURREAL_KIND, surrealKind } from './kind';

/**
 * The identifier part of a SurrealDB record id — the piece after the colon in
 * `person:alice`.
 *
 * SurrealDB accepts four shapes here. A string or a number is the everyday
 * case; an array or an object is a *complex* id, which SurrealDB orders
 * lexicographically and which callers use to give a record a natural
 * composite key instead of a surrogate one.
 */
export type RecordIdPart =
  | string
  | number
  | bigint
  | readonly RecordIdPart[]
  | { readonly [key: string]: RecordIdPart };

/**
 * A SurrealDB record id: the `table:id` pair that identifies one record.
 *
 * Record ids are the closest thing SurrealDB has to a foreign key. A field
 * declared `record<person>` holds one of these, and a graph edge stores two
 * (`in` and `out`), which is why the value model needs a first-class type for
 * it rather than treating `"person:alice"` as an opaque string: the string
 * form is ambiguous once a table name or an id part contains a colon.
 *
 * Instances are frozen on construction — a record id that changed underneath
 * a lowered statement would change the statement's meaning after its
 * parameters were collected.
 */
export class RecordId {
  readonly [SURREAL_KIND] = 'record-id' as const;
  readonly tableName: string;
  readonly id: RecordIdPart;

  constructor(tableName: string, id: RecordIdPart) {
    this.tableName = tableName;
    this.id = id;
    Object.freeze(this);
  }

  /**
   * Parses the `table:id` wire form SurrealDB returns under the JSON
   * protocol. Splits on the *first* colon, because a table name cannot
   * contain one unescaped while an id part can.
   *
   * Returns `undefined` rather than throwing when `text` carries no colon, so
   * a decoder can fall through to treating the value as a plain string.
   */
  static parse(text: string): RecordId | undefined {
    const separator = text.indexOf(':');
    if (separator <= 0 || separator === text.length - 1) {
      return undefined;
    }
    return new RecordId(text.slice(0, separator), text.slice(separator + 1));
  }

  toString(): string {
    return `${this.tableName}:${String(this.id)}`;
  }

  toJSON(): string {
    return this.toString();
  }
}

/**
 * Recognises a record id from any copy of this module — see {@link SURREAL_KIND}
 * for why `instanceof` cannot be used here.
 */
export function isRecordId(value: unknown): value is RecordId {
  return surrealKind(value) === 'record-id';
}
