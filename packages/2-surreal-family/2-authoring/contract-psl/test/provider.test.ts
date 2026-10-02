import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { ContractSourceContext } from '@internal/config/config-types';
import { createDataTypeLookup, emptyCodecLookup } from '@internal/framework-components/codec';
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
    dataTypeLookup: createDataTypeLookup([]),
    authoringContributions: {
      dataTypes: {},
      field: {},
      type: {},
      entityTypes: {},
      pslBlockDescriptors: {},
      modelAttributes: {},
      attributeSpecs: { model: {}, field: {} },
    },
    codecLookup: { ...emptyCodecLookup, descriptorFor: () => undefined },
    controlMutationDefaults: {
      defaultFunctionRegistry: new Map(),
      generatorDescriptors: [],
    },
    resolvedInputs: [],
    capabilities: {},
    ...overrides,
  };
}

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
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

  it('errors naming the configured pattern when resolvedInputs is empty', async () => {
    const contract = surrealContract('./prisma/**/*.prisma');
    const result = await contract.source.load(createSurrealTestContext());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toEqual({
      summary: 'No schema files matched the configured contract source',
      diagnostics: [
        {
          code: 'PSL_NO_SCHEMA_FILES_MATCHED',
          message: 'No files matched the configured pattern "./prisma/**/*.prisma"',
          sourceId: './prisma/**/*.prisma',
        },
      ],
    });
  });

  it('resolves relative schema paths from configDir when cwd differs', async () => {
    const configDir = await tempDir('surreal-psl-provider-config-');
    const cwdDir = await tempDir('surreal-psl-provider-cwd-');
    const schemaPath = join(configDir, 'schema.prisma');
    await writeFile(
      schemaPath,
      `// use prisma-8
model User {
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
    const dir = await tempDir('surreal-psl-provider-');
    const missingSchemaPath = join(dir, 'missing.prisma');
    const contract = surrealContract('./missing.prisma');
    const result = await contract.source.load(
      createSurrealTestContext({ resolvedInputs: [missingSchemaPath] }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.failure).toEqual({
      summary: 'Failed to read Prisma schema files',
      diagnostics: [
        {
          code: 'PSL_SCHEMA_READ_FAILED',
          message: expect.stringContaining('missing.prisma'),
          sourceId: missingSchemaPath,
        },
      ],
    });
  });

  it('reports interpreter diagnostics against the schema file that declares them', async () => {
    const dir = await tempDir('surreal-psl-provider-');
    const schemaPath = join(dir, 'schema.prisma');
    await writeFile(
      schemaPath,
      `// use prisma-8
model User {
  id        String   @id
  updatedAt DateTime @updatedAt
}
`,
      'utf-8',
    );

    const result = await surrealContract('./schema.prisma').source.load(
      createSurrealTestContext({ resolvedInputs: [schemaPath] }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toEqual({
      summary: 'PSL to Surreal contract interpretation failed',
      diagnostics: [
        {
          code: 'PSL_UNSUPPORTED_FIELD_ATTRIBUTE',
          message: 'Field "User.updatedAt" uses unsupported attribute "@updatedAt"',
          sourceId: schemaPath,
          span: {
            start: { offset: 75, line: 4, column: 22 },
            end: { offset: 85, line: 4, column: 32 },
          },
        },
      ],
    });
  });

  it('merges parse diagnostics with interpreter diagnostics', async () => {
    const dir = await tempDir('surreal-psl-provider-');
    const schemaPath = join(dir, 'schema.prisma');
    await writeFile(
      schemaPath,
      `// use prisma-8
model User {
  id String @id
  payload Mystery
}
model Broken {
`,
      'utf-8',
    );

    const result = await surrealContract('./schema.prisma').source.load(
      createSurrealTestContext({ resolvedInputs: [schemaPath] }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const codes = result.failure.diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toContain('PSL_UNRESOLVED_REFERENCE');
    expect(codes.length).toBeGreaterThan(1);
    for (const diagnostic of result.failure.diagnostics) {
      expect(diagnostic.sourceId).toBe(schemaPath);
    }
  });

  describe('membership set', () => {
    async function writeMultiFileFixture(dir: string): Promise<{
      readonly author: string;
      readonly post: string;
      readonly excluded: string;
    }> {
      const author = join(dir, 'author.prisma');
      const post = join(dir, 'post.prisma');
      const excluded = join(dir, 'draft.prisma');
      await writeFile(author, '// use prisma-8\nmodel Author {\n  id String @id\n}\n', 'utf-8');
      await writeFile(
        post,
        '// use prisma-8\nmodel Post {\n  id String @id\n  author Author?\n}\n',
        'utf-8',
      );
      await writeFile(excluded, 'model Draft {\n  id String @id\n}\n', 'utf-8');
      return { author, post, excluded };
    }

    it('emits one contract from every member and excludes a matched file without the directive', async () => {
      const dir = await tempDir('surreal-psl-provider-membership-');
      const { author, post, excluded } = await writeMultiFileFixture(dir);

      const result = await surrealContract('./prisma/*.prisma').source.load(
        createSurrealTestContext({ resolvedInputs: [author, post, excluded] }),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const models = result.value.domain.namespaces['__unbound__']?.models ?? {};
      expect(Object.keys(models).sort()).toEqual(['Author', 'Post']);
      expect(models['Post']?.relations).toEqual({
        author: {
          to: { namespace: '__unbound__', model: 'Author' },
          cardinality: 'N:1',
          nullable: true,
          on: { localFields: ['author'], targetFields: ['id'] },
        },
      });
    });

    it('emits a byte-identical contract regardless of resolvedInputs order', async () => {
      const dir = await tempDir('surreal-psl-provider-membership-');
      const { author, post } = await writeMultiFileFixture(dir);
      const contract = surrealContract('./prisma/*.prisma');

      const forward = await contract.source.load(
        createSurrealTestContext({ resolvedInputs: [author, post] }),
      );
      const reversed = await contract.source.load(
        createSurrealTestContext({ resolvedInputs: [post, author] }),
      );

      expect(forward.ok).toBe(true);
      expect(reversed.ok).toBe(true);
      if (!forward.ok || !reversed.ok) return;
      expect(JSON.stringify(reversed.value)).toBe(JSON.stringify(forward.value));
    });

    it('reports a schema error in the member file that declares it', async () => {
      const dir = await tempDir('surreal-psl-provider-membership-');
      const { author } = await writeMultiFileFixture(dir);
      const broken = join(dir, 'broken.prisma');
      await writeFile(broken, '// use prisma-8\nmodel Broken {\n  title String\n}\n', 'utf-8');

      const result = await surrealContract('./prisma/*.prisma').source.load(
        createSurrealTestContext({ resolvedInputs: [author, broken] }),
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics).toEqual([
        expect.objectContaining({ code: 'PSL_MISSING_ID_FIELD', sourceId: broken }),
      ]);
    });

    it('errors listing the candidates when none carries the directive', async () => {
      const dir = await tempDir('surreal-psl-provider-membership-');
      const a = join(dir, 'a.prisma');
      await writeFile(a, 'model A {\n  id String @id\n}\n', 'utf-8');

      const result = await surrealContract('./prisma/*.prisma').source.load(
        createSurrealTestContext({ resolvedInputs: [a] }),
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure).toEqual({
        summary: 'No schema file carries the "// use prisma-8" directive',
        diagnostics: [
          {
            code: 'PSL_NO_OPTED_IN_SCHEMA_FILES',
            message: `None of the matched files carry the "// use prisma-8" directive: ${a}`,
            sourceId: './prisma/*.prisma',
          },
        ],
      });
    });

    it('keeps interpreting the readable members when another member cannot be read', async () => {
      const dir = await tempDir('surreal-psl-provider-membership-');
      const { author } = await writeMultiFileFixture(dir);
      const missing = join(dir, 'missing.prisma');

      const result = await surrealContract('./prisma/*.prisma').source.load(
        createSurrealTestContext({ resolvedInputs: [author, missing] }),
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics).toEqual([
        expect.objectContaining({ code: 'PSL_SCHEMA_READ_FAILED', sourceId: missing }),
      ]);
    });
  });
});
