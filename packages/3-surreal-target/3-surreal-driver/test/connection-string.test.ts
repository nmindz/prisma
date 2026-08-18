import { describe, expect, it } from 'vitest';
import { parseSurrealConnectionString } from '../src/core/control-driver';

describe('parseSurrealConnectionString', () => {
  it('reads namespace and database from the path after /rpc', () => {
    expect(parseSurrealConnectionString('ws://root:secret@127.0.0.1:8112/rpc/app/main')).toEqual({
      url: 'ws://127.0.0.1:8112/rpc',
      namespace: 'app',
      database: 'main',
      username: 'root',
      password: 'secret',
    });
  });

  it('accepts a path without the /rpc segment', () => {
    expect(parseSurrealConnectionString('wss://example.com/app/main')).toMatchObject({
      url: 'wss://example.com/rpc',
      namespace: 'app',
      database: 'main',
    });
  });

  it('omits credentials when the URL carries none', () => {
    const binding = parseSurrealConnectionString('ws://127.0.0.1:8112/rpc/app/main');
    expect(binding.username).toBeUndefined();
    expect(binding.password).toBeUndefined();
  });

  it('percent-decodes credentials and names', () => {
    expect(
      parseSurrealConnectionString('ws://a%40b:p%2Fw@127.0.0.1:8112/rpc/my%20ns/my%20db'),
    ).toMatchObject({
      namespace: 'my ns',
      database: 'my db',
      username: 'a@b',
      password: 'p/w',
    });
  });

  it('rejects a URL that names no namespace and database', () => {
    expect(() => parseSurrealConnectionString('ws://127.0.0.1:8112/rpc')).toThrow(
      /no namespace and database/,
    );
  });

  it('rejects text that is not a URL', () => {
    expect(() => parseSurrealConnectionString('not a url')).toThrow(/Invalid SurrealDB/);
  });
});
