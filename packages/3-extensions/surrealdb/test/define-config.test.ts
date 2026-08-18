import { describe, expect, it } from 'vitest';
import { defineConfig } from '../src/config/define-config';

describe('defineConfig', () => {
  it('wires the SurrealDB family, target, adapter and driver', () => {
    const config = defineConfig();
    expect(config.family.familyId).toBe('surreal');
    expect(config.target.targetId).toBe('surrealdb');
    expect(config.adapter.targetId).toBe('surrealdb');
    expect(config.driver?.targetId).toBe('surrealdb');
  });

  it('carries the connection string through to the db block', () => {
    // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket -- loopback fixture asserted as text, never opened as a socket
    const config = defineConfig({ connection: 'ws://root:root@127.0.0.1:8112/rpc/app/main' });
    // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket -- loopback fixture asserted as text, never opened as a socket
    expect(config.db?.connection).toBe('ws://root:root@127.0.0.1:8112/rpc/app/main');
  });

  it('omits the db block when no connection was given', () => {
    expect(defineConfig().db).toBeUndefined();
  });

  it('carries a migrations directory through', () => {
    expect(defineConfig({ migrations: { dir: 'db/migrations' } }).migrations?.dir).toBe(
      'db/migrations',
    );
  });

  it('defaults extensions to an empty list rather than leaving them absent', () => {
    expect(defineConfig().extensions).toEqual([]);
  });
});
