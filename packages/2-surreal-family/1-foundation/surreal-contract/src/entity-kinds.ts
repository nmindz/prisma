import type {
  AnyEntityKindDescriptor,
  EntityKindDescriptor,
} from '@internal/framework-components/ir';
import { structuredError } from '@internal/utils/structured-error';
import { StorageAnalyzerSchema, StorageTableSchema } from './contract-schema';
import { SurrealAnalyzer, type SurrealAnalyzerInput } from './ir/surreal-analyzer';
import { SurrealTable, type SurrealTableInput } from './ir/surreal-table';

export const tableEntityKind: EntityKindDescriptor<SurrealTableInput, SurrealTable> = {
  kind: 'table',
  schema: StorageTableSchema,
  construct: (input) => new SurrealTable(input),
};

export const analyzerEntityKind: EntityKindDescriptor<SurrealAnalyzerInput, SurrealAnalyzer> = {
  kind: 'analyzer',
  schema: StorageAnalyzerSchema,
  construct: (input) => new SurrealAnalyzer(input),
};

/**
 * Assembles the `kind → descriptor` registry for SurrealDB namespaces: the
 * two built-in kinds plus any target `packKinds`. This builds the lookup
 * table — it does not touch contract data. `hydrateNamespaceEntities` later
 * consumes the registry to turn a namespace's raw entries into IR instances.
 * Throws on a duplicate kind.
 */
export function composeSurrealEntityKinds(
  packKinds: readonly AnyEntityKindDescriptor[] = [],
): ReadonlyMap<string, AnyEntityKindDescriptor> {
  const kinds = new Map<string, AnyEntityKindDescriptor>([
    ['table', tableEntityKind],
    ['analyzer', analyzerEntityKind],
  ]);
  for (const descriptor of packKinds) {
    if (kinds.has(descriptor.kind)) {
      throw structuredError(
        'CONTRACT.PACK_CONTRIBUTION_INVALID',
        `composeSurrealEntityKinds: duplicate entity kind "${descriptor.kind}" — each kind may be registered only once`,
      );
    }
    kinds.set(descriptor.kind, descriptor);
  }
  return kinds;
}
