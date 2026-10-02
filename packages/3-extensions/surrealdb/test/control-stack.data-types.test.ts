import surrealAdapter from '@internal/adapter-surrealdb/control';
import surrealDriver from '@internal/driver-surrealdb/control';
import { surrealFamilyDescriptor } from '@internal/family-surreal/control';
import { createControlStack } from '@internal/framework-components/control';
import { surrealCodecIds } from '@internal/target-surrealdb/codec-ids';
import surrealTarget from '@internal/target-surrealdb/control';
import { describe, expect, it } from 'vitest';

function surrealControlStack() {
  return createControlStack({
    family: surrealFamilyDescriptor,
    target: surrealTarget,
    adapter: surrealAdapter,
    driver: surrealDriver,
  });
}

describe('SurrealDB control stack data types', () => {
  it('assembles without data type errors', () => {
    expect(surrealControlStack).not.toThrow();
  });

  it('resolves every SurrealDB codec to a registered data type', () => {
    const stack = surrealControlStack();
    for (const codecId of surrealCodecIds) {
      const descriptor = stack.codecLookup.descriptorFor(codecId);
      expect(descriptor, codecId).toBeDefined();
      expect(stack.dataTypeLookup.get(descriptor?.dataType ?? ''), codecId).toBeDefined();
    }
  });
});
