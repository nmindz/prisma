import { describe, expect, it } from 'vitest';
import { SurrealControlDriver } from '../src/core/control-driver';
import { SurrealBatchQueryError } from '../src/result-envelope';
import { connectFakeRpc } from './support/fake-rpc';

const BINDING = { url: 'wss://fake.invalid/rpc', namespace: 'ns', database: 'db' };

const ok = (result: unknown) => ({ status: 'OK', result, time: '1ms' });
const notExecuted = {
  status: 'ERR',
  result: 'The query was not executed due to a failed transaction',
  kind: 'Query',
  details: { kind: 'NotExecuted' },
  time: '0ns',
};

describe('SurrealControlDriver.batch', () => {
  it('attributes a middle-plan failure to its plan index', async () => {
    const fake = await connectFakeRpc();
    // BEGIN, plan 0 (skipped), plan 1 (the genuine failure), plan 2 (skipped), COMMIT.
    fake.respondTo('query', () => ({
      result: [
        ok(null),
        notExecuted,
        { status: 'ERR', result: 'An error occurred: boom', kind: 'Thrown', time: '1ms' },
        notExecuted,
        {
          ...notExecuted,
          result: 'Cannot COMMIT: the transaction was aborted due to a prior error',
        },
      ],
    }));
    const driver = new SurrealControlDriver(fake.rpc, BINDING);

    let thrown: unknown;
    try {
      await driver.batch({ surql: 'BEGIN; A; B; C; COMMIT', resultIndex: 0 }, [1, 2, 3]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SurrealBatchQueryError);
    expect(thrown).toMatchObject({ planIndex: 1 });
  });
});
