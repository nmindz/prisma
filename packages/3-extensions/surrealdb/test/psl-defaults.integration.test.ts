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

/** The backtick fencing a tagged literal, as an escape so no quoted string in this file holds one. */
const BACKTICK = '\u0060';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const model = (fields: string) =>
  `// use prisma-8\nmodel Widget {\n  id String @id\n${fields}\n}\n`;

/** Reads one schema file through `defineConfig` against the real SurrealDB control stack. */
async function load(schema: string) {
  const stack = createControlStack({
    family: surrealFamilyDescriptor,
    target: surrealTarget,
    adapter: surrealAdapter,
    driver: surrealDriver,
  });
  const dir = mkdtempSync(join(tmpdir(), 'surreal-psl-defaults-'));
  dirs.push(dir);
  const path = join(dir, 'schema.prisma');
  writeFileSync(path, schema);
  const source = defineConfig({ contract: join(dir, '*.prisma') }).contract?.source;
  if (source === undefined) throw new Error('expected a contract source');
  return source.load({
    composedExtensions: [],
    composedExtensionContracts: stack.extensionContracts,
    authoringContributions: stack.authoringContributions,
    codecLookup: stack.codecLookup,
    controlMutationDefaults: stack.controlMutationDefaults,
    dataTypeLookup: stack.dataTypeLookup,
    resolvedInputs: [path],
    capabilities: stack.capabilities,
  });
}

type StoredDefault = { readonly defaultValue?: unknown; readonly defaultExpression?: string };

async function fieldDefaults(fields: string): Promise<Readonly<Record<string, StoredDefault>>> {
  const result = await load(model(fields));
  if (!result.ok) throw new Error(JSON.stringify(result.failure.diagnostics, null, 2));
  const storage = result.value.storage as unknown as {
    namespaces: Record<
      string,
      {
        entries: {
          table: Record<string, { fields: readonly (StoredDefault & { name: string })[] }>;
        };
      }
    >;
  };
  const stored = storage.namespaces['__unbound__']?.entries.table['widget']?.fields ?? [];
  return Object.fromEntries(
    stored.map(({ name, defaultValue, defaultExpression }) => [
      name,
      {
        ...(defaultValue === undefined ? {} : { defaultValue }),
        ...(defaultExpression === undefined ? {} : { defaultExpression }),
      },
    ]),
  );
}

describe('PSL @default values read through the SurrealDB control stack', () => {
  it('stores each literal default as the canonical form of its field type', async () => {
    expect(
      await fieldDefaults(`  count   Int      @default(42)
  big     Decimal  @default(9007199254740993)
  price   Decimal  @default(1.50)
  ratio   Float    @default(1)
  label   String   @default("it's fine")
  active  Boolean  @default(true)
  created DateTime @default("2024-01-01T01:00:00+01:00")
  scores  Int[]    @default([1, 2])`),
    ).toEqual({
      count: { defaultValue: 42 },
      big: { defaultValue: '9007199254740993' },
      price: { defaultValue: '1.50' },
      ratio: { defaultValue: 1 },
      label: { defaultValue: "it's fine" },
      active: { defaultValue: true },
      created: { defaultValue: '2024-01-01T00:00:00Z' },
      scores: { defaultValue: [1, 2] },
    });
  });

  it('keeps default functions as SurrealQL expressions', async () => {
    expect(
      await fieldDefaults(`  stamp DateTime @default(now())
  token String   @default(uuid())
  code  String   @default(cuid())`),
    ).toEqual({
      stamp: { defaultExpression: 'time::now()' },
      token: { defaultExpression: 'rand::uuid()' },
      code: { defaultExpression: 'rand::ulid()' },
    });
  });

  it('stores a surql default as its expression', async () => {
    expect(
      await fieldDefaults(
        `  expires DateTime @default(surql${BACKTICK}time::now() + 1d${BACKTICK})`,
      ),
    ).toEqual({ expires: { defaultExpression: 'time::now() + 1d' } });
  });

  it('refuses Int @default(1.5), naming the types surrealdb/int casts from', async () => {
    const result = await load(model('  count Int @default(1.5)'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.diagnostics).toEqual([
      expect.objectContaining({
        code: 'PSL_VALUE_TYPE_INCOMPATIBLE',
        message:
          'Field "Widget.count": surrealdb/int has no cast from surrealdb/decimal; it casts from nothing',
      }),
    ]);
  });
});
