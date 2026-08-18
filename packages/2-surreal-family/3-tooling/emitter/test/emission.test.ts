import type { Contract } from '@internal/contract/types';
import { buildSurrealNamespace, SurrealTable } from '@internal/surreal-contract';
import { blindCast } from '@internal/utils/casts';
import { describe, expect, it } from 'vitest';
import { surrealEmission } from '../src/exports/index';

function contractWith(options: {
  readonly tables?: Record<string, SurrealTable>;
  readonly models?: Record<string, unknown>;
}): Contract {
  return blindCast<Contract, 'a minimal contract literal shaped for the emission SPI under test'>({
    targetFamily: 'surreal',
    roots: {},
    domain: { namespaces: { __unbound__: { models: options.models ?? {} } } },
    storage: {
      storageHash: 'sh',
      namespaces: {
        __unbound__: buildSurrealNamespace({
          id: '__unbound__',
          entries: { table: options.tables ?? {} },
        }),
      },
    },
  });
}

describe('surrealEmission.generateStorageType', () => {
  it('renders an empty namespace as a never-record', () => {
    expect(surrealEmission.generateStorageType(contractWith({}), 'StorageHash')).toBe(
      // Keys are quoted only when they need to be, which `__unbound__` does not.
      '{ readonly namespaces: { readonly __unbound__: { readonly id: "__unbound__"; readonly entries: { readonly table: Record<string, never>; readonly analyzer: Record<string, never> } } }; readonly storageHash: StorageHash }',
    );
  });

  it('names each declared table in the emitted type', () => {
    const type = surrealEmission.generateStorageType(
      contractWith({
        tables: {
          person: new SurrealTable({
            fields: [{ name: 'name', type: { kind: 'scalar', name: 'string' }, codecId: 'c' }],
          }),
        },
      }),
      'StorageHash',
    );
    expect(type).toContain('readonly person:');
    expect(type).toContain('"name"');
  });

  it('omits the runtime kind discriminator, which the contract JSON never carries', () => {
    const type = surrealEmission.generateStorageType(
      contractWith({ tables: { person: new SurrealTable() } }),
      'StorageHash',
    );
    expect(type).not.toContain('surreal-table');
  });

  it('sorts tables so the emitted type is stable across contract key order', () => {
    const type = surrealEmission.generateStorageType(
      contractWith({ tables: { zeta: new SurrealTable(), alpha: new SurrealTable() } }),
      'StorageHash',
    );
    expect(type.indexOf('alpha')).toBeLessThan(type.indexOf('zeta'));
  });
});

describe('surrealEmission.generateModelStorageType', () => {
  const model = (storage: Record<string, unknown>) =>
    blindCast<Parameters<typeof surrealEmission.generateModelStorageType>[1], 'model literal'>({
      fields: {},
      storage,
    });

  it('renders a never-record when the model maps onto nothing', () => {
    expect(surrealEmission.generateModelStorageType('M', model({}))).toBe('Record<string, never>');
  });

  it('renders the table a model is stored in', () => {
    expect(surrealEmission.generateModelStorageType('M', model({ table: 'person' }))).toBe(
      '{ readonly table: "person" }',
    );
  });

  it('renders record links and graph edges', () => {
    const type = surrealEmission.generateModelStorageType(
      'Post',
      model({
        table: 'post',
        links: { author: { field: 'author' } },
        edges: { tags: { table: 'tagged', direction: 'out' } },
      }),
    );
    expect(type).toContain('readonly links');
    expect(type).toContain('readonly edges');
  });
});

describe('surrealEmission.validateTypes', () => {
  it('accepts a model whose table is declared', () => {
    expect(() =>
      surrealEmission.validateTypes(
        contractWith({
          tables: { person: new SurrealTable() },
          models: { Person: { fields: {}, storage: { table: 'person' } } },
        }),
      ),
    ).not.toThrow();
  });

  it('rejects a model naming a table the storage block never declares', () => {
    expect(() =>
      surrealEmission.validateTypes(
        contractWith({ models: { Person: { fields: {}, storage: { table: 'ghost' } } } }),
      ),
    ).toThrow(/references table "ghost"/);
  });

  it('rejects a model with no fields map', () => {
    expect(() =>
      surrealEmission.validateTypes(contractWith({ models: { Person: { storage: {} } } })),
    ).toThrow(/missing required field "fields"/);
  });

  it('accepts a model that maps onto no table at all', () => {
    expect(() =>
      surrealEmission.validateTypes(
        contractWith({ models: { Person: { fields: {}, storage: {} } } }),
      ),
    ).not.toThrow();
  });
});

describe('surrealEmission wiring', () => {
  it('identifies itself as the surreal family', () => {
    expect(surrealEmission.id).toBe('surreal');
  });

  it('imports its contract surface through the resolver, not a hard-coded specifier', () => {
    const lines = surrealEmission.getFamilyImports((specifier) => `@prisma/shell/${specifier}`);
    expect(lines.join('\n')).toContain('@prisma/shell/@internal/surreal-contract');
  });

  it('wraps the contract in the family type-maps carrier', () => {
    expect(surrealEmission.getContractWrapper('ContractBase', 'TypeMaps')).toBe(
      'export type Contract = SurrealContractWithTypeMaps<ContractBase, TypeMaps>;',
    );
    expect(surrealEmission.getTypeMapsExpression()).toBe(
      'SurrealTypeMaps<CodecTypes, FieldOutputTypes, FieldInputTypes>',
    );
  });
});
