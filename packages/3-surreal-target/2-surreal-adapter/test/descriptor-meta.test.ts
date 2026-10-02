import { describe, expect, it } from 'vitest';
import surrealControlAdapterDescriptor from '../src/core/control-adapter';
import { surrealAdapterDescriptorMeta } from '../src/core/descriptor-meta';
import surrealRuntimeAdapterDescriptor from '../src/core/runtime-adapter';

describe('surrealAdapterDescriptorMeta capabilities', () => {
  it('declares the SurrealDB-engine and surreal-family capability facts', () => {
    expect(surrealAdapterDescriptorMeta.capabilities).toEqual({
      surrealdb: {
        createReturnsRecord: true,
        upsertByRecordId: true,
        referenceOnDelete: true,
        graphEdges: true,
        sequences: true,
      },
      surreal: {
        upsertByUniqueIndex: true,
      },
    });
  });
});

describe('capability declaration survives descriptor composition', () => {
  it('spreads unchanged into the control adapter descriptor', () => {
    expect(surrealControlAdapterDescriptor.capabilities).toEqual(
      surrealAdapterDescriptorMeta.capabilities,
    );
  });

  it('spreads unchanged into the runtime adapter descriptor', () => {
    expect(surrealRuntimeAdapterDescriptor.capabilities).toEqual(
      surrealAdapterDescriptorMeta.capabilities,
    );
  });
});
