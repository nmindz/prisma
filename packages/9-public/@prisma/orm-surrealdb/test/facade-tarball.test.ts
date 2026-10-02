import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicShells, type ShellName } from '@internal/publish-surface/shells';
import {
  bundledSources,
  findInternalImportSpecifiers,
  findInternalNames,
  importSubpaths,
  installShells,
  type PackedShell,
  packShell,
  runInScratch,
} from '@repo/tsdown/shell-testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const facade = '@prisma/orm-surrealdb';
const platform: ShellName[] = [
  '@prisma/orm-framework',
  '@prisma/orm-toolchain',
  '@prisma/orm-family-surreal',
  '@prisma/orm-target-surrealdb',
];

function pack(scratch: string, names: readonly ShellName[]): PackedShell[] {
  return names.map((name) => {
    const shell = publicShells.get(name);
    if (shell === undefined) throw new Error(`unknown shell ${name}`);
    return packShell(join(repoRoot, shell.dir), scratch);
  });
}

describe('an application that installs only the SurrealDB facade', () => {
  let scratch: string;
  let installedDir: string;

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'orm-surrealdb-facade-'));
    installShells(scratch, pack(scratch, [facade, ...platform]), { direct: [facade] });
    installedDir = join(scratch, 'node_modules', '@prisma', 'orm-surrealdb');
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('resolves and imports every facade entrypoint', () => {
    const subpaths = importSubpaths(installedDir);
    expect(subpaths.length).toBeGreaterThan(70);
    // The surfaces an application reaches for by hand, as opposed to the
    // ones only generated files name. An application depends on the facade
    // and nothing else, so a missing name here is a package it cannot
    // import at all (ADR 242). `orm-client` is the collection-loading ORM
    // client; `orm` is the separate collection query-lane it is not, and
    // both have to resolve on their own subpath.
    expect(subpaths).toEqual(
      expect.arrayContaining([
        './orm-client',
        './orm',
        './query-builder',
        './static',
        './family-runtime',
        './family/control',
        './utils/casts',
        './vite-plugin-contract-emit',
      ]),
    );
    const script = [
      `const subpaths = ${JSON.stringify(subpaths)};`,
      'for (const subpath of subpaths) {',
      `  await import('${facade}' + subpath.slice(1));`,
      '}',
      `console.log('resolved ' + subpaths.length);`,
    ].join('\n');
    expect(runInScratch(scratch, script)).toContain(`resolved ${subpaths.length}`);
  });

  it('pulls every platform shell in transitively', () => {
    const script = [
      "import { createRequire } from 'node:module';",
      `const require = createRequire(import.meta.resolve('${facade}/package.json'));`,
      `const shells = ${JSON.stringify(platform)};`,
      'for (const shell of shells) require.resolve(shell + "/package.json");',
      `console.log('platform ok');`,
    ].join('\n');
    expect(runInScratch(scratch, script)).toContain('platform ok');
  });

  it('links no bin from the facade — the unified prisma CLI is the only binary', () => {
    // The published surface is bin-less: the toolchain exports the orm
    // command family at ./cli for the unified `prisma` CLI to import, and
    // the facade forwards no launcher.
    expect(existsSync(join(scratch, 'node_modules', '.bin', 'prisma-next'))).toBe(false);
  });

  it('bundles only its own wiring code', () => {
    const sources = bundledSources(installedDir);
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(source).toMatch(/^3-extensions\/surrealdb\//);
    }
  });

  it('ships no unrecorded internal package name in dist', async () => {
    expect(await findInternalNames(installedDir)).toEqual([]);
  });

  it('ships no @internal import specifier in dist', async () => {
    expect(await findInternalImportSpecifiers(installedDir)).toEqual([]);
  });
});

describe('the SurrealDB facade alongside its platform shells', () => {
  let scratch: string;

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'orm-surrealdb-identity-'));
    installShells(scratch, pack(scratch, [facade, ...platform]));
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('shares one module instance across every facade to shell boundary', () => {
    const script = `
      import { strict as assert } from 'node:assert';
      const facadeContract = await import('${facade}/contract/is-plain-record');
      const frameworkContract = await import('@prisma/orm-framework/contract/is-plain-record');
      assert.equal(facadeContract.isPlainRecord, frameworkContract.isPlainRecord);

      const facadeComponents = await import('${facade}/components/execution');
      const frameworkComponents = await import('@prisma/orm-framework/components/execution');
      assert.equal(facadeComponents.instantiateExecutionStack, frameworkComponents.instantiateExecutionStack);

      const facadeFamily = await import('${facade}/family-contract/entity-kinds');
      const familyShell = await import('@prisma/orm-family-surreal/contract/entity-kinds');
      assert.equal(facadeFamily.tableEntityKind, familyShell.tableEntityKind);

      const facadeAdapter = await import('${facade}/adapter/runtime');
      const targetAdapter = await import('@prisma/orm-target-surrealdb/adapter/runtime');
      assert.equal(facadeAdapter.default, targetAdapter.default);

      const facadeTarget = await import('${facade}/target/pack');
      const targetPack = await import('@prisma/orm-target-surrealdb/target/pack');
      assert.equal(facadeTarget.default, targetPack.default);
      console.log('identity ok');
    `;
    expect(runInScratch(scratch, script)).toContain('identity ok');
  });

  it('reaches the ORM client only through the Surreal family shell', () => {
    const facadeSources = bundledSources(join(scratch, 'node_modules', '@prisma', 'orm-surrealdb'));
    expect(facadeSources.filter((s) => s.includes('surreal-orm-client'))).toEqual([]);
    const script = `
      import { strict as assert } from 'node:assert';
      const { orm } = await import('@prisma/orm-family-surreal/orm-client');
      assert.equal(typeof orm, 'function');
      console.log('orm-client ok');
    `;
    expect(runInScratch(scratch, script)).toContain('orm-client ok');
  });

  // The ORM client's `orm` (record-loading, collection graph) and the
  // separate `orm` query lane's own `orm` (the collection registry this
  // suite is forbidden from reading) share a name but are not the same
  // function. A packaging mistake that pointed one facade subpath at the
  // other's dist file would still satisfy every "resolves" check above —
  // only comparing the two by reference catches it.
  it('keeps the orm-client entrypoint distinct from the orm query-lane entrypoint', () => {
    const script = `
      import { strict as assert } from 'node:assert';
      const ormClient = await import('${facade}/orm-client');
      const ormLane = await import('${facade}/orm');
      assert.equal(typeof ormClient.orm, 'function');
      assert.equal(typeof ormLane.orm, 'function');
      assert.notEqual(ormClient.orm, ormLane.orm);
      assert.equal(typeof ormClient.toOrmClientPlan, 'function');
      assert.equal(ormLane.toOrmClientPlan, undefined);
      console.log('orm-client distinct ok');
    `;
    expect(runInScratch(scratch, script)).toContain('orm-client distinct ok');
  });

  // The entrypoints an application reaches for by hand. Each has to be the
  // same module the platform shell publishes, not a second copy: the ORM
  // client's collection loader, the runtime's execution stack and the
  // family's IR classes are all compared by reference.
  it('shares one module instance for every hand-reached surface', () => {
    const script = `
      import { strict as assert } from 'node:assert';
      const pairs = [
        ['orm-client', '@prisma/orm-family-surreal/orm-client', 'orm'],
        ['orm', '@prisma/orm-family-surreal/orm', 'orm'],
        ['query-builder', '@prisma/orm-family-surreal/query-builder', 'selectFrom'],
        ['family-runtime', '@prisma/orm-family-surreal/runtime', 'createSurrealRuntime'],
        ['family/control', '@prisma/orm-family-surreal/family/control', 'surrealFamilyDescriptor'],
        ['utils/casts', '@prisma/orm-framework/utils/casts', 'castAs'],
      ];
      for (const [subpath, platform, name] of pairs) {
        const viaFacade = await import('@prisma/orm-surrealdb/' + subpath);
        const viaPlatform = await import(platform);
        assert.equal(typeof viaFacade[name], typeof viaPlatform[name], subpath);
        assert.equal(viaFacade[name], viaPlatform[name], subpath);
      }
      console.log('forwarded identity ok');
    `;
    expect(runInScratch(scratch, script)).toContain('forwarded identity ok');
  });
});
