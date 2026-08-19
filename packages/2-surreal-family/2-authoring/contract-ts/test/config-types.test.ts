import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { ContractSourceContext } from '@internal/config/config-types';
import type { Contract, ControlPolicy } from '@internal/contract/types';
import { emptyCodecLookup } from '@internal/framework-components/codec';
import { timeouts } from '@repo/test-utils';
import { join } from 'pathe';
import { describe, expect, it } from 'vitest';
import { typescriptContract, typescriptContractFromPath } from '../src/config-types';

const emptyContext: ContractSourceContext = {
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
};

function minimalSurrealContract(overrides?: {
  readonly defaultControlPolicy?: ControlPolicy;
}): Contract {
  return {
    targetFamily: 'surreal',
    target: 'surrealdb',
    ...overrides,
  } as unknown as Contract;
}

describe('source format discriminator', () => {
  it('typescriptContract tags the source as TypeScript', () => {
    const config = typescriptContract(minimalSurrealContract());
    expect(config.source.format).toBe('typescript');
  });

  it('typescriptContractFromPath tags the source as TypeScript', () => {
    const config = typescriptContractFromPath('./contract.ts');
    expect(config.source.format).toBe('typescript');
  });
});

describe('defaultControlPolicy specifier precedence', () => {
  it('keeps an existing contract default when the specifier sets another', async () => {
    const contract = minimalSurrealContract({ defaultControlPolicy: 'managed' });
    const config = typescriptContract(contract, undefined, { defaultControlPolicy: 'external' });
    const result = await config.source.load(emptyContext);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.defaultControlPolicy).toBe('managed');
  });

  it('applies the specifier default when the contract omits one', async () => {
    const contract = minimalSurrealContract();
    const config = typescriptContract(contract, undefined, { defaultControlPolicy: 'external' });
    const result = await config.source.load(emptyContext);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.defaultControlPolicy).toBe('external');
  });

  it('leaves defaultControlPolicy unset when the specifier omits it', async () => {
    const contract = minimalSurrealContract();
    const config = typescriptContract(contract);
    const result = await config.source.load(emptyContext);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toHaveProperty('defaultControlPolicy');
  });
});

describe('typescriptContract', () => {
  it('returns the contract as-is and records the output path', async () => {
    const contract = minimalSurrealContract();
    const config = typescriptContract(contract, 'output/contract.json');
    const result = await config.source.load(emptyContext);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value).toBe(contract);
    expect(config.output).toBe('output/contract.json');
    expect(config.source.inputs).toBeUndefined();
  });

  it('omits output when not provided', () => {
    const config = typescriptContract(minimalSurrealContract());

    expect(config.output).toBeUndefined();
    expect(config.source.inputs).toBeUndefined();
  });
});

describe('typescriptContractFromPath', () => {
  it(
    'loads a contract module from the resolved input path',
    async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'surreal-contract-ts-'));
      const contractPath = join(tempDir, 'contract.ts');

      try {
        await writeFile(
          contractPath,
          `export default { targetFamily: 'surreal', target: 'surrealdb' };\n`,
          'utf-8',
        );

        const config = typescriptContractFromPath('./contract.ts');
        const result = await config.source.load({
          ...emptyContext,
          resolvedInputs: [contractPath],
        });

        expect(result.ok).toBe(true);
        if (!result.ok) {
          return;
        }

        expect(result.value).toMatchObject({
          targetFamily: 'surreal',
          target: 'surrealdb',
        });
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
    timeouts.typeScriptCompilation,
  );

  it(
    'throws when the module exports neither default nor contract',
    async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'surreal-contract-ts-'));
      const contractPath = join(tempDir, 'contract.ts');

      try {
        await writeFile(contractPath, 'export const notContract = {};\n', 'utf-8');

        const config = typescriptContractFromPath('./contract.ts');

        await expect(
          config.source.load({
            ...emptyContext,
            resolvedInputs: [contractPath],
          }),
        ).rejects.toThrow(/has no "default" or "contract" export/);
        await expect(
          config.source.load({
            ...emptyContext,
            resolvedInputs: [contractPath],
          }),
        ).rejects.toMatchObject({ code: 'CONTRACT.MODULE_EXPORT_MISSING' });
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
    timeouts.typeScriptCompilation,
  );

  it('throws InternalError when resolvedInputs is empty', async () => {
    const config = typescriptContractFromPath('./contract.ts');

    await expect(config.source.load(emptyContext)).rejects.toMatchObject({
      isPrismaInternalError: true,
    });
  });
});
