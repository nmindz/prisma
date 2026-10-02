import { SurrealContractSerializer } from '@internal/target-surrealdb/contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import surrealdbStatic, { buildSurrealStaticContext } from '../src/static/surreal-static';
import { testContractJson } from './support/contract';

describe('surrealdbStatic() opens no transport', () => {
  const originalWebSocket = globalThis.WebSocket;
  let socketSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    socketSpy = vi.fn(() => {
      throw new Error('WebSocket must never be constructed by the static surface');
    });
    Object.defineProperty(globalThis, 'WebSocket', {
      value: socketSpy,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'WebSocket', {
      value: originalWebSocket,
      configurable: true,
      writable: true,
    });
  });

  it('never constructs a socket building a static client from contract JSON', () => {
    surrealdbStatic({ contractJson: testContractJson() });
    expect(socketSpy).not.toHaveBeenCalled();
  });

  it('never constructs a socket building a static context from a hydrated contract', () => {
    const contract = new SurrealContractSerializer().deserializeContract(testContractJson());
    buildSurrealStaticContext(contract);
    expect(socketSpy).not.toHaveBeenCalled();
  });
});
