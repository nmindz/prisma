import { SurrealField, SurrealIndex } from '@internal/surreal-contract';
import { lowerQuery } from '@internal/surreal-lowering';
import { RecordId } from '@internal/surreal-value';
import { describe, expect, it } from 'vitest';
import { SurrealCollection } from '../src/collection';

const person = new SurrealCollection('person', 'sh');
const surql = (plan: { query: Parameters<typeof lowerQuery>[0] }) => lowerQuery(plan.query);

const metricFields: ReadonlyArray<SurrealField> = [
  new SurrealField({ name: 'unit', type: { kind: 'scalar', name: 'string' }, codecId: 'string' }),
  new SurrealField({ name: 'score', type: { kind: 'scalar', name: 'int' }, codecId: 'int' }),
  new SurrealField({ name: 'ratio', type: { kind: 'scalar', name: 'float' }, codecId: 'float' }),
  new SurrealField({
    name: 'startedAt',
    type: { kind: 'scalar', name: 'datetime' },
    codecId: 'datetime',
  }),
  new SurrealField({ name: 'label', type: { kind: 'scalar', name: 'string' }, codecId: 'string' }),
  new SurrealField({ name: 'active', type: { kind: 'scalar', name: 'bool' }, codecId: 'bool' }),
  new SurrealField({ name: 'payload', type: { kind: 'scalar', name: 'bytes' }, codecId: 'bytes' }),
  new SurrealField({
    name: 'ttl',
    type: { kind: 'scalar', name: 'duration' },
    codecId: 'duration',
  }),
  new SurrealField({ name: 'externalId', type: { kind: 'scalar', name: 'uuid' }, codecId: 'uuid' }),
  new SurrealField({
    name: 'owner',
    type: { kind: 'record', tables: ['person'] },
    codecId: 'record',
  }),
  new SurrealField({
    name: 'location',
    type: { kind: 'geometry', shapes: ['point'] },
    codecId: 'geometry',
  }),
];

describe('findMany', () => {
  it('selects everything by default', () => {
    expect(surql(person.findMany()).surql).toBe('SELECT * FROM `person`');
  });

  it('projects only the selected fields', () => {
    expect(surql(person.findMany({ select: { name: true, age: false } })).surql).toBe(
      'SELECT `name` FROM `person`',
    );
  });

  it('binds a bare where value as equality', () => {
    const lowered = surql(person.findMany({ where: { name: 'ada' } }));
    expect(lowered.surql).toBe('SELECT * FROM `person` WHERE `name` = $p0');
    expect(lowered.params).toEqual([{ name: 'p0', value: 'ada' }]);
  });

  it('compiles comparison operators', () => {
    expect(surql(person.findMany({ where: { age: { gte: 18 } } })).surql).toBe(
      'SELECT * FROM `person` WHERE `age` >= $p0',
    );
  });

  it('combines sibling keys with AND', () => {
    expect(surql(person.findMany({ where: { name: 'ada', age: { gt: 1 } } })).surql).toBe(
      'SELECT * FROM `person` WHERE (`name` = $p0 AND `age` > $p1)',
    );
  });

  it('compiles OR and NOT', () => {
    expect(
      surql(person.findMany({ where: { OR: [{ name: 'ada' }, { name: 'bob' }] } })).surql,
    ).toBe('SELECT * FROM `person` WHERE (`name` = $p0 OR `name` = $p1)');
    expect(surql(person.findMany({ where: { NOT: { name: 'ada' } } })).surql).toBe(
      'SELECT * FROM `person` WHERE !(`name` = $p0)',
    );
  });

  it('maps in to INSIDE, which is how SurrealQL tests membership', () => {
    expect(surql(person.findMany({ where: { name: { in: ['a', 'b'] } } })).surql).toBe(
      'SELECT * FROM `person` WHERE `name` INSIDE $p0',
    );
  });

  it('maps contains to CONTAINS, an array holding the value', () => {
    expect(surql(person.findMany({ where: { tags: { contains: 'x' } } })).surql).toBe(
      'SELECT * FROM `person` WHERE `tags` CONTAINS $p0',
    );
  });

  it('compiles an absence check without binding anything', () => {
    const lowered = surql(person.findMany({ where: { nickname: { isNone: true } } }));
    expect(lowered.surql).toBe('SELECT * FROM `person` WHERE `nickname` IS NONE');
    expect(lowered.params).toEqual([]);
  });

  it('renders START for the offset, SurrealQL having no OFFSET', () => {
    expect(surql(person.findMany({ limit: 10, start: 20 })).surql).toBe(
      'SELECT * FROM `person` LIMIT 10 START 20',
    );
  });

  it('orders by the given fields', () => {
    expect(surql(person.findMany({ orderBy: { age: 'desc' } })).surql).toBe(
      'SELECT * FROM `person` ORDER BY `age` DESC',
    );
  });

  it('projects an ordered field even when select omits it, which SurrealQL requires', () => {
    expect(surql(person.findMany({ select: { name: true }, orderBy: { age: 'asc' } })).surql).toBe(
      'SELECT `name`, `age` FROM `person` ORDER BY `age` ASC',
    );
  });

  it('renders FETCH for a record link', () => {
    expect(surql(person.findMany({ fetch: ['author'] })).surql).toBe(
      'SELECT * FROM `person` FETCH `author`',
    );
  });

  it('caps findFirst at one row', () => {
    expect(surql(person.findFirst()).surql).toBe('SELECT * FROM `person` LIMIT 1');
  });

  it('reads one record with FROM ONLY', () => {
    expect(surql(person.findUnique('ada')).surql).toBe('SELECT * FROM ONLY `person`:`ada`');
  });
});

describe('count', () => {
  it('aggregates with GROUP ALL', () => {
    expect(surql(person.count()).surql).toBe('SELECT count() AS `count` FROM `person` GROUP ALL');
  });

  it('counts a filtered subset', () => {
    expect(surql(person.count({ where: { age: { gt: 18 } } })).surql).toBe(
      'SELECT count() AS `count` FROM `person` WHERE `age` > $p0 GROUP ALL',
    );
  });
});

describe('groupBy', () => {
  it('groups by a field, projecting the grouped field alongside the aggregate', () => {
    expect(
      surql(person.groupBy({ by: ['team'], aggregate: { total: { fn: 'sum', field: 'age' } } }))
        .surql,
    ).toBe('SELECT `team`, math::sum(`age`) AS `total` FROM `person` GROUP BY `team`');
  });

  it('aggregates the whole table with GROUP ALL when by is omitted', () => {
    expect(surql(person.groupBy({ aggregate: { n: { fn: 'count' } } })).surql).toBe(
      'SELECT count() AS `n` FROM `person` GROUP ALL',
    );
  });

  it('renders every verified aggregate function', () => {
    expect(
      surql(
        person.groupBy({
          by: ['team'],
          aggregate: {
            n: { fn: 'count' },
            total: { fn: 'sum', field: 'age' },
            avg: { fn: 'avg', field: 'age' },
            hi: { fn: 'max', field: 'age' },
            lo: { fn: 'min', field: 'age' },
          },
        }),
      ).surql,
    ).toBe(
      'SELECT `team`, count() AS `n`, math::sum(`age`) AS `total`, math::mean(`age`) AS `avg`, math::max(`age`) AS `hi`, math::min(`age`) AS `lo` FROM `person` GROUP BY `team`',
    );
  });

  it('groups by more than one field, projecting all of them', () => {
    expect(
      surql(
        person.groupBy({
          by: ['team', 'region'],
          aggregate: { n: { fn: 'count' } },
        }),
      ).surql,
    ).toBe('SELECT `team`, `region`, count() AS `n` FROM `person` GROUP BY `team`, `region`');
  });

  it('filters before grouping', () => {
    expect(
      surql(
        person.groupBy({
          by: ['team'],
          aggregate: { total: { fn: 'sum', field: 'age' } },
          where: { active: true },
        }),
      ).surql,
    ).toBe(
      'SELECT `team`, math::sum(`age`) AS `total` FROM `person` WHERE `active` = $p0 GROUP BY `team`',
    );
  });

  it('rejects an aggregate spec with no selectors', () => {
    expect(() => person.groupBy({ aggregate: {} })).toThrow(/at least one/);
  });

  it('rejects a non-count aggregate missing its field', () => {
    expect(() => person.groupBy({ aggregate: { total: { fn: 'sum' } } })).toThrow(/field/);
  });
});

describe('groupBy aggregate type dispatch', () => {
  const metric = new SurrealCollection('metric', 'sh', undefined, undefined, metricFields);

  it('keeps math:: functions for numeric fields', () => {
    expect(
      surql(
        metric.groupBy({
          by: ['unit'],
          aggregate: {
            total: { fn: 'sum', field: 'score' },
            avg: { fn: 'avg', field: 'ratio' },
            hi: { fn: 'max', field: 'score' },
            lo: { fn: 'min', field: 'score' },
          },
        }),
      ).surql,
    ).toBe(
      'SELECT `unit`, math::sum(`score`) AS `total`, math::mean(`ratio`) AS `avg`, math::max(`score`) AS `hi`, math::min(`score`) AS `lo` FROM `metric` GROUP BY `unit`',
    );
  });

  it('lowers max/min on a datetime field to time::max/time::min', () => {
    expect(
      surql(
        metric.groupBy({
          by: ['unit'],
          aggregate: {
            latest: { fn: 'max', field: 'startedAt' },
            earliest: { fn: 'min', field: 'startedAt' },
          },
        }),
      ).surql,
    ).toBe(
      'SELECT `unit`, time::max(`startedAt`) AS `latest`, time::min(`startedAt`) AS `earliest` FROM `metric` GROUP BY `unit`',
    );
  });

  it('lowers max/min on a string field to the grouped array form', () => {
    expect(
      surql(
        metric.groupBy({
          by: ['unit'],
          aggregate: {
            top: { fn: 'max', field: 'label' },
            bottom: { fn: 'min', field: 'label' },
          },
        }),
      ).surql,
    ).toBe(
      'SELECT `unit`, array::max(array::group(`label`)) AS `top`, array::min(array::group(`label`)) AS `bottom` FROM `metric` GROUP BY `unit`',
    );
  });

  it('dispatches the same way under GROUP ALL', () => {
    expect(
      surql(
        metric.groupBy({
          aggregate: {
            latest: { fn: 'max', field: 'startedAt' },
            top: { fn: 'max', field: 'label' },
          },
        }),
      ).surql,
    ).toBe(
      'SELECT time::max(`startedAt`) AS `latest`, array::max(array::group(`label`)) AS `top` FROM `metric` GROUP ALL',
    );
  });

  it('keeps math:: functions when the field is not declared on the table', () => {
    expect(
      surql(metric.groupBy({ aggregate: { hi: { fn: 'max', field: 'unknownField' } } })).surql,
    ).toBe('SELECT math::max(`unknownField`) AS `hi` FROM `metric` GROUP ALL');
  });

  it('keeps math:: functions when the collection carries no field types at all', () => {
    expect(surql(person.groupBy({ aggregate: { hi: { fn: 'max', field: 'age' } } })).surql).toBe(
      'SELECT math::max(`age`) AS `hi` FROM `person` GROUP ALL',
    );
  });

  it('rejects max on a bool field rather than returning a silent null', () => {
    expect(() => metric.groupBy({ aggregate: { hi: { fn: 'max', field: 'active' } } })).toThrow(
      'groupBy aggregate "hi" cannot use "max" on field "active" (type bool): no verified SurrealQL max lowering for this type',
    );
  });

  it('rejects min on a bool field the same way', () => {
    expect(() => metric.groupBy({ aggregate: { lo: { fn: 'min', field: 'active' } } })).toThrow(
      'groupBy aggregate "lo" cannot use "min" on field "active" (type bool): no verified SurrealQL min lowering for this type',
    );
  });

  it('rejects max on a bytes field', () => {
    expect(() => metric.groupBy({ aggregate: { hi: { fn: 'max', field: 'payload' } } })).toThrow(
      'groupBy aggregate "hi" cannot use "max" on field "payload" (type bytes): no verified SurrealQL max lowering for this type',
    );
  });

  it('rejects max on a duration field', () => {
    expect(() => metric.groupBy({ aggregate: { hi: { fn: 'max', field: 'ttl' } } })).toThrow(
      'groupBy aggregate "hi" cannot use "max" on field "ttl" (type duration): no verified SurrealQL max lowering for this type',
    );
  });

  it('rejects max on a uuid field', () => {
    expect(() => metric.groupBy({ aggregate: { hi: { fn: 'max', field: 'externalId' } } })).toThrow(
      'groupBy aggregate "hi" cannot use "max" on field "externalId" (type uuid): no verified SurrealQL max lowering for this type',
    );
  });

  it('rejects max on a record field', () => {
    expect(() => metric.groupBy({ aggregate: { hi: { fn: 'max', field: 'owner' } } })).toThrow(
      'groupBy aggregate "hi" cannot use "max" on field "owner" (type record<`person`>): no verified SurrealQL max lowering for this type',
    );
  });

  it('rejects max on a geometry field', () => {
    expect(() => metric.groupBy({ aggregate: { hi: { fn: 'max', field: 'location' } } })).toThrow(
      'groupBy aggregate "hi" cannot use "max" on field "location" (type geometry<point>): no verified SurrealQL max lowering for this type',
    );
  });

  it('rejects sum on a datetime field', () => {
    expect(() =>
      metric.groupBy({ aggregate: { total: { fn: 'sum', field: 'startedAt' } } }),
    ).toThrow(
      'groupBy aggregate "total" cannot use "sum" on field "startedAt" (type datetime): sum requires a numeric field',
    );
  });

  it('rejects avg on a string field', () => {
    expect(() => metric.groupBy({ aggregate: { avg: { fn: 'avg', field: 'label' } } })).toThrow(
      'groupBy aggregate "avg" cannot use "avg" on field "label" (type string): avg requires a numeric field',
    );
  });
});

describe('mutations', () => {
  it('creates with CONTENT and returns the written record', () => {
    const lowered = surql(person.create({ data: { name: 'ada', age: 36 } }));
    expect(lowered.surql).toBe('CREATE `person` CONTENT { `name`: $p0, `age`: $p1 } RETURN AFTER');
    expect(lowered.params.map((p) => p.value)).toEqual(['ada', 36]);
  });

  it('creates at a chosen id', () => {
    expect(surql(person.create({ id: 'ada', data: { name: 'ada' } })).surql).toBe(
      'CREATE `person`:`ada` CONTENT { `name`: $p0 } RETURN AFTER',
    );
  });

  it('skips an undefined field rather than writing NONE over it', () => {
    const lowered = surql(person.create({ data: { name: 'ada', age: undefined } }));
    expect(lowered.surql).toBe('CREATE `person` CONTENT { `name`: $p0 } RETURN AFTER');
  });

  it('replaces with CONTENT and merges with MERGE', () => {
    expect(surql(person.update({ id: 'ada', data: { age: 37 } })).surql).toBe(
      'UPDATE `person`:`ada` CONTENT { `age`: $p0 } RETURN AFTER',
    );
    expect(surql(person.update({ id: 'ada', data: { age: 37 }, merge: true })).surql).toBe(
      'UPDATE `person`:`ada` MERGE { `age`: $p0 } RETURN AFTER',
    );
  });

  it('deletes a filtered set and returns what it removed', () => {
    expect(surql(person.delete({ where: { age: { lt: 1 } } })).surql).toBe(
      'DELETE `person` WHERE `age` < $p0 RETURN BEFORE',
    );
  });
});

describe('upsert', () => {
  it('creates-or-updates a record by id with CONTENT', () => {
    const lowered = surql(person.upsert({ id: 'ada', data: { name: 'ada', age: 36 } }));
    expect(lowered.surql).toBe(
      'UPSERT `person`:`ada` CONTENT { `name`: $p0, `age`: $p1 } RETURN AFTER',
    );
    expect(lowered.params.map((p) => p.value)).toEqual(['ada', 36]);
  });

  it('merges into an existing record with MERGE', () => {
    expect(surql(person.upsert({ id: 'ada', data: { age: 37 }, merge: true })).surql).toBe(
      'UPSERT `person`:`ada` MERGE { `age`: $p0 } RETURN AFTER',
    );
  });

  it('accepts a RecordId a read produced', () => {
    expect(
      surql(person.upsert({ id: new RecordId('person', 'ada'), data: { age: 40 } })).surql,
    ).toBe('UPSERT `person`:`ada` CONTENT { `age`: $p0 } RETURN AFTER');
  });
});

describe('upsert by unique index', () => {
  const emailIndex = new SurrealIndex({
    name: 'person_email_unique',
    fields: ['email'],
    variant: { kind: 'unique' },
  });
  const orgSlugIndex = new SurrealIndex({
    name: 'event_org_slug_unique',
    fields: ['orgId', 'slug'],
    variant: { kind: 'unique' },
  });
  const personWithEmail = new SurrealCollection('person', 'sh', undefined, [emailIndex]);
  const eventWithSlug = new SurrealCollection('event', 'sh', undefined, [orgSlugIndex]);

  it('keys a single-field unique index, standalone in its own transaction', () => {
    const lowered = surql(
      personWithEmail.upsert({ where: { email: 'grace@example.com' }, data: { name: 'grace' } }),
    );
    expect(lowered.surql).toBe(
      [
        'BEGIN TRANSACTION',
        'LET $hit = (SELECT `id` FROM `person` WHERE (`email` = $p0) LIMIT 1)',
        'IF $hit != [] THEN (UPDATE $hit[0].id CONTENT { `email`: $p1, `name`: $p2 } RETURN AFTER) ELSE (CREATE `person` CONTENT { `email`: $p3, `name`: $p4 } RETURN AFTER) END',
        'COMMIT TRANSACTION',
      ].join(';\n'),
    );
    expect(lowered.params.map((p) => p.value)).toEqual([
      'grace@example.com',
      'grace@example.com',
      'grace',
      'grace@example.com',
      'grace',
    ]);
  });

  it('merges into the matched record with MERGE instead of CONTENT', () => {
    const lowered = surql(
      personWithEmail.upsert({
        where: { email: 'grace@example.com' },
        data: { name: 'grace' },
        merge: true,
      }),
    );
    expect(lowered.surql).toContain(
      'IF $hit != [] THEN (UPDATE $hit[0].id MERGE { `name`: $p1 } RETURN AFTER)',
    );
  });

  it('picks the IF statement result envelope, not COMMIT', () => {
    const plan = personWithEmail.upsert({
      where: { email: 'grace@example.com' },
      data: { name: 'grace' },
    });
    expect(plan.resultIndex).toBe(2);
  });

  it('keys a composite unique index, binding every field of the index', () => {
    const lowered = surql(
      eventWithSlug.upsert({
        where: { orgId: 'org1', slug: 'launch' },
        data: { name: 'Launch Day' },
      }),
    );
    expect(lowered.surql).toBe(
      [
        'BEGIN TRANSACTION',
        'LET $hit = (SELECT `id` FROM `event` WHERE (`orgId` = $p0 AND `slug` = $p1) LIMIT 1)',
        'IF $hit != [] THEN (UPDATE $hit[0].id CONTENT { `orgId`: $p2, `slug`: $p3, `name`: $p4 } RETURN AFTER) ELSE (CREATE `event` CONTENT { `orgId`: $p5, `slug`: $p6, `name`: $p7 } RETURN AFTER) END',
        'COMMIT TRANSACTION',
      ].join(';\n'),
    );
    expect(lowered.params.map((p) => p.value)).toEqual([
      'org1',
      'launch',
      'org1',
      'launch',
      'Launch Day',
      'org1',
      'launch',
      'Launch Day',
    ]);
  });

  it('drops BEGIN/COMMIT and the result envelope override inside a caller-managed transaction', () => {
    const plan = personWithEmail.upsert({
      where: { email: 'grace@example.com' },
      data: { name: 'grace' },
      inTransaction: true,
    });
    expect(plan.resultIndex).toBeUndefined();
    expect(surql(plan).surql).toBe(
      [
        'LET $hit = (SELECT `id` FROM `person` WHERE (`email` = $p0) LIMIT 1)',
        'IF $hit != [] THEN (UPDATE $hit[0].id CONTENT { `email`: $p1, `name`: $p2 } RETURN AFTER) ELSE (CREATE `person` CONTENT { `email`: $p3, `name`: $p4 } RETURN AFTER) END',
      ].join(';\n'),
    );
  });

  it('rejects a where that names no declared unique index', () => {
    expect(() => person.upsert({ where: { email: 'grace@example.com' }, data: {} })).toThrow(
      /the table declares no unique indexes/,
    );
  });

  it('rejects a where that does not match any declared unique index', () => {
    expect(() => personWithEmail.upsert({ where: { name: 'grace' }, data: {} })).toThrow(
      /its unique indexes are: \(email\)/,
    );
  });

  it('rejects a where that only partially covers a composite unique index', () => {
    expect(() => eventWithSlug.upsert({ where: { orgId: 'org1' }, data: {} })).toThrow(
      /its unique indexes are: \(orgId, slug\)/,
    );
  });
});

describe('graph', () => {
  const follows = new SurrealCollection('follows', 'sh');

  it('relates two records, the edge carrying its own fields', () => {
    const lowered = surql(
      follows.relate({
        from: new RecordId('person', 'alice'),
        to: new RecordId('person', 'bob'),
        data: { since: '2024-01-01' },
      }),
    );
    expect(lowered.surql).toBe(
      'RELATE `person`:`alice`->`follows`->`person`:`bob` CONTENT { `since`: $p0 } RETURN AFTER',
    );
  });

  it('accepts record ids in their table:id text form', () => {
    expect(surql(follows.relate({ from: 'person:alice', to: 'person:bob' })).surql).toBe(
      'RELATE `person`:`alice`->`follows`->`person`:`bob` RETURN AFTER',
    );
  });

  it('rejects text that is not a record id rather than emitting a field name', () => {
    expect(() => follows.relate({ from: 'alice', to: 'person:bob' })).toThrow(/not a record id/);
  });

  it('marks an edge UNIQUE when asked', () => {
    expect(
      surql(follows.relate({ from: 'person:a', to: 'person:b', unique: true })).surql,
    ).toContain('UNIQUE');
  });

  it('walks an edge outward by default', () => {
    expect(surql(person.traverse({ from: 'person:a', edge: 'follows', to: 'person' })).surql).toBe(
      'SELECT `id`->`follows`->`person` AS `related` FROM `person`',
    );
  });

  it('walks an edge inward and projects named fields', () => {
    expect(
      surql(
        person.traverse({
          from: 'person:a',
          edge: 'follows',
          direction: 'in',
          to: 'person',
          select: ['name'],
        }),
      ).surql,
    ).toBe('SELECT `id`<-`follows`<-`person`.`name` AS `name` FROM `person`');
  });
});

describe('identifying a record', () => {
  const people = new SurrealCollection('person', 'sh');

  it('takes the key as text', () => {
    expect(lowerQuery(people.findUnique('alice').query).surql).toBe(
      'SELECT * FROM ONLY `person`:`alice`',
    );
  });

  // A read hands back a RecordId, so one has to be accepted straight back.
  it('takes a RecordId a read produced', () => {
    expect(lowerQuery(people.findUnique(new RecordId('person', 'alice')).query).surql).toBe(
      'SELECT * FROM ONLY `person`:`alice`',
    );
  });

  it('keeps a numeric key numeric', () => {
    expect(lowerQuery(people.findUnique(12).query).surql).toBe('SELECT * FROM ONLY `person`:12');
  });

  it('refuses a RecordId from another table rather than reading the wrong row', () => {
    expect(() => people.findUnique(new RecordId('company', 'acme'))).toThrow(
      /belongs to table "company", not "person"/,
    );
  });

  it('routes a complex key through type::record', () => {
    expect(lowerQuery(people.findUnique(new RecordId('person', ['a', 1])).query).surql).toContain(
      'type::record(',
    );
  });
});
