import { describe, expect, it } from 'vitest';
import { parseSurrealConnectionString } from '../src/core/control-driver';

describe('parseSurrealConnectionString', () => {
  it('reads namespace and database from the path after /rpc', () => {
    // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket -- parsed as text, never opened as a socket
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
      // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket -- parsed as text, never opened as a socket
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

  it('rejects a scheme other than ws: or wss:', () => {
    expect(() => parseSurrealConnectionString('http://127.0.0.1:8112/rpc/app/main')).toThrow(
      /unsupported scheme/,
    );
  });

  it('names the offending scheme without echoing the connection string', () => {
    let thrown: unknown;
    try {
      parseSurrealConnectionString('http://root:secret@127.0.0.1:8112/rpc/app/main');
    } catch (error) {
      thrown = error;
    }
    expect(String(thrown)).toContain('http:');
    expect(String(thrown)).not.toContain('secret');
  });

  it('rejects malformed percent-encoding in the namespace', () => {
    expect(() => parseSurrealConnectionString('ws://127.0.0.1:8112/rpc/app%/main')).toThrow(
      /percent-encoding/,
    );
  });

  it('rejects malformed percent-encoding in the password without echoing it', () => {
    let thrown: unknown;
    try {
      // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket -- parsed as text, never opened as a socket
      parseSurrealConnectionString('ws://root:bad%2@127.0.0.1:8112/rpc/app/main');
    } catch (error) {
      thrown = error;
    }
    expect(String(thrown)).toMatch(/percent-encoding/);
    expect(String(thrown)).not.toContain('bad%2');
  });
});
