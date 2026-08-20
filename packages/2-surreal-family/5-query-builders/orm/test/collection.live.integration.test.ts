import { SurrealDriverImpl } from '@internal/driver-surrealdb/runtime';
import { SurrealField, SurrealIndex } from '@internal/surreal-contract';
import { SurrealQueryError } from '@internal/surreal-errors';
import { lowerQuery } from '@internal/surreal-lowering';
import type { SurrealQueryPlan } from '@internal/surreal-query-ast/plan';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SurrealCollection } from '../src/collection';

const binding = {
  url: process.env['SURREALDB_TEST_URL'] ?? 'ws://127.0.0.1:8112/rpc',
  namespace: 'prisma_next_test',
  database: 'orm_lane',
  username: process.env['SURREALDB_TEST_USER'] ?? 'root',
  password: process.env['SURREALDB_TEST_PASSWORD'] ?? 'root',
  connectTimeoutMs: 2_000,
} as const;

async function reachable(): Promise<boolean> {
  const probe = new SurrealDriverImpl();
  try {
    await probe.connect(binding);
    return true;
  } catch {
    return false;
  } finally {
    await probe.close().catch(() => undefined);
  }
}

const available = await reachable();

describe.skipIf(!available)('upsert and groupBy against a live SurrealDB', () => {
  const driver = new SurrealDriverImpl();

  async function run<Row>(plan: SurrealQueryPlan<Row>): Promise<Row[]> {
    const lowered = lowerQuery(plan.query);
    const vars = Object.fromEntries(lowered.params.map((p) => [p.name, p.value]));
    const rows: Row[] = [];
    for await (const row of driver.query<Row>({
      surql: lowered.surql,
      vars,
      ...(plan.resultIndex === undefined ? {} : { resultIndex: plan.resultIndex }),
    })) {
      rows.push(row);
    }
    return rows;
  }

  async function exec(surql: string): Promise<void> {
    for await (const _row of driver.query({ surql })) {
      // DDL — nothing to collect.
    }
  }

  beforeAll(async () => {
    await driver.connect(binding);
    await exec('REMOVE TABLE IF EXISTS `person`');
  });

  afterAll(async () => {
    await driver.close();
  });

  describe('upsert', () => {
    const person = new SurrealCollection<{ id: unknown; name: string; age: number }>(
      'person',
      'sh',
    );

    it('creates the record on the first call and updates it in place on the second', async () => {
      const created = await run(person.upsert({ id: 'ada', data: { name: 'ada', age: 36 } }));
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({ name: 'ada', age: 36 });

      const updated = await run(person.upsert({ id: 'ada', data: { name: 'ada', age: 37 } }));
      expect(updated).toHaveLength(1);
      expect(updated[0]).toMatchObject({ name: 'ada', age: 37 });

      const all = await run(person.findMany({ where: { name: 'ada' } }));
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ age: 37 });
    });

    it('keeps unlisted fields when merge is set', async () => {
      await run(person.upsert({ id: 'merge-me', data: { name: 'grace', age: 40 } }));
      const merged = await run(person.upsert({ id: 'merge-me', data: { age: 41 }, merge: true }));
      expect(merged[0]).toMatchObject({ name: 'grace', age: 41 });
    });
  });

  describe('upsert by unique index', () => {
    const emailIndex = new SurrealIndex({
      name: 'contact_email_unique',
      fields: ['email'],
      variant: { kind: 'unique' },
    });
    const orgSlugIndex = new SurrealIndex({
      name: 'listing_org_slug_unique',
      fields: ['orgId', 'slug'],
      variant: { kind: 'unique' },
    });
    const contact = new SurrealCollection<{ id: unknown; email: string; name: string }>(
      'contact',
      'sh',
      undefined,
      [emailIndex],
    );
    const listing = new SurrealCollection<{
      id: unknown;
      orgId: string;
      slug: string;
      title: string;
    }>('listing', 'sh', undefined, [orgSlugIndex]);

    beforeAll(async () => {
      await exec('REMOVE TABLE IF EXISTS `contact`');
      await exec('REMOVE TABLE IF EXISTS `listing`');
      await exec('DEFINE INDEX contact_email_unique ON TABLE contact FIELDS email UNIQUE');
      await exec('DEFINE INDEX listing_org_slug_unique ON TABLE listing FIELDS orgId, slug UNIQUE');
    });

    it('creates the record when no row matches the unique key', async () => {
      const created = await run(
        contact.upsert({ where: { email: 'ada@example.com' }, data: { name: 'ada' } }),
      );
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({ email: 'ada@example.com', name: 'ada' });
    });

    it('updates the existing record in place when the unique key already exists', async () => {
      await run(contact.upsert({ where: { email: 'grace@example.com' }, data: { name: 'grace' } }));
      const updated = await run(
        contact.upsert({
          where: { email: 'grace@example.com' },
          data: { name: 'grace hopper' },
        }),
      );
      expect(updated).toHaveLength(1);
      expect(updated[0]).toMatchObject({ email: 'grace@example.com', name: 'grace hopper' });

      const all = await run(contact.findMany({ where: { email: 'grace@example.com' } }));
      expect(all).toHaveLength(1);
    });

    it('keys a composite unique index across two fields', async () => {
      const created = await run(
        listing.upsert({ where: { orgId: 'org1', slug: 'launch' }, data: { title: 'Launch' } }),
      );
      expect(created).toHaveLength(1);

      const updated = await run(
        listing.upsert({
          where: { orgId: 'org1', slug: 'launch' },
          data: { title: 'Launch Day' },
        }),
      );
      expect(updated[0]).toMatchObject({ title: 'Launch Day' });

      const rows = await run(listing.findMany({ where: { orgId: 'org1' } }));
      expect(rows).toHaveLength(1);
    });

    it('lets exactly one of five concurrent upserts on an absent key win', async () => {
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          run(contact.upsert({ where: { email: 'race@example.com' }, data: { name: 'racer' } })),
        ),
      );

      const rows = await run(contact.findMany({ where: { email: 'race@example.com' } }));
      expect(rows).toHaveLength(1);

      // A losing racer's failure is reported against the whole BEGIN/COMMIT
      // script, not the specific statement that lost, so SurrealDB surfaces
      // a generic transaction-failure message rather than the `Database
      // index ... already contains` wording `isUniqueConstraintViolation`
      // matches on. What every rejection reliably carries is a classified
      // `SurrealQueryError` rather than a raw network/protocol error, so
      // that is what this asserts; the one-row invariant above is the
      // durable guarantee this lowering makes.
      for (const result of results) {
        if (result.status === 'rejected') {
          expect(SurrealQueryError.is(result.reason)).toBe(true);
        }
      }
    });
  });

  describe('groupBy', () => {
    const team = new SurrealCollection('team_member', 'sh');

    beforeAll(async () => {
      await exec('REMOVE TABLE IF EXISTS `team_member`');
      await run(team.create({ data: { unit: 'x', score: 10 } }));
      await run(team.create({ data: { unit: 'x', score: 20 } }));
      await run(team.create({ data: { unit: 'y', score: 5 } }));
    });

    it('aggregates every verified function per group', async () => {
      const rows = await run(
        team.groupBy({
          by: ['unit'],
          aggregate: {
            n: { fn: 'count' },
            total: { fn: 'sum', field: 'score' },
            avg: { fn: 'avg', field: 'score' },
            hi: { fn: 'max', field: 'score' },
            lo: { fn: 'min', field: 'score' },
          },
        }),
      );
      const byUnit = new Map(rows.map((row) => [row['unit'] as string, row]));
      expect(byUnit.get('x')).toMatchObject({ n: 2, total: 30, avg: 15, hi: 20, lo: 10 });
      expect(byUnit.get('y')).toMatchObject({ n: 1, total: 5, avg: 5, hi: 5, lo: 5 });
    });

    it('aggregates the whole table with GROUP ALL', async () => {
      const rows = await run(team.groupBy({ aggregate: { n: { fn: 'count' } } }));
      expect(rows).toEqual([{ n: 3 }]);
    });
  });

  describe('type-aware max/min lowering', () => {
    const metricFields: ReadonlyArray<SurrealField> = [
      new SurrealField({
        name: 'unit',
        type: { kind: 'scalar', name: 'string' },
        codecId: 'string',
      }),
      new SurrealField({ name: 'score', type: { kind: 'scalar', name: 'int' }, codecId: 'int' }),
      new SurrealField({
        name: 'startedAt',
        type: { kind: 'scalar', name: 'datetime' },
        codecId: 'datetime',
      }),
      new SurrealField({
        name: 'label',
        type: { kind: 'scalar', name: 'string' },
        codecId: 'string',
      }),
    ];
    const metric = new SurrealCollection('metric_typed', 'sh', undefined, undefined, metricFields);

    beforeAll(async () => {
      await exec('REMOVE TABLE IF EXISTS `metric_typed`');
      await run(
        metric.create({
          data: {
            unit: 'x',
            score: 10,
            startedAt: new Date('2026-01-01T00:00:00Z'),
            label: 'apple',
          },
        }),
      );
      await run(
        metric.create({
          data: {
            unit: 'x',
            score: 20,
            startedAt: new Date('2026-02-01T00:00:00Z'),
            label: 'banana',
          },
        }),
      );
      await run(
        metric.create({
          data: {
            unit: 'y',
            score: 5,
            startedAt: new Date('2025-06-01T00:00:00Z'),
            label: 'cherry',
          },
        }),
      );
    });

    it('lowers max/min by declared field type and returns correct values per group', async () => {
      const rows = await run(
        metric.groupBy({
          by: ['unit'],
          aggregate: {
            hi: { fn: 'max', field: 'score' },
            lo: { fn: 'min', field: 'score' },
            latest: { fn: 'max', field: 'startedAt' },
            earliest: { fn: 'min', field: 'startedAt' },
            top: { fn: 'max', field: 'label' },
            bottom: { fn: 'min', field: 'label' },
          },
        }),
      );
      const byUnit = new Map(rows.map((row) => [row['unit'] as string, row]));

      const x = byUnit.get('x');
      expect(x).toMatchObject({ hi: 20, lo: 10, top: 'banana', bottom: 'apple' });
      expect(String(x?.['latest'])).toBe('2026-02-01T00:00:00Z');
      expect(String(x?.['earliest'])).toBe('2026-01-01T00:00:00Z');

      const y = byUnit.get('y');
      expect(y).toMatchObject({ hi: 5, lo: 5, top: 'cherry', bottom: 'cherry' });
      expect(String(y?.['latest'])).toBe('2025-06-01T00:00:00Z');
      expect(String(y?.['earliest'])).toBe('2025-06-01T00:00:00Z');
    });

    it('dispatches the same way under GROUP ALL', async () => {
      const rows = await run(
        metric.groupBy({
          aggregate: {
            latest: { fn: 'max', field: 'startedAt' },
            top: { fn: 'max', field: 'label' },
          },
        }),
      );
      expect(rows).toHaveLength(1);
      expect(String(rows[0]?.['latest'])).toBe('2026-02-01T00:00:00Z');
      expect(rows[0]?.['top']).toBe('cherry');
    });
  });
});

describe.skipIf(!available)('relation filters against a live SurrealDB', () => {
  const driver = new SurrealDriverImpl();

  async function run<Row>(plan: SurrealQueryPlan<Row>): Promise<Row[]> {
    const lowered = lowerQuery(plan.query);
    const vars = Object.fromEntries(lowered.params.map((p) => [p.name, p.value]));
    const rows: Row[] = [];
    for await (const row of driver.query<Row>({
      surql: lowered.surql,
      vars,
      ...(plan.resultIndex === undefined ? {} : { resultIndex: plan.resultIndex }),
    })) {
      rows.push(row);
    }
    return rows;
  }

  async function exec(surql: string): Promise<void> {
    for await (const _row of driver.query({ surql })) {
      // DDL — nothing to collect.
    }
  }

  const postFields: ReadonlyArray<SurrealField> = [
    new SurrealField({
      name: 'title',
      type: { kind: 'scalar', name: 'string' },
      codecId: 'string',
    }),
    new SurrealField({
      name: 'author',
      type: { kind: 'option', of: { kind: 'record', tables: ['person'] } },
      codecId: 'record',
    }),
  ];
  const personFields: ReadonlyArray<SurrealField> = [
    new SurrealField({ name: 'name', type: { kind: 'scalar', name: 'string' }, codecId: 'string' }),
    new SurrealField({
      name: 'org',
      type: { kind: 'option', of: { kind: 'record', tables: ['org'] } },
      codecId: 'record',
    }),
    new SurrealField({
      name: 'posts',
      type: { kind: 'option', of: { kind: 'array', of: { kind: 'record', tables: ['post'] } } },
      codecId: 'array',
    }),
  ];
  const post = new SurrealCollection<{ id: unknown; title: string }>(
    'post',
    'sh',
    undefined,
    undefined,
    postFields,
  );
  const person = new SurrealCollection<{ id: unknown; name: string }>(
    'person',
    'sh',
    undefined,
    undefined,
    personFields,
  );

  beforeAll(async () => {
    await driver.connect(binding);
    await exec('REMOVE TABLE IF EXISTS `org`');
    await exec('REMOVE TABLE IF EXISTS `person`');
    await exec('REMOVE TABLE IF EXISTS `post`');
    await exec("CREATE org:acme SET tier = 'gold'");
    await exec("CREATE org:beta SET tier = 'silver'");
    await exec("CREATE post:p1 SET title = 'alpha'");
    await exec("CREATE post:p2 SET title = 'beta'");
    await exec("CREATE post:p3 SET title = 'gamma'");
    await exec("CREATE person:ada SET name = 'ada', org = org:acme, posts = [post:p1, post:p2]");
    await exec("CREATE person:grace SET name = 'grace', org = org:beta, posts = []");
    await exec("CREATE person:linus SET name = 'linus', posts = [post:p3]");
    await exec("CREATE person:zoe SET name = 'zoe'");
    await exec('UPDATE post:p1 SET author = person:ada');
    await exec('UPDATE post:p2 SET author = person:ada');
  });

  afterAll(async () => {
    await driver.close();
  });

  describe('to-one', () => {
    it('matches through a direct link field', async () => {
      const rows = await run(post.findMany({ where: { author: { name: 'ada' } } }));
      expect(rows.map((row) => row.title).sort()).toEqual(['alpha', 'beta']);
    });

    it('excludes a record whose link is absent, even though the predicate is unmet elsewhere too', async () => {
      const rows = await run(post.findMany({ where: { author: { name: 'nobody' } } }));
      expect(rows).toEqual([]);
    });

    it('recurses two hops deep', async () => {
      const rows = await run(post.findMany({ where: { author: { org: { tier: 'gold' } } } }));
      expect(rows.map((row) => row.title).sort()).toEqual(['alpha', 'beta']);
    });

    it('finds nothing through a chain no record satisfies', async () => {
      const rows = await run(post.findMany({ where: { author: { org: { tier: 'platinum' } } } }));
      expect(rows).toEqual([]);
    });
  });

  describe('to-many quantifiers — the optional-link truth table', () => {
    it('some matches only the record whose array has a satisfying element', async () => {
      const rows = await run(person.findMany({ where: { posts: { some: { title: 'alpha' } } } }));
      expect(rows.map((row) => row.name)).toEqual(['ada']);
    });

    it('none passes vacuously for an empty array and for an absent link, and fails when an element matches', async () => {
      const rows = await run(person.findMany({ where: { posts: { none: { title: 'alpha' } } } }));
      expect(rows.map((row) => row.name).sort()).toEqual(['grace', 'linus', 'zoe']);
    });

    it('every passes vacuously for an empty array and for an absent link, and fails when any element misses', async () => {
      const rows = await run(person.findMany({ where: { posts: { every: { title: 'alpha' } } } }));
      expect(rows.map((row) => row.name).sort()).toEqual(['grace', 'zoe']);
    });

    it('every passes for an array whose sole element matches, alongside the same vacuous cases', async () => {
      const rows = await run(person.findMany({ where: { posts: { every: { title: 'gamma' } } } }));
      expect(rows.map((row) => row.name).sort()).toEqual(['grace', 'linus', 'zoe']);
    });
  });
});

describe.skipIf(available)('SurrealDB orm collection-lane suite', () => {
  it('is skipped because SurrealDB is not reachable', () => {
    expect(available).toBe(false);
  });
});
