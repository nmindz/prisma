import type { Contract } from '@internal/contract/types';
import { coreHash } from '@internal/contract/types';
import type { SurrealNamespace } from '@internal/surreal-contract';
import {
  buildSurrealNamespace,
  SurrealContractSchema,
  SurrealStorage,
  validateSurrealTables,
} from '@internal/surreal-contract';
import type { SurrealStorageShape } from '@internal/surreal-contract/types';
import { blindCast } from '@internal/utils/casts';
import { structuredError } from '@internal/utils/structured-error';
import { type as arktypeType } from 'arktype';

/**
 * The JSON ⇄ class boundary for a SurrealDB contract.
 *
 * `contract.json` is data; the in-memory contract is a tree of frozen IR
 * classes. Deserializing validates the envelope structurally and then
 * re-checks the invariants that need the whole table map at once — a
 * `record<person>` pointing at a table the contract never declares is
 * well-formed JSON and a broken contract.
 */
export class SurrealContractSerializer {
  deserializeContract(json: unknown): Contract<SurrealStorageShape> {
    const validated = SurrealContractSchema(json);
    if (validated instanceof arktypeType.errors) {
      throw structuredError(
        'CONTRACT.INVALID',
        `SurrealDB contract failed validation: ${validated.summary}`,
        { meta: { summary: validated.summary } },
      );
    }

    const envelope = blindCast<
      {
        readonly storage: {
          readonly namespaces: Record<
            string,
            { readonly id: string; readonly entries: Record<string, Record<string, unknown>> }
          >;
          readonly storageHash?: string;
        };
      } & Record<string, unknown>,
      'the arktype schema above accepted this value, so it has the contract envelope shape; arktype returns the validated value as unknown'
    >(validated);

    const namespaces: Record<string, SurrealNamespace> = {};
    for (const [id, namespace] of Object.entries(envelope.storage.namespaces)) {
      namespaces[id] = buildSurrealNamespace({
        id: namespace.id ?? id,
        entries: namespace.entries,
      });
      const tables = namespaces[id]?.entries.table;
      if (tables !== undefined) validateSurrealTables(tables);
    }

    const storage = new SurrealStorage({
      storageHash: coreHash(envelope.storage.storageHash ?? ''),
      namespaces,
    });

    return blindCast<
      Contract<SurrealStorageShape>,
      'the envelope was validated against SurrealContractSchema and its storage block replaced with the hydrated IR; the remaining members are carried through unchanged'
    >({ ...envelope, storage });
  }

  /**
   * Round-trips a constructed contract back to plain JSON.
   *
   * The IR classes are `JSON.stringify`-transparent: every field is an own
   * enumerable property, so the structured clone is the on-disk form.
   */
  serializeContract(contract: Contract<SurrealStorageShape>): unknown {
    return JSON.parse(JSON.stringify(contract));
  }
}
