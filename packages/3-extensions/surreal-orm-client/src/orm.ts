import type { Contract } from '@internal/contract/types';
import {
  buildSurrealContractView,
  type SurrealTable,
  unwrapOptional,
} from '@internal/surreal-contract';
import type { SurrealStorageShape } from '@internal/surreal-contract/types';
import {
  orm as buildOrmLane,
  type SurrealCollection,
  type SurrealOrm,
} from '@internal/surreal-orm';
import type { SurrealExecutionContext, SurrealRuntime } from '@internal/surreal-runtime';
import { blindCast } from '@internal/utils/casts';
import { ifDefined } from '@internal/utils/defined';
import {
  type AmbiguousEdgeRelation,
  type AmbiguousRelationLink,
  createOrmClientRepository,
  type EdgeRelationLink,
  type IncomingCascadeReference,
  type OrmClientOperationStats,
  type OrmClientRepository,
  type RelationEntry,
  type RelationLink,
} from './repository';

/**
 * Repository-layer execution surface, per
 * `docs/architecture docs/adrs/ADR 164 - Repository Layer.md` §1/§4:
 * a runtime to dispatch plans against (its `batch` is the atomic
 * multi-plan primitive §4/§6 calls for) and the execution context the
 * ORM lane's plans were built from.
 */
export interface OrmClientOptions<
  TContract extends Contract<SurrealStorageShape> = Contract<SurrealStorageShape>,
> {
  readonly runtime: SurrealRuntime;
  readonly context: SurrealExecutionContext<TContract>;
  /**
   * Optional telemetry sink threaded through, unchanged, to every table's
   * `createOrmClientRepository({ ... })` call — see
   * `OrmClientOperationStats` in `./repository` for what gets reported.
   * `orm()` never reads or interprets this itself; it is purely a pass-
   * through seam, per the "options flow in through `orm()`" rule.
   */
  readonly onOperationStats?: (stats: OrmClientOperationStats) => void;
  /**
   * Explicit table → declared-sequence-name binding, so `create` can
   * allocate a bound table's id via `idFrom.sequence` inference without the
   * caller repeating the sequence name at every call site. `SurrealSequence`
   * is deliberately namespace-level and independent of any table — the
   * contract itself carries no table→sequence link — so this association
   * must be declared here, by the application, rather than detected by a
   * naming convention: a table happening to share a name with an unrelated
   * declared sequence (e.g. always trying `${table}_seq`) would otherwise
   * silently bind to it even when the contract declared that sequence for
   * something else entirely — exactly the class of silent-wrong bug this
   * package has already had to fix. Every entry is validated against the
   * contract's own declared sequences
   * (`buildSurrealContractView(contract).sequence`) before `create` ever
   * relies on it: a table bound to a name the contract doesn't declare
   * throws `OrmClientCapabilityError` the moment inference is used (`idFrom`
   * omitted), instead of `orm()` silently dropping the misconfiguration or
   * `create` guessing a random id. An explicit `idFrom` on a call always
   * overrides this binding, valid or not. Defaults to no bindings — a table
   * absent from this map behaves exactly as it did before this option
   * existed.
   */
  readonly idSequences?: Readonly<Record<string, string>>;
}

type RepositoryFor<TCollection> =
  TCollection extends SurrealCollection<infer Row, infer Fields>
    ? OrmClientRepository<Row, Fields>
    : never;

/**
 * The repository layer's per-table read surface, per
 * `docs/architecture docs/adrs/ADR 164 - Repository Layer.md`: one
 * `OrmClientRepository` per table the ORM lane declares for this contract,
 * exposed flat and table-keyed — the same shape `SurrealOrm` itself uses —
 * rather than nested under a namespace.
 */
export type OrmClientDb<TContract extends Contract<SurrealStorageShape>> = {
  readonly [Table in keyof SurrealOrm<TContract>]: RepositoryFor<SurrealOrm<TContract>[Table]>;
};

/**
 * Builds the repository layer over a contract: one collection per declared
 * table from the ORM lane, each wrapped in a repository that dispatches
 * through `runtime` and re-tags every plan `orm-client` before it goes out.
 */
/**
 * Reads `capabilities.surrealdb.createReturnsRecord` off the contract.
 * Capability-driven rather than hardcoded on the target name, per
 * `.agents/rules/no-target-branches.mdc`: the repository layer asks what
 * the target declared, not which target it is. `contract.capabilities` is
 * declared required, but a hand-built or test-fixture contract can omit
 * the namespace entirely, so both `capabilities` and `capabilities.surrealdb`
 * are read defensively — a missing value means "not supported", same as an
 * explicit `false`.
 */
function hasCreateReturnsRecord(contract: Contract<SurrealStorageShape>): boolean {
  return contract.capabilities?.['surrealdb']?.['createReturnsRecord'] === true;
}

/**
 * Reads `capabilities.surrealdb.upsertByRecordId` off the contract — same
 * defensive bracket-access style as `hasCreateReturnsRecord`, and the same
 * "missing means unsupported" default.
 */
function hasUpsertByRecordId(contract: Contract<SurrealStorageShape>): boolean {
  return contract.capabilities?.['surrealdb']?.['upsertByRecordId'] === true;
}

/**
 * Reads `capabilities.surreal.upsertByUniqueIndex` off the contract. Lives
 * under the `surreal` family namespace, not `surrealdb` — it's a
 * family-level guarantee (unique-key UPSERT is expressible for any SurrealQL
 * target), unlike `createReturnsRecord`/`upsertByRecordId` which are
 * adapter-specific.
 */
function hasUpsertByUniqueIndex(contract: Contract<SurrealStorageShape>): boolean {
  return contract.capabilities?.['surreal']?.['upsertByUniqueIndex'] === true;
}

/**
 * Reads `capabilities.surrealdb.referenceOnDelete` off the contract — whether
 * the target engine itself enforces declared `REFERENCE ON DELETE` actions
 * (SurrealDB's own referential-integrity feature), as opposed to the ORM
 * client needing to emulate one client-side. A missing value means "not
 * enforced by the engine", the conservative reading: it's what makes an
 * unenforced `cascade` reference trigger client orchestration below, rather
 * than silently dropping the declared behavior.
 */
function hasReferenceOnDelete(contract: Contract<SurrealStorageShape>): boolean {
  return contract.capabilities?.['surrealdb']?.['referenceOnDelete'] === true;
}

/**
 * Reads `capabilities.surrealdb.graphEdges` off the contract — whether
 * nested `create` may traverse a declared graph-edge relation (`RELATE`).
 * Same defensive bracket-access, same "missing means unsupported" default
 * as the other `surrealdb` capability readers above. Edge discovery itself
 * (`edgeRelationsFor`) is unconditional — this only gates *use* of a
 * discovered edge relation inside `create`, the same split
 * `createReturnsRecord` draws between `orm()` and `create`.
 */
function hasGraphEdges(contract: Contract<SurrealStorageShape>): boolean {
  return contract.capabilities?.['surrealdb']?.['graphEdges'] === true;
}

/**
 * Reads `capabilities.surrealdb.sequences` off the contract — whether
 * `create`'s `idFrom.sequence` form (`sequence::nextval`) is usable. Same
 * defensive bracket-access, same "missing means unsupported" default as the
 * other `surrealdb` capability readers above.
 */
function hasSequences(contract: Contract<SurrealStorageShape>): boolean {
  return contract.capabilities?.['surrealdb']?.['sequences'] === true;
}

/**
 * The sequence names the contract actually declares (`entries.sequence`),
 * read the same way `uniqueIndexesFor`/`relationLinksFor` read `entries.table`
 * — this is the source of truth `idSequenceBindingFor` validates an
 * `idSequences` entry against, rather than trusting it blindly.
 */
function declaredSequenceNames(contract: Contract<SurrealStorageShape>): ReadonlySet<string> {
  const sequences = blindCast<
    Record<string, unknown>,
    "buildSurrealContractView's `.sequence` accessor is keyed by declared sequence name at runtime, same as `.table`"
  >(buildSurrealContractView(contract).sequence ?? {});
  return new Set(Object.keys(sequences));
}

/**
 * Resolves `table`'s id-sequence binding, when the caller declared one via
 * `OrmClientOptions.idSequences` — see that field's doc for why this
 * association is explicit rather than name-inferred. `declared: false`
 * means the bound name isn't actually a sequence this contract declares;
 * the repository layer still receives the binding (not `undefined`) so it
 * can throw naming exactly what's missing when inference is relied on,
 * rather than `orm()` silently treating a misconfigured table as unbound.
 */
function idSequenceBindingFor(
  contract: Contract<SurrealStorageShape>,
  table: string,
  idSequences: Readonly<Record<string, string>> | undefined,
): { readonly name: string; readonly declared: boolean } | undefined {
  const name = idSequences?.[table];
  if (name === undefined) return undefined;
  return { name, declared: declaredSequenceNames(contract).has(name) };
}

/**
 * Declared unique indexes for one table, as `[field, ...]` tuples — the
 * shape `matchesUniqueIndex` in `repository.ts` compares an `upsert`'s
 * `where` keys against. Sourced from the contract's own declared indexes
 * (`buildSurrealContractView`), never inferred from the query at runtime.
 */
function uniqueIndexesFor(
  contract: Contract<SurrealStorageShape>,
  table: string,
): ReadonlyArray<readonly string[]> {
  const tables = blindCast<
    Record<string, SurrealTable>,
    "buildSurrealContractView's `.table` accessor is keyed by declared table name at runtime; only the type-level branch (open map vs. literal keys) differs by how much the contract narrows, same as the SurrealOrm collections map below"
  >(buildSurrealContractView(contract).table);
  const indexes = tables[table]?.indexes ?? [];
  return indexes.filter((index) => index.variant.kind === 'unique').map((index) => index.fields);
}

/**
 * The other declared tables whose `record<>` field points at `table` with a
 * `reference: { kind: 'cascade' }` action — the incoming edges a `delete` on
 * `table` might need to orchestrate itself when the engine doesn't enforce
 * them (see `hasReferenceOnDelete`).
 *
 * Only `cascade` is collected: `reject`/`ignore`/`unset` are engine-only
 * semantics this client never emulates, and `then` carries an arbitrary
 * SurrealQL expression this client does not interpret — both are left to the
 * engine, capability or not. This walk is one hop only (the tables that
 * reference `table` directly); a reference declared on a table that is
 * itself only reachable transitively (A cascades into B which cascades into
 * C) is not followed from A's `delete`.
 */
function incomingCascadeReferencesFor(
  contract: Contract<SurrealStorageShape>,
  table: string,
): ReadonlyArray<{ readonly table: string; readonly field: string }> {
  const tables = blindCast<
    Record<string, SurrealTable>,
    "buildSurrealContractView's `.table` accessor is keyed by declared table name at runtime; only the type-level branch (open map vs. literal keys) differs by how much the contract narrows, same as uniqueIndexesFor above"
  >(buildSurrealContractView(contract).table);
  const references: Array<{ table: string; field: string }> = [];
  for (const [otherTable, otherTableDef] of Object.entries(tables)) {
    for (const field of otherTableDef.fields) {
      if (field.type.kind !== 'record') continue;
      if (!field.type.tables.includes(table)) continue;
      if (field.reference?.kind !== 'cascade') continue;
      references.push({ table: otherTable, field: field.name });
    }
  }
  return references;
}

/**
 * The declared RECORD LINK fields nested `create` can traverse for `table`,
 * in both directions:
 *
 * - `outgoing`: `table`'s own `record<other>`/`array<record<other>>` fields
 *   — `table` holds the link, so a nested create must write the child's
 *   pre-allocated id(s) into `table`'s own row.
 * - `incoming`: another declared table's `record<table>` field — that other
 *   table holds the link, so a nested create must write `table`'s
 *   pre-allocated parent id into each child row instead.
 *
 * Keyed by the nested-create relation name a caller supplies: the field
 * name for `outgoing` links; for `incoming` links, always by the
 * `"otherTable.field"` composite (so two back-references from the same
 * table, e.g. `message.sender`/`message.recipient` both pointing at
 * `person`, are each individually addressable), plus the other table's
 * bare name as a convenience *only* when exactly one of its fields points
 * back at `table`. When more than one does, the bare name maps to an
 * `AmbiguousRelationLink` instead of silently picking whichever field the
 * scan happened to see last — the repository layer turns that into a
 * rejection naming the competing fields (see `create` in `repository.ts`).
 * A `record<>`/`array<record<>>` field wrapped in `option<...>` is
 * unwrapped one level (`unwrapOptional`) before this classification, so a
 * nullable link is discovered the same as a required one. This mirrors
 * `incomingCascadeReferencesFor`'s one-hop walk — a reference reachable
 * only transitively is still not followed. Graph edges (`RELATE`) never
 * declare a `record<>` field, so they are never discovered here — they are
 * discovered separately by `edgeRelationsFor` and merged into the same
 * relation-name map in `orm()`.
 */
function relationLinksFor(
  contract: Contract<SurrealStorageShape>,
  table: string,
  collections: Record<string, SurrealCollection>,
): Record<string, RelationLink | AmbiguousRelationLink> {
  const tables = blindCast<
    Record<string, SurrealTable>,
    "buildSurrealContractView's `.table` accessor is keyed by declared table name at runtime; only the type-level branch (open map vs. literal keys) differs by how much the contract narrows, same as uniqueIndexesFor above"
  >(buildSurrealContractView(contract).table);
  const links: Record<string, RelationLink | AmbiguousRelationLink> = {};

  const own = tables[table];
  for (const field of own?.fields ?? []) {
    const withoutOption = unwrapOptional(field.type);
    const resolved = withoutOption.kind === 'array' ? withoutOption.of : withoutOption;
    const many = withoutOption.kind === 'array';
    if (resolved.kind !== 'record') continue;
    for (const otherTable of resolved.tables) {
      const collection = collections[otherTable];
      if (collection === undefined) continue;
      links[field.name] = {
        direction: 'outgoing',
        field: field.name,
        table: otherTable,
        collection,
        many,
      };
    }
  }

  for (const [otherTable, otherTableDef] of Object.entries(tables)) {
    if (otherTable === table) continue;
    const collection = collections[otherTable];
    if (collection === undefined) continue;

    const matchingFields: string[] = [];
    for (const field of otherTableDef.fields) {
      const withoutOptionField = unwrapOptional(field.type);
      const resolvedField =
        withoutOptionField.kind === 'array' ? withoutOptionField.of : withoutOptionField;
      if (resolvedField.kind !== 'record') continue;
      if (!resolvedField.tables.includes(table)) continue;
      matchingFields.push(field.name);
    }

    for (const field of matchingFields) {
      links[`${otherTable}.${field}`] = {
        direction: 'incoming',
        field,
        table: otherTable,
        collection,
        many: true,
      };
    }

    if (matchingFields.length > 1) {
      links[otherTable] = { ambiguous: true, table: otherTable, fields: matchingFields };
      continue;
    }
    const [onlyField] = matchingFields;
    if (onlyField !== undefined) {
      links[otherTable] = {
        direction: 'incoming',
        field: onlyField,
        table: otherTable,
        collection,
        many: true,
      };
    }
  }

  return links;
}

/**
 * The declared graph-edge relations (`TYPE RELATION IN … OUT …`) nested
 * `create` can traverse for `table`, in both directions:
 *
 * - `outgoing`: `table` sits in a relation table's declared `IN` — a nested
 *   create relates the pre-allocated parent as `from` and a freshly
 *   created child (one of the declared `OUT` tables) as `to`.
 * - `incoming`: `table` sits in a relation table's declared `OUT` — a
 *   nested create relates a freshly created child (one of the declared
 *   `IN` tables) as `from` and the pre-allocated parent as `to`.
 *
 * Every match is registered under the composite key `"<edgeTable>-><other>"`
 * (outgoing) or `"<other><-<edgeTable>"` (incoming) — always distinct even
 * for a self-relation (`table` on both sides of the same edge table) — plus
 * the edge table's bare name as a convenience *only* when it resolves to
 * exactly one composite entry; otherwise the bare name maps to an
 * `AmbiguousEdgeRelation` naming the composite alternatives, the same
 * ambiguity convention `relationLinksFor` uses for a bare table name.
 *
 * A relation table itself is never treated as a normal outgoing/incoming
 * RECORD LINK target here — this only classifies tables whose `tableType`
 * is `'relation'`, mirroring `relationLinksFor` classifying only `record<>`
 * fields.
 */
function edgeRelationsFor(
  contract: Contract<SurrealStorageShape>,
  table: string,
  collections: Record<string, SurrealCollection>,
): Record<string, EdgeRelationLink | AmbiguousEdgeRelation> {
  const tables = blindCast<
    Record<string, SurrealTable>,
    "buildSurrealContractView's `.table` accessor is keyed by declared table name at runtime; only the type-level branch (open map vs. literal keys) differs by how much the contract narrows, same as uniqueIndexesFor above"
  >(buildSurrealContractView(contract).table);

  const composite: Record<string, EdgeRelationLink> = {};
  for (const [edgeTable, edgeDef] of Object.entries(tables)) {
    if (edgeDef.tableType.kind !== 'relation') continue;
    const edgeCollection = collections[edgeTable];
    if (edgeCollection === undefined) continue;

    if (edgeDef.tableType.from.includes(table)) {
      for (const otherTable of edgeDef.tableType.to) {
        const otherCollection = collections[otherTable];
        if (otherCollection === undefined) continue;
        composite[`${edgeTable}->${otherTable}`] = {
          kind: 'edge',
          direction: 'outgoing',
          edgeTable,
          edgeCollection,
          otherTable,
          otherCollection,
        };
      }
    }

    if (edgeDef.tableType.to.includes(table)) {
      for (const otherTable of edgeDef.tableType.from) {
        const otherCollection = collections[otherTable];
        if (otherCollection === undefined) continue;
        composite[`${otherTable}<-${edgeTable}`] = {
          kind: 'edge',
          direction: 'incoming',
          edgeTable,
          edgeCollection,
          otherTable,
          otherCollection,
        };
      }
    }
  }

  const keysByEdgeTable = new Map<string, string[]>();
  for (const [key, entry] of Object.entries(composite)) {
    const keys = keysByEdgeTable.get(entry.edgeTable) ?? [];
    keys.push(key);
    keysByEdgeTable.set(entry.edgeTable, keys);
  }

  const result: Record<string, EdgeRelationLink | AmbiguousEdgeRelation> = { ...composite };
  for (const [edgeTable, keys] of keysByEdgeTable) {
    if (keys.length === 1) {
      const [onlyKey] = keys;
      const entry = onlyKey === undefined ? undefined : composite[onlyKey];
      if (entry !== undefined) result[edgeTable] = entry;
      continue;
    }
    result[edgeTable] = { ambiguousEdge: true, edgeTable, alternatives: keys };
  }

  return result;
}

export function orm<TContract extends Contract<SurrealStorageShape>>(
  options: OrmClientOptions<TContract>,
): OrmClientDb<TContract> {
  const collections = blindCast<
    Record<string, SurrealCollection>,
    'SurrealOrm<TContract> is always keyed by table name to a SurrealCollection at runtime; only the type-level branch (open map vs. literal keys) differs by how much the contract narrows'
  >(buildOrmLane(options.context.contract));

  const createReturnsRecord = hasCreateReturnsRecord(options.context.contract);
  const upsertByRecordId = hasUpsertByRecordId(options.context.contract);
  const upsertByUniqueIndex = hasUpsertByUniqueIndex(options.context.contract);
  const referenceOnDeleteEnforced = hasReferenceOnDelete(options.context.contract);
  const graphEdgesEnabled = hasGraphEdges(options.context.contract);
  const sequencesEnabled = hasSequences(options.context.contract);
  const storageHash = options.context.contract.storage.storageHash ?? '';
  const tables: Record<string, OrmClientRepository> = {};
  for (const table of Object.keys(collections)) {
    const collection = collections[table];
    if (collection === undefined) continue;
    const incomingCascadeReferences: IncomingCascadeReference[] = [];
    for (const reference of incomingCascadeReferencesFor(options.context.contract, table)) {
      const referencingCollection = collections[reference.table];
      if (referencingCollection === undefined) continue;
      incomingCascadeReferences.push({
        table: reference.table,
        field: reference.field,
        collection: referencingCollection,
      });
    }

    const idSequence = idSequenceBindingFor(options.context.contract, table, options.idSequences);

    const links = relationLinksFor(options.context.contract, table, collections);
    const edges = edgeRelationsFor(options.context.contract, table, collections);
    const relationLinks: Record<string, RelationEntry> = { ...links };
    for (const [relationName, edge] of Object.entries(edges)) {
      const existingLink = links[relationName];
      relationLinks[relationName] =
        existingLink === undefined ? edge : { conflict: true, asLink: existingLink, asEdge: edge };
    }

    tables[table] = createOrmClientRepository({
      table,
      runtime: options.runtime,
      collection,
      createReturnsRecord,
      upsertByRecordId,
      upsertByUniqueIndex,
      uniqueIndexes: uniqueIndexesFor(options.context.contract, table),
      incomingCascadeReferences,
      referenceOnDeleteEnforced,
      relationLinks,
      graphEdgesEnabled,
      sequencesEnabled,
      storageHash,
      ...ifDefined('idSequence', idSequence),
      ...ifDefined('onOperationStats', options.onOperationStats),
    });
  }

  return blindCast<
    OrmClientDb<TContract>,
    'tables is built from exactly the table names the ORM lane declares for this same contract, so the runtime keys and the declared keys are the same set by construction'
  >(Object.freeze(tables));
}
