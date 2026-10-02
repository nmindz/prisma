import { describe, expect, it } from 'vitest';
import { surrealCodecDescriptors } from '../src/core/codecs';
import { surrealDataTypeEntries } from '../src/core/data-type-entries';
import { surrealDataTypes } from '../src/core/data-types';
import surrealTargetPack from '../src/exports/pack';

/** Every codec this pack ships and the data type it represents (ADR 254). */
const EXPECTED: Readonly<Record<string, string>> = {
  'surrealdb/string@1': 'surrealdb/string',
  'surrealdb/bool@1': 'surrealdb/bool',
  'surrealdb/int@1': 'surrealdb/int',
  'surrealdb/float@1': 'surrealdb/float',
  'surrealdb/number@1': 'surrealdb/number',
  'surrealdb/object@1': 'surrealdb/object',
  'surrealdb/any@1': 'surrealdb/any',
  'surrealdb/geometry@1': 'surrealdb/geometry',
  'surrealdb/datetime@1': 'surrealdb/datetime',
  'surrealdb/decimal@1': 'surrealdb/decimal',
  'surrealdb/duration@1': 'surrealdb/duration',
  'surrealdb/uuid@1': 'surrealdb/uuid',
  'surrealdb/bytes@1': 'surrealdb/bytes',
  'surrealdb/record@1': 'surrealdb/record',
};

describe('SurrealDB data type inventory', () => {
  it('ships codecs to check', () => {
    expect(surrealCodecDescriptors.length).toBeGreaterThan(0);
  });

  it('names the data type of every codec it ships', () => {
    expect(
      Object.fromEntries(
        surrealCodecDescriptors.map((descriptor) => [descriptor.codecId, descriptor.dataType]),
      ),
    ).toEqual(EXPECTED);
  });

  it('registers exactly the types its codecs name', () => {
    expect(surrealDataTypes.map((dataType) => dataType.id).sort()).toEqual(
      [...new Set(Object.values(EXPECTED))].sort(),
    );
  });

  it('contributes its data types and codec descriptors to the control stack', () => {
    expect(surrealTargetPack.dataTypes).toBe(surrealDataTypes);
    expect(surrealTargetPack.types.codecTypes.codecDescriptors).toBe(surrealCodecDescriptors);
  });

  it('contributes the PSL entries of its data types to the control stack', () => {
    expect(surrealTargetPack.authoring.dataTypes).toBe(surrealDataTypeEntries);
  });
});
