import { type DataType, dataType } from '@internal/framework-components/codec';
import type {
  ControlExtensionDescriptor,
  ControlStack,
  ControlTargetDescriptor,
} from '@internal/framework-components/control';
import { createControlStack } from '@internal/framework-components/control';
import {
  SURREAL_EXPRESSION_DATA_TYPE_ID,
  surrealExpressionAuthoringEntry,
  surrealExpressionDataType,
} from '@internal/surreal-contract';
import { surrealAttributeSpecs } from '@internal/surreal-contract-psl';
import { describe, expect, it } from 'vitest';
import { surrealFamilyDescriptor } from '../src/core/control-descriptor';
import { createSurrealFamilyInstance } from '../src/core/control-instance';
import surrealFamilyPack from '../src/exports/pack';

const stubTarget = {
  kind: 'target',
  id: 'surrealdb',
  version: '0.0.1',
  familyId: 'surreal',
  targetId: 'surrealdb',
  contractSerializer: {
    deserializeContract: (json: unknown) => json as never,
    serializeContract: (contract: unknown) => contract as never,
  },
  create: () => ({ familyId: 'surreal', targetId: 'surrealdb' }),
} as unknown as ControlTargetDescriptor<'surreal', 'surrealdb'>;

function makeStack(extensionDataTypes: readonly DataType[]): ControlStack<'surreal', 'surrealdb'> {
  const extension = {
    kind: 'extension',
    id: 'geometry-pack',
    familyId: 'surreal',
    targetId: 'surrealdb',
    version: '0.0.1',
    dataTypes: extensionDataTypes,
    create: () => ({ familyId: 'surreal', targetId: 'surrealdb' }),
  } as unknown as ControlExtensionDescriptor<'surreal', 'surrealdb'>;
  return createControlStack({
    family: surrealFamilyDescriptor,
    target: stubTarget,
    extensions: [extension],
  });
}

describe('SurrealDB family and surreal/expression', () => {
  it('registers surreal/expression and its surql entry', () => {
    expect(surrealFamilyDescriptor.dataTypes).toContain(surrealExpressionDataType);
    expect(surrealFamilyDescriptor.authoring?.dataTypes?.[SURREAL_EXPRESSION_DATA_TYPE_ID]).toBe(
      surrealExpressionAuthoringEntry,
    );
  });

  it('contributes the Surreal PSL attribute specs on the descriptor and the pack', () => {
    expect(surrealFamilyDescriptor.authoring?.attributeSpecs).toBe(surrealAttributeSpecs);
    expect(surrealFamilyPack.authoring.attributeSpecs).toBe(surrealAttributeSpecs);
  });

  it('accepts a stack whose data types do not cast from surreal/expression', () => {
    const stack = makeStack([dataType('geo/point', {})]);
    expect(() => createSurrealFamilyInstance(stack)).not.toThrow();
  });

  it('refuses a stack in which an extension type casts from surreal/expression', () => {
    const stack = makeStack([
      dataType('geo/point', { casts: { [SURREAL_EXPRESSION_DATA_TYPE_ID]: (value) => value } }),
    ]);
    expect(() => createSurrealFamilyInstance(stack)).toThrow(
      expect.objectContaining({ code: 'CONTRACT.DATA_TYPE_CASTS_FROM_SURREAL_EXPRESSION' }),
    );
  });
});
