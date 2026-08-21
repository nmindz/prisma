import { computeStorageHash } from '@internal/contract/hashing';
import { hydrateNamespaceEntities } from '@internal/framework-components/ir';
import { describe, expect, it } from 'vitest';
import {
  buildSurrealNamespace,
  composeSurrealEntityKinds,
  SurrealSequence,
  tableEntityKind,
} from '../src/exports/index';

describe('SurrealSequence', () => {
  it('constructs with no optional fields', () => {
    const node = new SurrealSequence({});
    expect(node.kind).toBe('surreal-sequence');
    expect(Object.hasOwn(node, 'batch')).toBe(false);
    expect(Object.hasOwn(node, 'start')).toBe(false);
    expect(Object.hasOwn(node, 'timeout')).toBe(false);
    expect(Object.isFrozen(node)).toBe(true);
  });

  it('constructs with only batch', () => {
    const node = new SurrealSequence({ batch: 1000 });
    expect(node.kind).toBe('surreal-sequence');
    expect(node.batch).toBe(1000);
    expect(Object.hasOwn(node, 'start')).toBe(false);
    expect(Object.hasOwn(node, 'timeout')).toBe(false);
  });

  it('constructs with only start', () => {
    const node = new SurrealSequence({ start: 100 });
    expect(node.kind).toBe('surreal-sequence');
    expect(node.start).toBe(100);
    expect(Object.hasOwn(node, 'batch')).toBe(false);
    expect(Object.hasOwn(node, 'timeout')).toBe(false);
  });

  it('constructs with only timeout', () => {
    const node = new SurrealSequence({ timeout: '5s' });
    expect(node.kind).toBe('surreal-sequence');
    expect(node.timeout).toBe('5s');
    expect(Object.hasOwn(node, 'batch')).toBe(false);
    expect(Object.hasOwn(node, 'start')).toBe(false);
  });

  it('constructs with batch, start, and timeout together', () => {
    const node = new SurrealSequence({ batch: 1000, start: 1, timeout: '5s' });
    expect(node.kind).toBe('surreal-sequence');
    expect(node.batch).toBe(1000);
    expect(node.start).toBe(1);
    expect(node.timeout).toBe('5s');
  });

  it('is frozen — mutation throws in strict mode', () => {
    const node = new SurrealSequence({ batch: 1000 });
    expect(() => {
      (node as { batch: number }).batch = 2000;
    }).toThrow();
  });

  it('kind is non-enumerable and does not survive JSON round-trip', () => {
    const node = new SurrealSequence({ batch: 1000, start: 1, timeout: '5s' });
    const json = JSON.parse(JSON.stringify(node)) as Record<string, unknown>;
    expect(json).toEqual({ batch: 1000, start: 1, timeout: '5s' });
    expect('kind' in json).toBe(false);
  });
});

describe('buildSurrealNamespace — sequence entries', () => {
  it('surfaces a declared sequence as a SurrealSequence via .sequence', () => {
    const namespace = buildSurrealNamespace({
      id: 'main',
      entries: {
        table: {},
        sequence: { userIds: { batch: 1000, start: 1, timeout: '5s' } },
      },
    });

    expect(namespace.entries.sequence?.['userIds']).toBeInstanceOf(SurrealSequence);
    expect(namespace.entries.sequence).toEqual({
      userIds: new SurrealSequence({ batch: 1000, start: 1, timeout: '5s' }),
    });
  });
});

describe('storageHash — sequence-free contracts are unaffected', () => {
  it('registering the sequence kind does not change the hash of a sequence-free namespace', () => {
    // Both sides hydrate the SAME raw entries through hydrateNamespaceEntities — the only
    // difference is whether the entity-kind registry knows about "sequence" at all. Since
    // hydrateNamespaceEntities iterates over the raw entries' own keys (never over every
    // registered kind), a registry that also knows "sequence" produces byte-identical output
    // to one that only knows "table", as long as the raw entries never mention "sequence".
    const rawEntries = { table: { person: { fields: [], indexes: [] } } };

    const withSequenceAwareRegistry = hydrateNamespaceEntities(
      rawEntries,
      composeSurrealEntityKinds(),
      'carry',
    );
    const withTableOnlyRegistry = hydrateNamespaceEntities(
      rawEntries,
      new Map([['table', tableEntityKind]]),
      'carry',
    );

    const hashWithSequenceKindRegistered = computeStorageHash({
      target: 'surrealdb',
      targetFamily: 'surreal',
      storage: {
        namespaces: { main: { id: 'main', entries: withSequenceAwareRegistry } },
      },
    });
    const hashWithoutSequenceKindRegistered = computeStorageHash({
      target: 'surrealdb',
      targetFamily: 'surreal',
      storage: {
        namespaces: { main: { id: 'main', entries: withTableOnlyRegistry } },
      },
    });

    expect(hashWithSequenceKindRegistered).toEqual(hashWithoutSequenceKindRegistered);
  });

  it('a sequence-bearing namespace hashes differently than an otherwise-identical sequence-free one', () => {
    const withSequence = computeStorageHash({
      target: 'surrealdb',
      targetFamily: 'surreal',
      storage: {
        namespaces: {
          main: buildSurrealNamespace({
            id: 'main',
            entries: { table: {}, sequence: { userIds: { batch: 1000 } } },
          }),
        },
      },
    });
    const withoutSequence = computeStorageHash({
      target: 'surrealdb',
      targetFamily: 'surreal',
      storage: {
        namespaces: { main: buildSurrealNamespace({ id: 'main', entries: { table: {} } }) },
      },
    });

    expect(withSequence).not.toBe(withoutSequence);
  });
});
