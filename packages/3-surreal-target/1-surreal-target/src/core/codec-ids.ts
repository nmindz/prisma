/**
 * Codec ids for the SurrealDB target.
 *
 * One per SurrealQL scalar the target ships. Ids are versioned so a change in
 * a codec's wire behaviour is a new id rather than a silent reinterpretation
 * of data already written under the old one.
 */
export const SURREAL_ANY_CODEC_ID = 'surrealdb/any@1';
export const SURREAL_BOOL_CODEC_ID = 'surrealdb/bool@1';
export const SURREAL_BYTES_CODEC_ID = 'surrealdb/bytes@1';
export const SURREAL_DATETIME_CODEC_ID = 'surrealdb/datetime@1';
export const SURREAL_DECIMAL_CODEC_ID = 'surrealdb/decimal@1';
export const SURREAL_DURATION_CODEC_ID = 'surrealdb/duration@1';
export const SURREAL_FLOAT_CODEC_ID = 'surrealdb/float@1';
export const SURREAL_GEOMETRY_CODEC_ID = 'surrealdb/geometry@1';
export const SURREAL_INT_CODEC_ID = 'surrealdb/int@1';
export const SURREAL_OBJECT_CODEC_ID = 'surrealdb/object@1';
export const SURREAL_RECORD_CODEC_ID = 'surrealdb/record@1';
export const SURREAL_STRING_CODEC_ID = 'surrealdb/string@1';
export const SURREAL_UUID_CODEC_ID = 'surrealdb/uuid@1';

export const surrealCodecIds = [
  SURREAL_ANY_CODEC_ID,
  SURREAL_BOOL_CODEC_ID,
  SURREAL_BYTES_CODEC_ID,
  SURREAL_DATETIME_CODEC_ID,
  SURREAL_DECIMAL_CODEC_ID,
  SURREAL_DURATION_CODEC_ID,
  SURREAL_FLOAT_CODEC_ID,
  SURREAL_GEOMETRY_CODEC_ID,
  SURREAL_INT_CODEC_ID,
  SURREAL_OBJECT_CODEC_ID,
  SURREAL_RECORD_CODEC_ID,
  SURREAL_STRING_CODEC_ID,
  SURREAL_UUID_CODEC_ID,
] as const;

export type SurrealCodecId = (typeof surrealCodecIds)[number];
