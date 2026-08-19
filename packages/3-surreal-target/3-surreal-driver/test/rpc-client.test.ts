import { SurrealConnectionError } from '@internal/surreal-errors';
import { describe, expect, it } from 'vitest';
import { connectFakeRpc, NO_REPLY } from './support/fake-rpc';

describe('SurrealRpcClient.close', () => {
  it('rejects an in-flight call instead of leaving it pending forever', async () => {
    const fake = await connectFakeRpc();
    fake.respondTo('query', () => NO_REPLY);

    const inFlight = fake.rpc.call('query', ['RETURN 1', {}]);
    await fake.rpc.close();

    await expect(inFlight).rejects.toSatisfy(
      (error) => SurrealConnectionError.is(error) && /closed/i.test(String(error)),
    );
  });

  it('close after close stays a no-op', async () => {
    const fake = await connectFakeRpc();
    await fake.rpc.close();
    await expect(fake.rpc.close()).resolves.toBeUndefined();
  });
});
