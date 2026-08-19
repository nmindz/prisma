import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Empirical pin for SurrealDB's record-reference `ON DELETE` behavior.
 *
 * `DEFINE FIELD ... REFERENCE ON DELETE <action>` has four actions (CASCADE,
 * UNSET, REJECT, IGNORE) and the field carrying the reference can be a
 * required `record<b>`, an `option<record<b>>`, or an `array<record<b>>`.
 * None of that is exercised anywhere else in this package, and the DDL
 * renderer/differ need to know exactly what each combination does before
 * either can be taught to model it. This suite talks to a live SurrealDB
 * directly over its HTTP `/sql` endpoint (no target-pack code involved) so
 * every assertion below is a fact observed on the wire, not an assumption
 * about the feature.
 *
 * Every scenario below was run once with its result printed to the console
 * to see what the server actually does, then the printed result became the
 * assertion. Nothing here is aspirational.
 */

const HTTP_URL = process.env['SURREALDB_TEST_HTTP_URL'] ?? 'http://127.0.0.1:8112/sql';
const NAMESPACE = process.env['SURREALDB_TEST_NAMESPACE'] ?? 'prisma_next_test';
const USERNAME = process.env['SURREALDB_TEST_USER'] ?? 'root';
const PASSWORD = process.env['SURREALDB_TEST_PASSWORD'] ?? 'root';

interface SurqlResult {
  readonly status: string;
  readonly result: unknown;
}

function authHeader(): string {
  return `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`, 'utf-8').toString('base64')}`;
}

async function runSql(database: string, surql: string): Promise<readonly SurqlResult[]> {
  const response = await fetch(HTTP_URL, {
    method: 'POST',
    headers: {
      authorization: authHeader(),
      accept: 'application/json',
      'content-type': 'text/plain',
    },
    body: `USE NS ${NAMESPACE} DB ${database}; ${surql}`,
  });
  return (await response.json()) as readonly SurqlResult[];
}

async function reachable(): Promise<boolean> {
  try {
    const response = await fetch(new URL('/health', HTTP_URL), {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const available = await reachable();

type OnDeleteAction = 'CASCADE' | 'UNSET' | 'REJECT' | 'IGNORE';

interface ScenarioSetup {
  readonly database: string;
  readonly fieldType: string;
  readonly onDelete: OnDeleteAction;
  readonly seed: readonly string[];
  readonly linkExpression: string;
}

interface ScenarioResult {
  readonly infoFieldText: string | undefined;
  readonly subFieldText: string | undefined;
  readonly deleteStatus: string;
  readonly deleteMessage: string | undefined;
  readonly aRowsAfterDelete: readonly Record<string, unknown>[];
  readonly bRowsAfterDelete: readonly Record<string, unknown>[];
}

/**
 * Defines `a.link` with the given shape and `ON DELETE` action, captures the
 * server's own rendering of that field from `INFO FOR TABLE a`, seeds `b`
 * (and a single `a:1` pointing at it), deletes `b:1`, and reports exactly
 * what the server did.
 */
async function runScenario(setup: ScenarioSetup): Promise<ScenarioResult> {
  const { database, fieldType, onDelete, seed, linkExpression } = setup;

  await runSql(database, 'REMOVE TABLE IF EXISTS a; REMOVE TABLE IF EXISTS b;');
  await runSql(
    database,
    [
      'DEFINE TABLE b SCHEMAFULL;',
      'DEFINE TABLE a SCHEMAFULL;',
      `DEFINE FIELD link ON a TYPE ${fieldType} REFERENCE ON DELETE ${onDelete};`,
    ].join(' '),
  );

  const infoResults = await runSql(database, 'INFO FOR TABLE a;');
  const info = infoResults.at(-1)?.result as { fields: Record<string, string> } | undefined;

  await runSql(database, [...seed, `CREATE a:1 SET link = ${linkExpression};`].join(' '));

  const afterDelete = await runSql(database, 'DELETE b:1; SELECT * FROM a; SELECT * FROM b;');
  const [deleteEntry, aEntry, bEntry] = afterDelete.slice(-3) as [
    SurqlResult,
    SurqlResult,
    SurqlResult,
  ];

  return {
    infoFieldText: info?.fields['link'],
    subFieldText: info?.fields['link.*'],
    deleteStatus: deleteEntry.status,
    deleteMessage: deleteEntry.status === 'ERR' ? (deleteEntry.result as string) : undefined,
    aRowsAfterDelete: aEntry.result as readonly Record<string, unknown>[],
    bRowsAfterDelete: bEntry.result as readonly Record<string, unknown>[],
  };
}

function cleanUp(database: string): () => Promise<void> {
  return async () => {
    await runSql(database, 'REMOVE TABLE IF EXISTS a; REMOVE TABLE IF EXISTS b;');
  };
}

describe.skipIf(!available)(
  'SurrealDB record-reference ON DELETE behavior, pinned against a live server',
  () => {
    describe('CASCADE on a required record<b> field', () => {
      const database = 'reference_behavior_cascade_required';
      let result: ScenarioResult;

      beforeAll(async () => {
        result = await runScenario({
          database,
          fieldType: 'record<b>',
          onDelete: 'CASCADE',
          seed: ['CREATE b:1;'],
          linkExpression: 'b:1',
        });
      });

      afterAll(cleanUp(database));

      it('renders REFERENCE ON DELETE CASCADE verbatim on the required record field', () => {
        expect(result.infoFieldText).toBe(
          'DEFINE FIELD link ON a TYPE record<b> REFERENCE ON DELETE CASCADE PERMISSIONS FULL',
        );
      });

      it('deletes the referencing record along with the referenced one', () => {
        expect(result.deleteStatus).toBe('OK');
        expect(result.aRowsAfterDelete).toEqual([]);
        expect(result.bRowsAfterDelete).toEqual([]);
      });
    });

    describe('CASCADE on an option<record<b>> field', () => {
      const database = 'reference_behavior_cascade_option';
      let result: ScenarioResult;

      beforeAll(async () => {
        result = await runScenario({
          database,
          fieldType: 'option<record<b>>',
          onDelete: 'CASCADE',
          seed: ['CREATE b:1;'],
          linkExpression: 'b:1',
        });
      });

      afterAll(cleanUp(database));

      it('canonicalizes option<record<b>> to "none | record<b>" in the rendered field', () => {
        expect(result.infoFieldText).toBe(
          'DEFINE FIELD link ON a TYPE none | record<b> REFERENCE ON DELETE CASCADE PERMISSIONS FULL',
        );
      });

      it('deletes the referencing record along with the referenced one, same as the required shape', () => {
        expect(result.deleteStatus).toBe('OK');
        expect(result.aRowsAfterDelete).toEqual([]);
        expect(result.bRowsAfterDelete).toEqual([]);
      });
    });

    describe('CASCADE on an array<record<b>> field', () => {
      const database = 'reference_behavior_cascade_array';
      let result: ScenarioResult;

      beforeAll(async () => {
        result = await runScenario({
          database,
          fieldType: 'array<record<b>>',
          onDelete: 'CASCADE',
          seed: ['CREATE b:1;', 'CREATE b:2;'],
          linkExpression: '[b:1, b:2]',
        });
      });

      afterAll(cleanUp(database));

      it('renders REFERENCE ON DELETE CASCADE on the array field and an implicit link.* element field', () => {
        expect(result.infoFieldText).toBe(
          'DEFINE FIELD link ON a TYPE array<record<b>> REFERENCE ON DELETE CASCADE PERMISSIONS FULL',
        );
        expect(result.subFieldText).toBe(
          'DEFINE FIELD link.* ON a TYPE record<b> PERMISSIONS FULL',
        );
      });

      it('deletes the whole referencing record, even though a second array entry (b:2) still exists', () => {
        expect(result.deleteStatus).toBe('OK');
        expect(result.aRowsAfterDelete).toEqual([]);
        expect(result.bRowsAfterDelete).toEqual([{ id: 'b:2' }]);
      });
    });

    describe('UNSET on an option<record<b>> field', () => {
      const database = 'reference_behavior_unset_option';
      let result: ScenarioResult;

      beforeAll(async () => {
        result = await runScenario({
          database,
          fieldType: 'option<record<b>>',
          onDelete: 'UNSET',
          seed: ['CREATE b:1;'],
          linkExpression: 'b:1',
        });
      });

      afterAll(cleanUp(database));

      it('canonicalizes option<record<b>> to "none | record<b>" in the rendered field', () => {
        expect(result.infoFieldText).toBe(
          'DEFINE FIELD link ON a TYPE none | record<b> REFERENCE ON DELETE UNSET PERMISSIONS FULL',
        );
      });

      it('deletes the referenced record and clears the field on the survivor', () => {
        expect(result.deleteStatus).toBe('OK');
        expect(result.aRowsAfterDelete).toEqual([{ id: 'a:1' }]);
        expect(result.bRowsAfterDelete).toEqual([]);
      });
    });

    describe('UNSET on an array<record<b>> field', () => {
      const database = 'reference_behavior_unset_array';
      let result: ScenarioResult;

      beforeAll(async () => {
        result = await runScenario({
          database,
          fieldType: 'array<record<b>>',
          onDelete: 'UNSET',
          seed: ['CREATE b:1;', 'CREATE b:2;'],
          linkExpression: '[b:1, b:2]',
        });
      });

      afterAll(cleanUp(database));

      it('renders REFERENCE ON DELETE UNSET on the array field and an implicit link.* element field', () => {
        expect(result.infoFieldText).toBe(
          'DEFINE FIELD link ON a TYPE array<record<b>> REFERENCE ON DELETE UNSET PERMISSIONS FULL',
        );
        expect(result.subFieldText).toBe(
          'DEFINE FIELD link.* ON a TYPE record<b> PERMISSIONS FULL',
        );
      });

      it('removes only the deleted id from the array, leaving the surviving reference in place', () => {
        expect(result.deleteStatus).toBe('OK');
        expect(result.aRowsAfterDelete).toEqual([{ id: 'a:1', link: ['b:2'] }]);
        expect(result.bRowsAfterDelete).toEqual([{ id: 'b:2' }]);
      });
    });

    describe('UNSET on a required record<b> field', () => {
      const database = 'reference_behavior_unset_required';
      let result: ScenarioResult;

      beforeAll(async () => {
        result = await runScenario({
          database,
          fieldType: 'record<b>',
          onDelete: 'UNSET',
          seed: ['CREATE b:1;'],
          linkExpression: 'b:1',
        });
      });

      afterAll(cleanUp(database));

      it('accepts the DDL even though the field is not optional (no DEFINE-time rejection)', () => {
        expect(result.infoFieldText).toBe(
          'DEFINE FIELD link ON a TYPE record<b> REFERENCE ON DELETE UNSET PERMISSIONS FULL',
        );
      });

      it('rejects the DELETE at write time because UNSET would coerce the required field to NONE', () => {
        expect(result.deleteStatus).toBe('ERR');
        expect(result.deleteMessage).toBe(
          "An error occurred while updating references for `b:1`: Couldn't coerce value for field `link` of `a:1`: Expected `record<b>` but found `NONE`",
        );
      });

      it('leaves both records exactly as they were, since the failed delete never committed', () => {
        expect(result.aRowsAfterDelete).toEqual([{ id: 'a:1', link: 'b:1' }]);
        expect(result.bRowsAfterDelete).toEqual([{ id: 'b:1' }]);
      });
    });

    describe('REJECT on a required record<b> field', () => {
      const database = 'reference_behavior_reject_required';
      let result: ScenarioResult;

      beforeAll(async () => {
        result = await runScenario({
          database,
          fieldType: 'record<b>',
          onDelete: 'REJECT',
          seed: ['CREATE b:1;'],
          linkExpression: 'b:1',
        });
      });

      afterAll(cleanUp(database));

      it('renders REFERENCE ON DELETE REJECT verbatim on the required record field', () => {
        expect(result.infoFieldText).toBe(
          'DEFINE FIELD link ON a TYPE record<b> REFERENCE ON DELETE REJECT PERMISSIONS FULL',
        );
      });

      it('rejects the DELETE outright and leaves both records untouched', () => {
        expect(result.deleteStatus).toBe('ERR');
        expect(result.deleteMessage).toBe(
          'Cannot delete `b:1` as it is referenced by `a:1` with an ON DELETE REJECT clause',
        );
        expect(result.aRowsAfterDelete).toEqual([{ id: 'a:1', link: 'b:1' }]);
        expect(result.bRowsAfterDelete).toEqual([{ id: 'b:1' }]);
      });
    });

    describe('REJECT on an option<record<b>> field', () => {
      const database = 'reference_behavior_reject_option';
      let result: ScenarioResult;

      beforeAll(async () => {
        result = await runScenario({
          database,
          fieldType: 'option<record<b>>',
          onDelete: 'REJECT',
          seed: ['CREATE b:1;'],
          linkExpression: 'b:1',
        });
      });

      afterAll(cleanUp(database));

      it('canonicalizes option<record<b>> to "none | record<b>" in the rendered field', () => {
        expect(result.infoFieldText).toBe(
          'DEFINE FIELD link ON a TYPE none | record<b> REFERENCE ON DELETE REJECT PERMISSIONS FULL',
        );
      });

      it('rejects the DELETE even though the field is optional, same as the required shape', () => {
        expect(result.deleteStatus).toBe('ERR');
        expect(result.deleteMessage).toBe(
          'Cannot delete `b:1` as it is referenced by `a:1` with an ON DELETE REJECT clause',
        );
        expect(result.aRowsAfterDelete).toEqual([{ id: 'a:1', link: 'b:1' }]);
        expect(result.bRowsAfterDelete).toEqual([{ id: 'b:1' }]);
      });
    });

    describe('REJECT on an array<record<b>> field', () => {
      const database = 'reference_behavior_reject_array';
      let result: ScenarioResult;

      beforeAll(async () => {
        result = await runScenario({
          database,
          fieldType: 'array<record<b>>',
          onDelete: 'REJECT',
          seed: ['CREATE b:1;', 'CREATE b:2;'],
          linkExpression: '[b:1, b:2]',
        });
      });

      afterAll(cleanUp(database));

      it('renders REFERENCE ON DELETE REJECT on the array field and an implicit link.* element field', () => {
        expect(result.infoFieldText).toBe(
          'DEFINE FIELD link ON a TYPE array<record<b>> REFERENCE ON DELETE REJECT PERMISSIONS FULL',
        );
        expect(result.subFieldText).toBe(
          'DEFINE FIELD link.* ON a TYPE record<b> PERMISSIONS FULL',
        );
      });

      it('rejects the DELETE because one array entry still points at it, leaving both b:1 and b:2 untouched', () => {
        expect(result.deleteStatus).toBe('ERR');
        expect(result.deleteMessage).toBe(
          'Cannot delete `b:1` as it is referenced by `a:1` with an ON DELETE REJECT clause',
        );
        expect(result.aRowsAfterDelete).toEqual([{ id: 'a:1', link: ['b:1', 'b:2'] }]);
        expect(result.bRowsAfterDelete).toEqual([{ id: 'b:1' }, { id: 'b:2' }]);
      });
    });

    describe('IGNORE on a required record<b> field', () => {
      const database = 'reference_behavior_ignore_required';
      let result: ScenarioResult;

      beforeAll(async () => {
        result = await runScenario({
          database,
          fieldType: 'record<b>',
          onDelete: 'IGNORE',
          seed: ['CREATE b:1;'],
          linkExpression: 'b:1',
        });
      });

      afterAll(cleanUp(database));

      it('renders REFERENCE ON DELETE IGNORE verbatim on the required record field', () => {
        expect(result.infoFieldText).toBe(
          'DEFINE FIELD link ON a TYPE record<b> REFERENCE ON DELETE IGNORE PERMISSIONS FULL',
        );
      });

      it('deletes the referenced record and leaves the referencing field dangling, untouched', () => {
        expect(result.deleteStatus).toBe('OK');
        expect(result.aRowsAfterDelete).toEqual([{ id: 'a:1', link: 'b:1' }]);
        expect(result.bRowsAfterDelete).toEqual([]);
      });
    });

    describe('IGNORE on an option<record<b>> field', () => {
      const database = 'reference_behavior_ignore_option';
      let result: ScenarioResult;

      beforeAll(async () => {
        result = await runScenario({
          database,
          fieldType: 'option<record<b>>',
          onDelete: 'IGNORE',
          seed: ['CREATE b:1;'],
          linkExpression: 'b:1',
        });
      });

      afterAll(cleanUp(database));

      it('canonicalizes option<record<b>> to "none | record<b>" in the rendered field', () => {
        expect(result.infoFieldText).toBe(
          'DEFINE FIELD link ON a TYPE none | record<b> REFERENCE ON DELETE IGNORE PERMISSIONS FULL',
        );
      });

      it('deletes the referenced record and leaves the dangling optional field untouched, same as the required shape', () => {
        expect(result.deleteStatus).toBe('OK');
        expect(result.aRowsAfterDelete).toEqual([{ id: 'a:1', link: 'b:1' }]);
        expect(result.bRowsAfterDelete).toEqual([]);
      });
    });

    describe('IGNORE on an array<record<b>> field', () => {
      const database = 'reference_behavior_ignore_array';
      let result: ScenarioResult;

      beforeAll(async () => {
        result = await runScenario({
          database,
          fieldType: 'array<record<b>>',
          onDelete: 'IGNORE',
          seed: ['CREATE b:1;', 'CREATE b:2;'],
          linkExpression: '[b:1, b:2]',
        });
      });

      afterAll(cleanUp(database));

      it('renders REFERENCE ON DELETE IGNORE on the array field and an implicit link.* element field', () => {
        expect(result.infoFieldText).toBe(
          'DEFINE FIELD link ON a TYPE array<record<b>> REFERENCE ON DELETE IGNORE PERMISSIONS FULL',
        );
        expect(result.subFieldText).toBe(
          'DEFINE FIELD link.* ON a TYPE record<b> PERMISSIONS FULL',
        );
      });

      it('deletes the referenced record and leaves the dangling array entry untouched (no subtraction, unlike UNSET)', () => {
        expect(result.deleteStatus).toBe('OK');
        expect(result.aRowsAfterDelete).toEqual([{ id: 'a:1', link: ['b:1', 'b:2'] }]);
        expect(result.bRowsAfterDelete).toEqual([{ id: 'b:2' }]);
      });
    });
  },
);

describe.skipIf(available)('SurrealDB record-reference ON DELETE behavior suite', () => {
  it('is skipped because SurrealDB is not reachable', () => {
    expect(available).toBe(false);
  });
});
