import { describe, expect, it } from 'vitest';
import { canonicalizeDefinition, isGeneratedArrayChild } from '../src/exports/index';

/**
 * Left is what this codebase renders; right is what SurrealDB v3.2.4 echoes
 * back for that exact input. Canonicalization has to collapse each pair, or
 * the differ reports drift on a database that is already correct.
 */
const OBSERVED_PAIRS: readonly [string, string, string][] = [
  [
    'unquotes identifiers and drops a materialized PERMISSIONS default',
    'DEFINE TABLE `person` TYPE NORMAL SCHEMAFULL',
    'DEFINE TABLE person TYPE NORMAL SCHEMAFULL PERMISSIONS NONE',
  ],
  [
    'collapses a relation table definition',
    'DEFINE TABLE `follows` TYPE RELATION IN `person` OUT `person` SCHEMALESS',
    'DEFINE TABLE follows TYPE RELATION IN person OUT person SCHEMALESS PERMISSIONS NONE',
  ],
  [
    'expands option sugar the way SurrealDB stores it',
    'DEFINE FIELD `balance` ON TABLE `person` TYPE option<decimal>',
    'DEFINE FIELD balance ON person TYPE none | decimal PERMISSIONS FULL',
  ],
  [
    'keeps FLEXIBLE in the position SurrealDB reports it',
    'DEFINE FIELD `meta` ON TABLE `person` TYPE object FLEXIBLE',
    'DEFINE FIELD meta ON person TYPE object FLEXIBLE PERMISSIONS FULL',
  ],
  [
    'drops the BM25 defaults SurrealDB fills in',
    'DEFINE INDEX `doc_ft` ON TABLE `doc` FIELDS `body` FULLTEXT ANALYZER `english` BM25',
    'DEFINE INDEX doc_ft ON doc FIELDS body FULLTEXT ANALYZER english BM25(1.2,0.75)',
  ],
  [
    'drops the HNSW tuning tail, including the derived LM float',
    'DEFINE INDEX `doc_vec` ON TABLE `doc` FIELDS `embedding` HNSW DIMENSION 3 DIST COSINE',
    'DEFINE INDEX doc_vec ON doc FIELDS embedding HNSW DIMENSION 3 DIST COSINE TYPE F32 EFC 150 M 12 M0 24 LM 0.40242960438184466f',
  ],
  [
    'upper-cases analyzer tokenizers and filters',
    'DEFINE ANALYZER `english` TOKENIZERS blank,class FILTERS lowercase',
    'DEFINE ANALYZER english TOKENIZERS BLANK,CLASS FILTERS LOWERCASE',
  ],
  [
    'collapses a plain unique index, which SurrealDB echoes unchanged',
    'DEFINE INDEX `person_name_uq` ON TABLE `person` FIELDS `name` UNIQUE',
    'DEFINE INDEX person_name_uq ON person FIELDS name UNIQUE',
  ],
];

describe('canonicalizeDefinition', () => {
  it.each(OBSERVED_PAIRS)('%s', (_label, rendered, echoed) => {
    expect(canonicalizeDefinition(rendered)).toBe(canonicalizeDefinition(echoed));
  });

  it('collapses whitespace runs', () => {
    expect(canonicalizeDefinition('DEFINE  TABLE   person')).toBe('DEFINE TABLE person');
  });

  it('expands a nested option type without losing the inner constructor', () => {
    expect(canonicalizeDefinition('TYPE option<array<record<person>>>')).toBe(
      'TYPE none | array<record<person>>',
    );
  });

  it('still distinguishes definitions that genuinely differ', () => {
    expect(canonicalizeDefinition('DEFINE FIELD `age` ON TABLE `person` TYPE int')).not.toBe(
      canonicalizeDefinition('DEFINE FIELD age ON person TYPE string PERMISSIONS FULL'),
    );
  });

  it('does not treat SCHEMAFULL and SCHEMALESS as equal', () => {
    expect(canonicalizeDefinition('DEFINE TABLE `t` TYPE NORMAL SCHEMAFULL')).not.toBe(
      canonicalizeDefinition('DEFINE TABLE t TYPE NORMAL SCHEMALESS PERMISSIONS NONE'),
    );
  });

  it('keeps a non-default permission clause, which is real configuration', () => {
    expect(
      canonicalizeDefinition('DEFINE TABLE `t` TYPE NORMAL SCHEMAFULL PERMISSIONS FOR select true'),
    ).toContain('FOR select true');
  });
});

describe('isGeneratedArrayChild', () => {
  it('recognises the child SurrealDB adds for a declared array field', () => {
    expect(isGeneratedArrayChild('embedding.*', new Set(['embedding']))).toBe(true);
  });

  it('leaves a wildcard whose parent was never declared alone', () => {
    expect(isGeneratedArrayChild('orphan.*', new Set(['embedding']))).toBe(false);
  });

  it('ignores an ordinary field path', () => {
    expect(isGeneratedArrayChild('embedding', new Set(['embedding']))).toBe(false);
  });
});
