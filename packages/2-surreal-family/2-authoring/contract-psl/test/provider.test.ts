import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { ContractSourceContext } from '@internal/config/config-types';
import { emptyCodecLookup } from '@internal/framework-components/codec';
import { join } from 'pathe';
import { afterEach, describe, expect, it } from 'vitest';
import { surrealContract } from '../src/exports/provider';

const originalCwd = process.cwd();
const tempDirs: string[] = [];

function createSurrealTestContext(
  overrides?: Partial<ContractSourceContext>,
): ContractSourceContext {
  return {
    composedExtensions: [],
    composedExtensionContracts: new Map(),
    authoringContributions: {
      field: {},
      type: {},
      entityTypes: {},
      pslBlockDescriptors: {},
      modelAttributes: {},
    },
    codecLookup: emptyCodecLookup,
    controlMutationDefaults: {
      defaultFunctionRegistry: new Map(),
      generatorDescriptors: [],
    },
    resolvedInputs: [],
    capabilities: {},
    ...overrides,
  };
}

describe('surrealContract provider helper', () => {
  afterEach(async () => {
    process.chdir(originalCwd);
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it('exposes watch inputs from schema path', () => {
    const config = surrealContract('./schema.prisma', {
      output: 'output/contract.json',
    });

    expect(config.output).toBe('output/contract.json');
    expect(config.source.inputs).toEqual(['./schema.prisma']);
  });

  it('tags the source as PSL', () => {
    const config = surrealContract('./schema.prisma');
    expect(config.source.format).toBe('psl');
  });

  it('throws InternalError when resolvedInputs is empty', async () => {
    const contract = surrealContract('./schema.prisma');

    await expect(contract.source.load(createSurrealTestContext())).rejects.toMatchObject({
      isPrismaInternalError: true,
    });
  });

  it('resolves relative schema paths from configDir when cwd differs', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'surreal-psl-provider-config-'));
    const cwdDir = await mkdtemp(join(tmpdir(), 'surreal-psl-provider-cwd-'));
    tempDirs.push(configDir, cwdDir);
    const schemaPath = join(configDir, 'schema.prisma');
    await writeFile(
      schemaPath,
      `model User {
  id String @id
  email String
}
`,
      'utf-8',
    );

    process.chdir(cwdDir);
    const contract = surrealContract('./schema.prisma');
    const result = await contract.source.load(
      createSurrealTestContext({ resolvedInputs: [schemaPath] }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toMatchObject({
      targetFamily: 'surreal',
      target: 'surrealdb',
      domain: {
        namespaces: {
          __unbound__: {
            models: {
              User: expect.any(Object),
            },
          },
        },
      },
    });
  });

  it('returns read failure diagnostics with the resolved absolute schema path', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'surreal-psl-provider-'));
    tempDirs.push(tempDir);
    const contract = surrealContract('./missing.prisma');
    const result = await contract.source.load(
      createSurrealTestContext({ resolvedInputs: [join(tempDir, 'missing.prisma')] }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.failure).toMatchObject({
      summary: 'Failed to read Prisma schema at "./missing.prisma"',
      diagnostics: [
        expect.objectContaining({
          code: 'PSL_SCHEMA_READ_FAILED',
          sourceId: './missing.prisma',
        }),
      ],
      meta: {
        schemaPath: './missing.prisma',
        absoluteSchemaPath: expect.stringMatching(/missing\.prisma$/),
        cause: expect.any(String),
      },
    });
  });
});
