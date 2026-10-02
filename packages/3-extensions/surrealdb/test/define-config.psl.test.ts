import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import surrealAdapter from '@internal/adapter-surrealdb/control';
import surrealDriver from '@internal/driver-surrealdb/control';
import { surrealFamilyDescriptor } from '@internal/family-surreal/control';
import { createControlStack } from '@internal/framework-components/control';
import surrealTarget from '@internal/target-surrealdb/control';
import { join } from 'pathe';
import { afterAll, describe, expect, it } from 'vitest';
import { defineConfig } from '../src/config/define-config';

const dir = mkdtempSync(join(tmpdir(), 'surreal-define-config-psl-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function load(files: Readonly<Record<string, string>>) {
  const stack = createControlStack({
    family: surrealFamilyDescriptor,
    target: surrealTarget,
    adapter: surrealAdapter,
    driver: surrealDriver,
  });
  const paths = Object.entries(files).map(([name, text]) => {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  });
  const source = defineConfig({ contract: join(dir, '*.prisma') }).contract?.source;
  if (source === undefined) throw new Error('expected a contract source');
  return source.load({
    composedExtensions: [],
    composedExtensionContracts: stack.extensionContracts,
    authoringContributions: stack.authoringContributions,
    codecLookup: stack.codecLookup,
    controlMutationDefaults: stack.controlMutationDefaults,
    dataTypeLookup: stack.dataTypeLookup,
    resolvedInputs: paths,
    capabilities: stack.capabilities,
  });
}

describe('a Prisma 8 SurrealDB schema read through defineConfig', () => {
  it('interprets every opted-in member file against the SurrealDB stack', async () => {
    const result = await load({
      'author.prisma': '// use prisma-8\nmodel Author {\n  id String @id\n  price Decimal\n}\n',
      'post.prisma': '// use prisma-8\nmodel Post {\n  id String @id\n  author Author?\n}\n',
      'draft.prisma': 'model Draft {\n  id String @id\n}\n',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const models = result.value.domain.namespaces['__unbound__']?.models ?? {};
    expect(Object.keys(models).sort()).toEqual(['Author', 'Post']);
  });
});
