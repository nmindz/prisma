import { UNBOUND_DOMAIN_NAMESPACE_ID } from '@internal/contract/default-namespace';
import { crossRef } from '@internal/contract/types';
import { UNBOUND_NAMESPACE_ID } from '@internal/framework-components/ir';
import { buildSymbolTable } from '@internal/psl-parser';
import { parse } from '@internal/psl-parser/syntax';
import { SurrealContractSchema } from '@internal/surreal-contract';
import { defineContract, index as indexOf, t } from '@internal/surreal-contract-ts';
import { describe, expect, it } from 'vitest';
import {
  type InterpretPslDocumentToSurrealContractInput,
  interpretPslDocumentToSurrealContract,
} from '../src/interpreter';

function buildSymbolTableInput(
  schema: string,
  sourceId = 'test.prisma',
): Omit<InterpretPslDocumentToSurrealContractInput, 'seedDiagnostics'> {
  const { document, sourceFile } = parse(schema);
  const { table } = buildSymbolTable({ document, sourceFile, pslBlockDescriptors: {} });
  return { symbolTable: table, sourceFile, sourceId };
}

function interpretOk(schema: string, sourceId?: string) {
  const result = interpretPslDocumentToSurrealContract(buildSymbolTableInput(schema, sourceId));
  if (!result.ok) {
    throw new Error(`expected ok, got diagnostics: ${JSON.stringify(result.failure.diagnostics)}`);
  }
  return result.value;
}

function interpretDiagnostics(schema: string, sourceId?: string) {
  const result = interpretPslDocumentToSurrealContract(buildSymbolTableInput(schema, sourceId));
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

      expect(ir.domain.namespaces[UNBOUND_DOMAIN_NAMESPACE_ID]?.models['Widget']?.fields).toEqual({
        nickname: { type: { kind: 'scalar', codecId: 'surrealdb/string@1' }, nullable: true },
      });
    });

    it('wraps list scalar fields in array<T> and reports many:true in the domain', () => {
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
      expect(ir.domain.namespaces[UNBOUND_DOMAIN_NAMESPACE_ID]?.models['Widget']?.fields).toEqual({
        tags: {
          type: { kind: 'scalar', codecId: 'surrealdb/string@1' },
          nullable: false,
          many: true,
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
      expect(diagnostics).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'PSL_MISSING_ID_FIELD' })]),
      );
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

      expect(ir.domain.namespaces[UNBOUND_DOMAIN_NAMESPACE_ID]?.models['Post']?.relations).toEqual({
        author: {
          to: crossRef('Author', UNBOUND_DOMAIN_NAMESPACE_ID),
          cardinality: 'N:1',
          on: { localFields: ['author'], targetFields: ['id'] },
        },
      });
    });

    it('wraps an optional relation field in option<record<table>>', () => {
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
      expect(
        ir.domain.namespaces[UNBOUND_DOMAIN_NAMESPACE_ID]?.models['Author']?.relations,
      ).toEqual({});
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

    it('reports PSL_UNSUPPORTED_ONDELETE_ACTION for an unrecognized action', () => {
      const diagnostics = interpretDiagnostics(`
        model Author {
          id String @id
        }

        model Post {
          id     String @id
          author Author @relation(onDelete: WeirdAction)
        }
      `);
      expect(diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'PSL_UNSUPPORTED_ONDELETE_ACTION' }),
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

    it('maps @default(uuid()) and @default(cuid()) to rand::uuid()', () => {
      const ir = interpretOk(`
        model Widget {
          id    String @id
          token String @default(uuid())
          code  String @default(cuid())
        }
      `);
      const fields = tableOf(ir, 'widget').fields;
      expect(fields.find((f) => f.name === 'token')?.defaultExpression).toBe('rand::uuid()');
      expect(fields.find((f) => f.name === 'code')?.defaultExpression).toBe('rand::uuid()');
    });

    it('passes literal number and boolean defaults through unescaped', () => {
      const ir = interpretOk(`
        model Widget {
          id     String  @id
          active Boolean @default(true)
          count  Int     @default(0)
        }
      `);
      const fields = tableOf(ir, 'widget').fields;
      expect(fields.find((f) => f.name === 'active')?.defaultExpression).toBe('true');
      expect(fields.find((f) => f.name === 'count')?.defaultExpression).toBe('0');
    });

    it('escapes a quoted string literal default via escapeStringLiteral', () => {
      const ir = interpretOk(`
        model Widget {
          id     String @id
          status String @default("it's fine")
        }
      `);
      const fields = tableOf(ir, 'widget').fields;
      expect(fields.find((f) => f.name === 'status')?.defaultExpression).toBe("'it\\'s fine'");
    });

    it('reports PSL_UNSUPPORTED_DEFAULT for an expression Surreal cannot represent', () => {
      const diagnostics = interpretDiagnostics(`
        model Widget {
          id    String @id
          count Int    @default(autoincrement())
        }
      `);
      expect(diagnostics).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'PSL_UNSUPPORTED_DEFAULT' })]),
      );
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
          }),
        ]),
      );
    });

    it('rejects enum blocks', () => {
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
      expect(diagnostics).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'PSL_UNSUPPORTED_ENUM_BLOCK' })]),
      );
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
      expect(diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'PSL_UNSUPPORTED_COMPOSITE_TYPE' }),
          expect.objectContaining({ code: 'PSL_UNSUPPORTED_FIELD_TYPE' }),
        ]),
      );
    });

    it('rejects a field typed with an unrecognized scalar', () => {
      const diagnostics = interpretDiagnostics(`
        model Widget {
          id      String @id
          payload Json
        }
      `);
      expect(diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'PSL_UNSUPPORTED_FIELD_TYPE',
            message: expect.stringContaining('Json'),
          }),
        ]),
      );
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
      expect((validated as { errors?: unknown }).errors).toBeUndefined();
      expect(validated).toEqual(ir);
    });
  });
});
