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

  it('omits the contract block when no contract was given', () => {
    expect(defineConfig().contract).toBeUndefined();
  });

  it('wires a PSL contract source for .prisma paths', () => {
    const config = defineConfig({ contract: './prisma/contract.prisma' });

    expect(config.contract?.source.format).toBe('psl');
    expect(config.contract?.source.inputs).toEqual(['./prisma/contract.prisma']);
    expect(typeof config.contract?.source.load).toBe('function');
  });

  it('wires a TypeScript contract source for .ts paths', () => {
    const config = defineConfig({ contract: './prisma/contract.ts' });

    expect(config.contract?.source.format).toBe('typescript');
    expect(config.contract?.source.inputs).toEqual(['./prisma/contract.ts']);
  });

  it('derives the output path by swapping the contract extension to .json', () => {
    expect(defineConfig({ contract: './foo/bar.prisma' }).contract?.output).toBe('./foo/bar.json');
    expect(defineConfig({ contract: './foo/bar.ts' }).contract?.output).toBe('./foo/bar.json');
  });

  it('writes contract.json into the given output directory when provided', () => {
    const config = defineConfig({
      contract: './prisma/my-schema.prisma',
      output: './custom/dir',
    });

    expect(config.contract?.output).toBe('custom/dir/contract.json');
  });
});
