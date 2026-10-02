import type {
  AuthoringFieldNamespace,
  AuthoringTypeNamespace,
} from '@internal/framework-components/authoring';
import {
  SURREAL_DATETIME_CODEC_ID,
  SURREAL_DECIMAL_CODEC_ID,
  SURREAL_DURATION_CODEC_ID,
  SURREAL_RECORD_CODEC_ID,
  SURREAL_UUID_CODEC_ID,
} from './codec-ids';

/**
 * Type constructors a SurrealDB contract can name. Each maps an authoring
 * name onto the codec that carries it and the SurrealQL native type it
 * declares.
 */
export const surrealAuthoringTypes = {
  Decimal: {
    kind: 'typeConstructor',
    output: { codecId: SURREAL_DECIMAL_CODEC_ID, nativeType: 'decimal' },
  },
  Duration: {
    kind: 'typeConstructor',
    output: { codecId: SURREAL_DURATION_CODEC_ID, nativeType: 'duration' },
  },
  Uuid: {
    kind: 'typeConstructor',
    output: { codecId: SURREAL_UUID_CODEC_ID, nativeType: 'uuid' },
  },
  RecordLink: {
    kind: 'typeConstructor',
    output: { codecId: SURREAL_RECORD_CODEC_ID, nativeType: 'record' },
  },
} as const satisfies AuthoringTypeNamespace;

export const surrealAuthoringFieldPresets = {
  temporal: {
    datetime: {
      kind: 'fieldPreset',
      output: { codecId: SURREAL_DATETIME_CODEC_ID, nativeType: 'datetime' },
    },
  },
} as const satisfies AuthoringFieldNamespace;
