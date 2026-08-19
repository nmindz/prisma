import { SurrealContractSerializer } from '@internal/target-surrealdb/contract';
import { describe, expect, it } from 'vitest';
import { defineContract, t } from '../src/exports/contract-builder';
import surrealdb from '../src/runtime/surrealdb';
import surrealdbStatic from '../src/static/surreal-static';

const contract = defineContract({
  tables: {
    person: { fields: { name: { type: t.string() }, age: { type: t.int() } } },
  },
});

const contractJson = new SurrealContractSerializer().serializeContract(contract);

describe('plan parity between the static surface and the connected facade', () => {
  it('builds an identical findMany plan through the collection lane', () => {
    const staticDb = surrealdbStatic({ contractJson });
    const facadeDb = surrealdb({ contract });

    const staticPerson = staticDb.orm['person'] as NonNullable<(typeof staticDb.orm)['person']>;
    const facadePerson = facadeDb.orm['person'] as NonNullable<(typeof facadeDb.orm)['person']>;

    const args = {
      where: { age: { gte: 18 } },
      select: { name: true, age: true },
      orderBy: { age: 'desc' as const },
      limit: 5,
    };

    expect(staticPerson.findMany(args)).toEqual(facadePerson.findMany(args));
  });

  it('builds an identical raw plan through the template lane', () => {
    const staticDb = surrealdbStatic({ contractJson });
    const facadeDb = surrealdb({ contract });

    expect(staticDb.surql`SELECT * FROM person WHERE age > ${18}`).toEqual(
      facadeDb.surql`SELECT * FROM person WHERE age > ${18}`,
    );
  });
});
