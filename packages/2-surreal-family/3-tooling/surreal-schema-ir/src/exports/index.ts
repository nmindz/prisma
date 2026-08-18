export { canonicalizeDefinition, isGeneratedArrayChild } from '../canonicalize-definition';
export type { DiffOptions, SurrealSchemaOperation } from '../diff-schemas';
export { diffSurrealSchemas, schemasMatch } from '../diff-schemas';
export type { InfoForDbResult, InfoForTableResult } from '../introspect';
export { buildSurrealSchemaIR, parseInfoForDb, parseInfoForTable } from '../introspect';
export type { SurrealSchemaIR, SurrealTableSchema } from '../schema-ir';
export { emptySurrealSchemaIR } from '../schema-ir';
