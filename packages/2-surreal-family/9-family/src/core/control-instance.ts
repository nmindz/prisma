import type { Contract, ContractMarkerRecord, LedgerEntryRecord } from '@internal/contract/types';
import type {
  ControlDriverInstance,
  ControlFamilyInstance,
  ControlStack,
  SignDatabaseResult,
  VerifyDatabaseResult,
  VerifyDatabaseSchemaResult,
} from '@internal/framework-components/control';
import {
  APP_SPACE_ID,
  VERIFY_CODE_HASH_MISMATCH,
  VERIFY_CODE_MARKER_MISSING,
  VERIFY_CODE_SCHEMA_FAILURE,
  VERIFY_CODE_TARGET_MISMATCH,
} from '@internal/framework-components/control';
import { assertNothingCastsFromSurrealExpression } from '@internal/surreal-contract';
import type { SurrealSchemaIR } from '@internal/surreal-schema-ir';
import { blindCast } from '@internal/utils/casts';
import { introspectSurrealSchema } from './introspect-database';
import {
  type ControlQueryable,
  readAllMarkerRows,
  readLedgerRows,
  readMarkerRow,
  writeMarkerRow,
} from './marker-store';
import { surrealSchemaIssues } from './verify-schema';

export interface SurrealControlFamilyInstance
  extends ControlFamilyInstance<'surreal', SurrealSchemaIR> {}

/** A control driver is a queryable; the narrowing keeps the store free of the descriptor types. */
function queryable(driver: ControlDriverInstance<'surreal', string>): ControlQueryable {
  return blindCast<
    ControlQueryable,
    'every SurrealDB control driver implements the SurrealQueryable read surface; the framework driver-instance type does not declare it'
  >(driver);
}

function hashesOf(contract: unknown): { storageHash: string; profileHash?: string } {
  const typed = blindCast<
    Contract,
    'the caller passes a contract this family deserialized; the framework SPI types it as unknown'
  >(contract);
  const storageHash = typed.storage.storageHash ?? '';
  const profileHash = typed.profileHash;
  return profileHash === undefined ? { storageHash } : { storageHash, profileHash };
}

function elapsed(startedAt: number): { readonly total: number } {
  return { total: Date.now() - startedAt };
}

/**
 * The SurrealDB family's control-plane instance.
 *
 * It answers the four questions the CLI asks of a database: which contract is
 * it running (`readMarker`), what does it actually contain (`introspect`),
 * do those agree (`verify` / `verifySchema`), and record that they now do
 * (`sign`).
 */
class SurrealControlFamily implements SurrealControlFamilyInstance {
  readonly familyId = 'surreal' as const;

  readonly #stack: ControlStack<'surreal', string>;

  constructor(stack: ControlStack<'surreal', string>) {
    this.#stack = stack;
  }

  deserializeContract(contractJson: unknown): Contract {
    return this.#stack.target.contractSerializer.deserializeContract(contractJson);
  }

  async introspect(options: {
    readonly driver: ControlDriverInstance<'surreal', string>;
  }): Promise<SurrealSchemaIR> {
    return introspectSurrealSchema(queryable(options.driver));
  }

  async readMarker(options: {
    readonly driver: ControlDriverInstance<'surreal', string>;
    readonly space: string;
  }): Promise<ContractMarkerRecord | null> {
    return readMarkerRow(queryable(options.driver), options.space);
  }

  async readAllMarkers(options: {
    readonly driver: ControlDriverInstance<'surreal', string>;
  }): Promise<ReadonlyMap<string, ContractMarkerRecord>> {
    return readAllMarkerRows(queryable(options.driver));
  }

  async readLedger(options: {
    readonly driver: ControlDriverInstance<'surreal', string>;
    readonly space?: string;
  }): Promise<readonly LedgerEntryRecord[]> {
    return readLedgerRows(queryable(options.driver), options.space);
  }

  /**
   * Compares a contract against an already-introspected schema.
   *
   * Synchronous and side-effect free, as the framework requires: the caller
   * that wants to check the live database composes `introspect` with this.
   */
  verifySchema(options: {
    readonly contract: unknown;
    readonly schema: SurrealSchemaIR;
    readonly strict: boolean;
  }): VerifyDatabaseSchemaResult {
    const startedAt = Date.now();
    const contract = hashesOf(options.contract);
    const expected = this.#expectedSchema(options.contract);
    const issues = surrealSchemaIssues(expected, options.schema);
    return {
      ok: issues.length === 0,
      ...(issues.length === 0 ? {} : { code: VERIFY_CODE_SCHEMA_FAILURE }),
      summary:
        issues.length === 0
          ? 'Database schema matches the contract'
          : `Database schema differs from the contract in ${issues.length} place(s)`,
      contract,
      target: { expected: this.#stack.target.targetId },
      schema: { issues },
      meta: { strict: options.strict },
      timings: elapsed(startedAt),
    };
  }

  /**
   * Projects the contract into the introspected shape.
   *
   * The projection lives on the target descriptor rather than here: rendering
   * SurrealQL DDL is target-owned, and the family may not import the target.
   */
  #expectedSchema(contract: unknown): SurrealSchemaIR {
    const project = blindCast<
      { readonly contractToSchema?: (contract: unknown) => SurrealSchemaIR },
      'the SurrealDB control target descriptor carries the contract-to-schema projection; the framework target-descriptor type does not declare it'
    >(this.#stack.target).contractToSchema;
    return project === undefined ? { tables: {}, analyzers: {} } : project(contract);
  }

  async verify(options: {
    readonly driver: ControlDriverInstance<'surreal', string>;
    readonly contract: unknown;
    readonly expectedTargetId: string;
    readonly contractPath: string;
    readonly configPath?: string;
  }): Promise<VerifyDatabaseResult> {
    const startedAt = Date.now();
    const contract = hashesOf(options.contract);
    const meta = {
      contractPath: options.contractPath,
      ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    };
    const base = {
      contract,
      target: { expected: options.expectedTargetId, actual: this.#stack.target.targetId },
      meta,
    };

    if (this.#stack.target.targetId !== options.expectedTargetId) {
      return {
        ...base,
        ok: false,
        code: VERIFY_CODE_TARGET_MISMATCH,
        summary: `Contract targets "${options.expectedTargetId}" but the configured target is "${this.#stack.target.targetId}"`,
        timings: elapsed(startedAt),
      };
    }

    const marker = await readMarkerRow(queryable(options.driver), APP_SPACE_ID);
    if (marker === null) {
      return {
        ...base,
        ok: false,
        code: VERIFY_CODE_MARKER_MISSING,
        summary: 'Database carries no contract marker; run `db init` first',
        timings: elapsed(startedAt),
      };
    }

    const markerHashes = { storageHash: marker.storageHash, profileHash: marker.profileHash };
    if (marker.storageHash !== contract.storageHash) {
      return {
        ...base,
        ok: false,
        code: VERIFY_CODE_HASH_MISMATCH,
        summary: 'Database marker does not match the contract on disk',
        marker: markerHashes,
        timings: elapsed(startedAt),
      };
    }

    const schema = await this.introspect({ driver: options.driver });
    const issues = surrealSchemaIssues(this.#expectedSchema(options.contract), schema);
    return {
      ...base,
      ok: issues.length === 0,
      ...(issues.length === 0 ? {} : { code: VERIFY_CODE_SCHEMA_FAILURE }),
      summary:
        issues.length === 0
          ? 'Database matches the contract'
          : `Database schema differs from the contract in ${issues.length} place(s)`,
      marker: markerHashes,
      timings: elapsed(startedAt),
    };
  }

  /**
   * Records that this database now runs this contract.
   *
   * Signing does not check the schema: the caller signs after applying, and
   * making `sign` re-verify would either duplicate that work or, worse,
   * refuse to record a migration that had in fact been applied.
   */
  async sign(options: {
    readonly driver: ControlDriverInstance<'surreal', string>;
    readonly contract: unknown;
    readonly contractPath: string;
    readonly configPath?: string;
  }): Promise<SignDatabaseResult> {
    const startedAt = Date.now();
    const contract = hashesOf(options.contract);
    const store = queryable(options.driver);
    const previous = await readMarkerRow(store, APP_SPACE_ID);

    await writeMarkerRow(store, APP_SPACE_ID, {
      storageHash: contract.storageHash,
      profileHash: contract.profileHash ?? '',
      contractJson: null,
      canonicalVersion: null,
      updatedAt: new Date(),
      appTag: null,
      meta: {},
      invariants: [],
    });

    return {
      ok: true,
      summary:
        previous === null
          ? 'Contract marker created'
          : 'Contract marker updated to the contract on disk',
      contract,
      target: { expected: this.#stack.target.targetId, actual: this.#stack.target.targetId },
      marker: {
        created: previous === null,
        updated: previous !== null,
        ...(previous === null
          ? {}
          : {
              previous: {
                storageHash: previous.storageHash,
                profileHash: previous.profileHash,
              },
            }),
      },
      meta: {
        contractPath: options.contractPath,
        ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
      },
      timings: elapsed(startedAt),
    };
  }
}

export function createSurrealFamilyInstance(
  stack: ControlStack<'surreal', string>,
): SurrealControlFamilyInstance {
  assertNothingCastsFromSurrealExpression(stack.declaredDataTypes);
  return new SurrealControlFamily(stack);
}
