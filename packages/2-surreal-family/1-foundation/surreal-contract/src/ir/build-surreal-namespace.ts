import {
  freezeNode,
  hydrateNamespaceEntities,
  NamespaceBase,
  UNBOUND_NAMESPACE_ID,
} from '@internal/framework-components/ir';
import { blindCast } from '@internal/utils/casts';
import { composeSurrealEntityKinds } from '../entity-kinds';
import type { SurrealAnalyzer } from './surreal-analyzer';
import type {
  SurrealNamespace,
  SurrealNamespaceEntries,
  SurrealNamespaceTablesInput,
} from './surreal-storage';
import type { SurrealTable } from './surreal-table';
import { SurrealUnboundNamespace } from './surreal-unbound-namespace';

const SURREAL_NAMESPACE_KIND = 'surreal-namespace' as const;

class SurrealBoundNamespace extends NamespaceBase {
  declare readonly kind: string;

  readonly id: string;
  readonly entries: SurrealNamespaceEntries;

  static fromTablesInput(input: SurrealNamespaceTablesInput): SurrealNamespace {
    const tableMap = input.entries['table'];
    const tableCount = tableMap !== undefined ? Object.keys(tableMap).length : 0;
    const hasOtherKinds = Object.keys(input.entries).some((kind) => kind !== 'table');
    if (input.id === UNBOUND_NAMESPACE_ID && tableCount === 0 && !hasOtherKinds) {
      return SurrealUnboundNamespace.instance;
    }
    return new SurrealBoundNamespace(input);
  }

  private constructor(input: SurrealNamespaceTablesInput) {
    super();
    this.id = input.id;

    const rawEntries: Record<string, Readonly<Record<string, unknown>>> = {
      table: {},
      ...input.entries,
    };
    this.entries = Object.freeze(
      blindCast<
        SurrealNamespaceEntries,
        'composeSurrealEntityKinds() supplies the table→SurrealTable and analyzer→SurrealAnalyzer descriptors, so this open-dict result holds the typed members SurrealNamespaceEntries declares; the descriptor Map erases those per-kind Node types from the return.'
      >(hydrateNamespaceEntities(rawEntries, composeSurrealEntityKinds(), 'carry')),
    );
    Object.defineProperty(this, 'kind', {
      value: SURREAL_NAMESPACE_KIND,
      writable: false,
      enumerable: false,
      configurable: true,
    });
    freezeNode(this);
  }

  get table(): Readonly<Record<string, SurrealTable>> {
    return this.entries.table ?? Object.freeze({});
  }

  get analyzer(): Readonly<Record<string, SurrealAnalyzer>> {
    return this.entries.analyzer ?? Object.freeze({});
  }
}

export function buildSurrealNamespace(input: SurrealNamespaceTablesInput): SurrealNamespace {
  return SurrealBoundNamespace.fromTablesInput(input);
}
