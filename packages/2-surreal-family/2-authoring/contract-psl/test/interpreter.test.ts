import { UNBOUND_DOMAIN_NAMESPACE_ID } from '@internal/contract/default-namespace';
import { crossRef } from '@internal/contract/types';
import type { AuthoringContributions } from '@internal/framework-components/authoring';
import { UNBOUND_NAMESPACE_ID } from '@internal/framework-components/ir';
import { buildSymbolTable } from '@internal/psl-parser';
import { parse } from '@internal/psl-parser/syntax';
import { SurrealContractSchema } from '@internal/surreal-contract';
import { defineContract, index as indexOf, t } from '@internal/surreal-contract-ts';
import { type } from 'arktype';
import { describe, expect, it } from 'vitest';
import {
  type InterpretPslDocumentToSurrealContractInput,
  interpretPslDocumentToSurrealContract,
} from '../src/interpreter';
import {
  surrealFixtureCodecLookup,
  surrealFixtureDataTypeEntries,
  surrealFixtureDataTypeLookup,
} from './fixture-data-types';

type SchemaFiles = string | Readonly<Record<string, string>>;

function interpretInput(
  schema: SchemaFiles,
  authoringContributions?: AuthoringContributions,
): InterpretPslDocumentToSurrealContractInput {
  const files = typeof schema === 'string' ? { 'test.prisma': schema } : schema;
  const parsed = Object.entries(files).map(([path, text]) => parse(text, path));
  const documents = parsed.map(({ document }) => document);
  const [first, ...rest] = parsed.map(({ sources }) => sources);
  if (first === undefined) throw new Error('expected at least one schema file');
  const sources = first.merge(...rest);
  const { symbolTable } = buildSymbolTable({ documents, sources });
  return {
    documents,
    symbolTable,
    sources,
    authoringContributions: { dataTypes: surrealFixtureDataTypeEntries, ...authoringContributions },
    dataTypeLookup: surrealFixtureDataTypeLookup,
    codecLookup: surrealFixtureCodecLookup(),
  };
}

function interpretOk(schema: SchemaFiles) {
  const result = interpretPslDocumentToSurrealContract(interpretInput(schema));
  if (!result.ok) {
    throw new Error(`expected ok, got diagnostics: ${JSON.stringify(result.failure.diagnostics)}`);
  }
  return result.value;
}

function interpretDiagnostics(
  schema: SchemaFiles,
  authoringContributions?: AuthoringContributions,
) {
  const result = interpretPslDocumentToSurrealContract(
    interpretInput(schema, authoringContributions),
  );
  if (result.ok) {
    throw new Error('expected diagnostics, interpretation unexpectedly succeeded');
  }
  return result.failure.diagnostics;
}

type StorageTableShape = {
  readonly fields: readonly {
    readonly name: string;
    readonly type: unknown;
    readonly codecId: string;
    readonly defaultExpression?: string;
    readonly defaultValue?: unknown;
    readonly reference?: unknown;
  }[];
  readonly indexes: readonly {
    readonly name: string;
    readonly fields: readonly string[];
    readonly variant: unknown;
  }[];
};

function tableOf(ir: { readonly storage: unknown }, tableName: string): StorageTableShape {
  const storage = ir.storage as {
    namespaces: Record<string, { entries: { table: Record<string, StorageTableShape> } }>;
  };
  const table = storage.namespaces[UNBOUND_NAMESPACE_ID]?.entries.table[tableName];
  if (!table) throw new Error(`expected table "${tableName}" in the interpreted storage block`);
  return table;
}

function domainModel(
  ir: ReturnType<typeof interpretOk>,
  modelName: string,
): { readonly fields: unknown; readonly relations: unknown } {
  const model = ir.domain.namespaces[UNBOUND_DOMAIN_NAMESPACE_ID]?.models[modelName];
  if (!model) throw new Error(`expected domain model "${modelName}"`);
  return model;
}

describe('interpretPslDocumentToSurrealContract', () => {
  describe('scalar type mapping', () => {
    it('maps every supported PSL scalar to its SurrealQL scalar codec', () => {
      const ir = interpretOk(`
        model Widget {
          id       String   @id
          label    String
          count    Int
          weight   Float
          active   Boolean
          created  DateTime
          price    Decimal
          ttl      Duration
          token    Uuid
          payload  Bytes
        }
      `);

      expect(tableOf(ir, 'widget').fields).toEqual([
        { name: 'label', type: { kind: 'scalar', name: 'string' }, codecId: 'surrealdb/string@1' },
        { name: 'count', type: { kind: 'scalar', name: 'int' }, codecId: 'surrealdb/int@1' },
        { name: 'weight', type: { kind: 'scalar', name: 'float' }, codecId: 'surrealdb/float@1' },
        { name: 'active', type: { kind: 'scalar', name: 'bool' }, codecId: 'surrealdb/bool@1' },
        {
          name: 'created',
          type: { kind: 'scalar', name: 'datetime' },
          codecId: 'surrealdb/datetime@1',
        },
        {
          name: 'price',
          type: { kind: 'scalar', name: 'decimal' },
          codecId: 'surrealdb/decimal@1',
        },
        {
          name: 'ttl',
          type: { kind: 'scalar', name: 'duration' },
          codecId: 'surrealdb/duration@1',
        },
        { name: 'token', type: { kind: 'scalar', name: 'uuid' }, codecId: 'surrealdb/uuid@1' },
        { name: 'payload', type: { kind: 'scalar', name: 'bytes' }, codecId: 'surrealdb/bytes@1' },
      ]);
    });

    it('wraps optional fields in option<T> and reports them nullable in the domain', () => {
      const ir = interpretOk(`
        model Widget {
          id    String  @id
          nickname String?
        }
      `);

      expect(domainModel(ir, 'Widget').fields).toEqual({
        nickname: { type: { kind: 'scalar', codecId: 'surrealdb/string@1' }, nullable: true },
      });
    });

    it('wraps list scalar fields in array<T> with non-nullable elements in the domain', () => {
      const ir = interpretOk(`
        model Widget {
          id    String  @id
          tags  String[]
        }
      `);

      expect(tableOf(ir, 'widget').fields).toEqual([
        {
          name: 'tags',
          type: { kind: 'array', of: { kind: 'scalar', name: 'string' } },
          codecId: 'surrealdb/string@1',
        },
      ]);
      expect(domainModel(ir, 'Widget').fields).toEqual({
        tags: {
          type: { kind: 'scalar', codecId: 'surrealdb/string@1' },
          nullable: false,
          many: { elementNullable: false },
        },
      });
    });

    it('wraps nullable list elements T?[] in array<option<T>>', () => {
      const ir = interpretOk(`
        model Widget {
          id    String  @id
          tags  String?[]
        }
      `);

      expect(tableOf(ir, 'widget').fields).toEqual([
        {
          name: 'tags',
          type: { kind: 'array', of: { kind: 'option', of: { kind: 'scalar', name: 'string' } } },
          codecId: 'surrealdb/string@1',
        },
      ]);
      expect(domainModel(ir, 'Widget').fields).toEqual({
        tags: {
          type: { kind: 'scalar', codecId: 'surrealdb/string@1' },
          nullable: false,
          many: { elementNullable: true },
        },
      });
    });

    it('wraps an optional list T[]? in option<array<T>>', () => {
      const ir = interpretOk(`
        model Widget {
          id    String  @id
          tags  String[]?
        }
      `);

      expect(tableOf(ir, 'widget').fields).toEqual([
        {
          name: 'tags',
          type: { kind: 'option', of: { kind: 'array', of: { kind: 'scalar', name: 'string' } } },
          codecId: 'surrealdb/string@1',
        },
      ]);
      expect(domainModel(ir, 'Widget').fields).toEqual({
        tags: {
          type: { kind: 'scalar', codecId: 'surrealdb/string@1' },
          nullable: true,
          many: { elementNullable: false },
        },
      });
    });
  });

  describe('table naming', () => {
    it('lowercases the first letter of the model name by default', () => {
      const ir = interpretOk(`
        model UserAccount {
          id String @id
        }
      `);
      expect(ir.roots).toEqual({
        userAccount: crossRef('UserAccount', UNBOUND_DOMAIN_NAMESPACE_ID),
      });
    });

    it('honours @@map for the table name', () => {
      const ir = interpretOk(`
        model UserAccount {
          id String @id
          @@map("accounts")
        }
      `);
      expect(ir.roots).toEqual({ accounts: crossRef('UserAccount', UNBOUND_DOMAIN_NAMESPACE_ID) });
    });

    it('honours @map for field names, including in derived index names', () => {
      const ir = interpretOk(`
        model Widget {
          id    String @id
          email String @unique @map("email_address")
        }
      `);
      const table = tableOf(ir, 'widget');
      expect(table.fields).toEqual([
        {
          name: 'email_address',
          type: { kind: 'scalar', name: 'string' },
          codecId: 'surrealdb/string@1',
        },
      ]);
      expect(table.indexes).toEqual([
        {
          name: 'widget_email_address_unique',
          fields: ['email_address'],
          variant: { kind: 'unique' },
        },
      ]);
    });
  });

  describe('@id handling', () => {
    it('excludes the @id field from the storage table entirely', () => {
      const ir = interpretOk(`
        model Widget {
          id    String @id
          label String
        }
      `);
      expect(tableOf(ir, 'widget').fields.map((f) => f.name)).toEqual(['label']);
    });

    it('reports PSL_MISSING_ID_FIELD when a model has no @id field', () => {
      const diagnostics = interpretDiagnostics(`
        model Widget {
          label String
        }
      `);
      expect(diagnostics).toEqual([
        {
          code: 'PSL_MISSING_ID_FIELD',
          message:
            'Model "Widget" has no field with @id attribute. Every model must have exactly one @id field.',
          sourceId: 'test.prisma',
        },
      ]);
    });

    it('reports PSL_MULTIPLE_ID_FIELDS when a model has more than one @id field', () => {
      const diagnostics = interpretDiagnostics(`
        model Widget {
          id      String @id
          otherId String @id
        }
      `);
      expect(diagnostics).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'PSL_MULTIPLE_ID_FIELDS' })]),
      );
    });
  });

  describe('relations', () => {
    it('maps a non-list relation field to a record<table> link column', () => {
      const ir = interpretOk(`
        model Author {
          id   String @id
          name String
        }

        model Post {
          id     String @id
          title  String
          author Author
        }
      `);

      expect(tableOf(ir, 'post').fields).toContainEqual({
        name: 'author',
        type: { kind: 'record', tables: ['author'] },
        codecId: 'surrealdb/record@1',
      });

      expect(domainModel(ir, 'Post').relations).toEqual({
        author: {
          to: crossRef('Author', UNBOUND_DOMAIN_NAMESPACE_ID),
          cardinality: 'N:1',
          nullable: false,
          on: { localFields: ['author'], targetFields: ['id'] },
        },
      });
    });

    it('wraps an optional relation field in option<record<table>> and marks the relation nullable', () => {
      const ir = interpretOk(`
        model Author {
          id String @id
        }

        model Post {
          id     String  @id
          author Author?
        }
      `);
      expect(tableOf(ir, 'post').fields).toContainEqual({
        name: 'author',
        type: { kind: 'option', of: { kind: 'record', tables: ['author'] } },
        codecId: 'surrealdb/record@1',
      });
      expect(domainModel(ir, 'Post').relations).toEqual({
        author: {
          to: crossRef('Author', UNBOUND_DOMAIN_NAMESPACE_ID),
          cardinality: 'N:1',
          nullable: true,
          on: { localFields: ['author'], targetFields: ['id'] },
        },
      });
    });

    it('links to the @@map table name of the target model', () => {
      const ir = interpretOk(`
        model Author {
          id String @id
          @@map("writers")
        }

        model Post {
          id     String @id
          author Author @map("written_by")
        }
      `);
      expect(tableOf(ir, 'post').fields).toEqual([
        {
          name: 'written_by',
          type: { kind: 'record', tables: ['writers'] },
          codecId: 'surrealdb/record@1',
        },
      ]);
      expect(domainModel(ir, 'Post').relations).toEqual({
        author: {
          to: crossRef('Author', UNBOUND_DOMAIN_NAMESPACE_ID),
          cardinality: 'N:1',
          nullable: false,
          on: { localFields: ['written_by'], targetFields: ['id'] },
        },
      });
    });

    it('emits no storage column and no domain relation for the list side of a relation', () => {
      const ir = interpretOk(`
        model Author {
          id    String @id
          posts Post[]
        }

        model Post {
          id     String @id
          author Author
        }
      `);
      expect(tableOf(ir, 'author').fields).toEqual([]);
      expect(domainModel(ir, 'Author').relations).toEqual({});
    });

    it('accepts a relation name alongside onDelete', () => {
      const ir = interpretOk(`
        model Author {
          id String @id
        }

        model Post {
          id     String @id
          author Author @relation("PostAuthor", onDelete: Cascade)
        }
      `);
      expect(tableOf(ir, 'post').fields).toContainEqual({
        name: 'author',
        type: { kind: 'record', tables: ['author'] },
        codecId: 'surrealdb/record@1',
        reference: { kind: 'cascade' },
      });
    });

    it.each([
      ['Cascade', 'cascade'],
      ['Restrict', 'reject'],
      ['NoAction', 'ignore'],
    ] as const)('maps @relation(onDelete: %s) to REFERENCE ON DELETE %s', (pslAction, kind) => {
      const ir = interpretOk(`
        model Author {
          id String @id
        }

        model Post {
          id     String @id
          author Author @relation(onDelete: ${pslAction})
        }
      `);
      expect(tableOf(ir, 'post').fields).toContainEqual({
        name: 'author',
        type: { kind: 'record', tables: ['author'] },
        codecId: 'surrealdb/record@1',
        reference: { kind },
      });
    });

    it('maps @relation(onDelete: SetNull) on an optional relation to REFERENCE ON DELETE UNSET', () => {
      const ir = interpretOk(`
        model Author {
          id String @id
        }

        model Post {
          id     String @id
          author Author? @relation(onDelete: SetNull)
        }
      `);
      expect(tableOf(ir, 'post').fields).toContainEqual({
        name: 'author',
        type: { kind: 'option', of: { kind: 'record', tables: ['author'] } },
        codecId: 'surrealdb/record@1',
        reference: { kind: 'unset' },
      });
    });

    it('reports PSL_UNSET_REQUIRES_OPTIONAL_RELATION for onDelete: SetNull on a required relation', () => {
      const diagnostics = interpretDiagnostics(`
        model Author {
          id String @id
        }

        model Post {
          id     String @id
          author Author @relation(onDelete: SetNull)
        }
      `);
      expect(diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'PSL_UNSET_REQUIRES_OPTIONAL_RELATION' }),
        ]),
      );
    });

    it('reports PSL_UNSUPPORTED_ONDELETE_ACTION at the @relation attribute for an unrecognized action', () => {
      const diagnostics = interpretDiagnostics(`model Author {
  id String @id
}

model Post {
  id     String @id
  author Author @relation(onDelete: WeirdAction)
}
`);
      expect(diagnostics).toEqual([
        {
          code: 'PSL_UNSUPPORTED_ONDELETE_ACTION',
          message:
            'Field "Post.author" has @relation(onDelete: WeirdAction), which SurrealDB cannot represent; supported actions are Cascade, SetNull, Restrict, and NoAction',
          sourceId: 'test.prisma',
          span: {
            start: { offset: 83, line: 7, column: 17 },
            end: { offset: 115, line: 7, column: 49 },
          },
        },
      ]);
    });

    it('rejects foreign-key fields and references arguments, which a record link does not use', () => {
      const diagnostics = interpretDiagnostics(`
        model Author {
          id String @id
        }

        model Post {
          id       String @id
          authorId String
          author   Author @relation(fields: [authorId], references: [id])
        }
      `);
      expect(diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'PSL_INVALID_ATTRIBUTE_SYNTAX',
            message: 'Attribute "relation" received unknown argument "fields"',
          }),
          expect.objectContaining({
            code: 'PSL_INVALID_ATTRIBUTE_SYNTAX',
            message: 'Attribute "relation" received unknown argument "references"',
          }),
        ]),
      );
    });
  });

  describe('index authoring', () => {
    it('turns a field-level @unique into a single-field unique index', () => {
      const ir = interpretOk(`
        model Widget {
          id    String @id
          email String @unique
        }
      `);
      expect(tableOf(ir, 'widget').indexes).toEqual([
        { name: 'widget_email_unique', fields: ['email'], variant: { kind: 'unique' } },
      ]);
    });

    it('turns @@unique([...]) into a composite unique index', () => {
      const ir = interpretOk(`
        model Widget {
          id     String @id
          tenant String
          slug   String
          @@unique([tenant, slug])
        }
      `);
      expect(tableOf(ir, 'widget').indexes).toEqual([
        {
          name: 'widget_tenant_slug_unique',
          fields: ['tenant', 'slug'],
          variant: { kind: 'unique' },
        },
      ]);
    });

    it('turns @@index([...]) into a plain composite index', () => {
      const ir = interpretOk(`
        model Widget {
          id     String @id
          tenant String
          slug   String
          @@index([tenant, slug])
        }
      `);
      expect(tableOf(ir, 'widget').indexes).toEqual([
        { name: 'widget_tenant_slug_idx', fields: ['tenant', 'slug'], variant: { kind: 'plain' } },
      ]);
    });

    it('names model-level indexes from the name argument and maps their fields', () => {
      const ir = interpretOk(`
        model Widget {
          id     String @id
          tenant String @map("tenant_id")
          slug   String
          @@index([tenant, slug], name: "by_tenant")
          @@unique([slug], name: "one_slug")
        }
      `);
      expect(tableOf(ir, 'widget').indexes).toEqual([
        { name: 'by_tenant', fields: ['tenant_id', 'slug'], variant: { kind: 'plain' } },
        { name: 'one_slug', fields: ['slug'], variant: { kind: 'unique' } },
      ]);
    });

    it('reports PSL_UNRESOLVED_REFERENCE for an index field the model does not declare', () => {
      const diagnostics = interpretDiagnostics(`
        model Widget {
          id   String @id
          slug String
          @@index([slug, missing])
        }
      `);
      expect(diagnostics).toEqual([
        expect.objectContaining({
          code: 'PSL_UNRESOLVED_REFERENCE',
          message: 'Cannot find field "missing" on "Widget"',
        }),
      ]);
    });
  });

  describe('@default handling', () => {
    it('maps @default(now()) to time::now()', () => {
      const ir = interpretOk(`
        model Widget {
          id        String   @id
          createdAt DateTime @default(now())
        }
      `);
      const fields = tableOf(ir, 'widget').fields;
      expect(fields.find((f) => f.name === 'createdAt')?.defaultExpression).toBe('time::now()');
    });

    it('maps @default(uuid()) to rand::uuid() and @default(cuid()) to rand::ulid()', () => {
      const ir = interpretOk(`
        model Widget {
          id    String @id
          token String @default(uuid())
          code  String @default(cuid())
        }
      `);
      const fields = tableOf(ir, 'widget').fields;
      expect(fields.find((f) => f.name === 'token')?.defaultExpression).toBe('rand::uuid()');
      expect(fields.find((f) => f.name === 'code')?.defaultExpression).toBe('rand::ulid()');
    });

    it('stores literal number and boolean defaults as canonical values', () => {
      const ir = interpretOk(`
        model Widget {
          id     String  @id
          active Boolean @default(true)
          count  Int     @default(0)
          delta  Float   @default(-1.5)
        }
      `);
      const fields = tableOf(ir, 'widget').fields;
      expect(fields.find((f) => f.name === 'active')).toMatchObject({ defaultValue: true });
      expect(fields.find((f) => f.name === 'count')).toMatchObject({ defaultValue: 0 });
      expect(fields.find((f) => f.name === 'delta')).toMatchObject({ defaultValue: -1.5 });
      expect(fields.every((f) => f.defaultExpression === undefined)).toBe(true);
    });

    it('stores a quoted string literal default as its text', () => {
      const ir = interpretOk(`
        model Widget {
          id     String @id
          status String @default("it's fine")
        }
      `);
      const fields = tableOf(ir, 'widget').fields;
      expect(fields.find((f) => f.name === 'status')).toMatchObject({ defaultValue: "it's fine" });
    });

    it('reports PSL_UNSUPPORTED_DEFAULT for a function Surreal cannot represent', () => {
      const diagnostics = interpretDiagnostics(`
        model Widget {
          id    String @id
          count Int    @default(autoincrement())
        }
      `);
      expect(diagnostics).toEqual([
        expect.objectContaining({
          code: 'PSL_UNSUPPORTED_DEFAULT',
          message:
            'Field "Widget.count" has @default(autoincrement()), which SurrealQL cannot represent; supported default functions are now(), uuid(), and cuid()',
          sourceId: 'test.prisma',
        }),
      ]);
    });
  });

  describe('type resolution', () => {
    it('reports PSL_UNRESOLVED_REFERENCE for a field type nothing declares', () => {
      const diagnostics = interpretDiagnostics(`
        model Widget {
          id      String @id
          payload Json
        }
      `);
      expect(diagnostics).toEqual([
        expect.objectContaining({
          code: 'PSL_UNRESOLVED_REFERENCE',
          message: 'Cannot find type "Json"',
          sourceId: 'test.prisma',
        }),
      ]);
    });

    it('rejects a contributed type that is not a Surreal PSL scalar', () => {
      const diagnostics = interpretDiagnostics(
        `
        model Widget {
          id   String     @id
          link RecordLink
        }
      `,
        {
          type: {
            RecordLink: {
              kind: 'typeConstructor',
              output: { codecId: 'surrealdb/record@1', nativeType: 'record' },
            },
          },
        },
      );
      expect(diagnostics).toEqual([
        expect.objectContaining({
          code: 'PSL_UNSUPPORTED_FIELD_TYPE',
          message:
            'Field "Widget.link" type "RecordLink" is not supported in Surreal PSL interpreter',
        }),
      ]);
    });
  });

  describe('attribute specs', () => {
    it('reports PSL_UNSUPPORTED_FIELD_ATTRIBUTE for a field attribute Surreal does not interpret', () => {
      const diagnostics = interpretDiagnostics(`model Widget {
  id        String   @id
  updatedAt DateTime @updatedAt
}
`);
      expect(diagnostics).toEqual([
        {
          code: 'PSL_UNSUPPORTED_FIELD_ATTRIBUTE',
          message: 'Field "Widget.updatedAt" uses unsupported attribute "@updatedAt"',
          sourceId: 'test.prisma',
          span: {
            start: { offset: 61, line: 3, column: 22 },
            end: { offset: 71, line: 3, column: 32 },
          },
        },
      ]);
    });

    it('reports PSL_UNSUPPORTED_MODEL_ATTRIBUTE for a model attribute Surreal does not interpret', () => {
      const diagnostics = interpretDiagnostics(`
        model Widget {
          id String @id
          @@ignore
        }
      `);
      expect(diagnostics).toEqual([
        expect.objectContaining({
          code: 'PSL_UNSUPPORTED_MODEL_ATTRIBUTE',
          message: 'Model "Widget" uses unsupported attribute "@@ignore"',
        }),
      ]);
    });

    it('reports PSL_INVALID_ATTRIBUTE_SYNTAX for a @@map argument that is not a string', () => {
      const diagnostics = interpretDiagnostics(`
        model Widget {
          id String @id
          @@map(widgets)
        }
      `);
      expect(diagnostics).toEqual([
        expect.objectContaining({
          code: 'PSL_INVALID_ATTRIBUTE_SYNTAX',
          message: 'Expected a string literal',
        }),
      ]);
    });
  });

  describe('unsupported constructs', () => {
    it('rejects namespace blocks with a Surreal-flavoured diagnostic', () => {
      const diagnostics = interpretDiagnostics(
        `namespace auth {
  model User {
    id String @id
  }
}
`,
      );
      expect(diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'PSL_UNSUPPORTED_NAMESPACE_BLOCK',
            message: expect.stringMatching(/[Ss]urreal/),
            sourceId: 'test.prisma',
          }),
        ]),
      );
    });

    it('rejects enum blocks and fields typed with them', () => {
      const diagnostics = interpretDiagnostics(
        `enum Role {
  Admin
  Member
}

model User {
  id   String @id
  role Role
}
`,
      );
      expect(diagnostics).toEqual([
        expect.objectContaining({ code: 'PSL_UNSUPPORTED_ENUM_BLOCK', sourceId: 'test.prisma' }),
        expect.objectContaining({
          code: 'PSL_UNSUPPORTED_FIELD_TYPE',
          message: 'Field "User.role" type "Role" is not supported in Surreal PSL interpreter',
        }),
      ]);
    });

    it('rejects composite type declarations', () => {
      const diagnostics = interpretDiagnostics(`
        type Address {
          street String
          city   String
        }

        model User {
          id      String  @id
          address Address
        }
      `);
      expect(diagnostics).toEqual([
        expect.objectContaining({ code: 'PSL_UNSUPPORTED_COMPOSITE_TYPE' }),
        expect.objectContaining({
          code: 'PSL_UNSUPPORTED_FIELD_TYPE',
          message:
            'Field "User.address" type "Address" is a composite type, which is not supported in Surreal PSL interpreter',
        }),
      ]);
    });
  });

  describe('multi-file schemas', () => {
    it('interprets models declared across files into one contract', () => {
      const ir = interpretOk({
        'author.prisma': `model Author {
  id   String @id
  name String
}
`,
        'post.prisma': `model Post {
  id     String @id
  author Author
}
`,
      });
      expect(Object.keys(ir.roots).sort()).toEqual(['author', 'post']);
      expect(tableOf(ir, 'post').fields).toEqual([
        {
          name: 'author',
          type: { kind: 'record', tables: ['author'] },
          codecId: 'surrealdb/record@1',
        },
      ]);
    });

    it('attributes each diagnostic to the file that declares the offending node', () => {
      const diagnostics = interpretDiagnostics({
        'author.prisma': `model Author {
  id String @id
  payload Json
}
`,
        'post.prisma': `model Post {
  title String
}
`,
      });
      expect(diagnostics).toEqual([
        expect.objectContaining({ code: 'PSL_UNRESOLVED_REFERENCE', sourceId: 'author.prisma' }),
        expect.objectContaining({ code: 'PSL_MISSING_ID_FIELD', sourceId: 'post.prisma' }),
      ]);
    });
  });

  describe('contract structure', () => {
    it('sets targetFamily and target for SurrealDB', () => {
      const ir = interpretOk(`
        model Widget {
          id String @id
        }
      `);
      expect(ir.targetFamily).toBe('surreal');
      expect(ir.target).toBe('surrealdb');
    });

    it('includes empty extensions, capabilities, and meta, and a well-formed profileHash', () => {
      const ir = interpretOk(`
        model Widget {
          id String @id
        }
      `);
      expect(ir.extensions).toEqual({});
      expect(ir.capabilities).toEqual({});
      expect(ir.meta).toEqual({});
      expect(ir.profileHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('produces a storage hash', () => {
      const ir = interpretOk(`
        model Widget {
          id String @id
        }
      `);
      expect(ir.storage.storageHash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('storage-hash parity with defineContract', () => {
    it('produces the same storage hash as an equivalent hand-authored TS contract', () => {
      const psl = interpretOk(`
        model User {
          id    String @id
          name  String
        }

        model Post {
          id     String @id
          title  String
          author User
          @@unique([title])
        }
      `);

      const ts = defineContract({
        tables: {
          user: {
            fields: {
              name: { type: t.string() },
            },
          },
          post: {
            fields: {
              title: { type: t.string() },
              author: { type: t.record('user') },
            },
            indexes: {
              post_title_unique: { fields: ['title'], variant: indexOf.unique() },
            },
          },
        },
      });

      expect(psl.storage.storageHash).toBe(ts.storage.storageHash);
    });

    it('produces the same storage hash for @relation(onDelete: Cascade) as onDelete: "cascade" in TS', () => {
      const psl = interpretOk(`
        model User {
          id    String @id
          name  String
        }

        model Post {
          id     String @id
          title  String
          author User   @relation(onDelete: Cascade)
        }
      `);

      const ts = defineContract({
        tables: {
          user: { fields: { name: { type: t.string() } } },
          post: {
            fields: {
              title: { type: t.string() },
              author: { type: t.record('user'), onDelete: 'cascade' },
            },
          },
        },
      });

      expect(psl.storage.storageHash).toBe(ts.storage.storageHash);
    });

    it('produces the same storage hash for @default as defaultValue and default in TS', () => {
      const psl = interpretOk(`
        model Widget {
          id      String   @id
          count   Int      @default(42)
          price   Decimal  @default(1.50)
          tags    String[] @default(["a", "b"])
          created DateTime @default(now())
        }
      `);

      const ts = defineContract({
        tables: {
          widget: {
            fields: {
              count: { type: t.int(), defaultValue: 42 },
              price: { type: t.decimal(), defaultValue: '1.50' },
              tags: { type: t.array(t.string()), defaultValue: ['a', 'b'] },
              created: { type: t.datetime(), default: 'time::now()' },
            },
          },
        },
      });

      expect(psl.storage.storageHash).toBe(ts.storage.storageHash);
    });
  });

  describe('validateContract round-trip', () => {
    it('passes the interpreted contract through SurrealContractSchema unchanged', () => {
      const ir = interpretOk(`
        model Author {
          id    String @id
          name  String
        }

        model Post {
          id      String @id
          title   String
          author  Author
          @@unique([title])
        }
      `);

      const validated = SurrealContractSchema(ir);
      expect(validated).not.toBeInstanceOf(type.errors);
      expect(validated).toEqual(ir);
    });
  });
});
