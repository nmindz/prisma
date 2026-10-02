import { RecordId } from '@internal/surreal-value';
import { describe, expect, it } from 'vitest';
import type { ControlQueryable } from '../src/exports/control';
import {
  MARKER_TABLE,
  readAllMarkerRows,
  readLedgerRows,
  readMarkerRow,
} from '../src/exports/control';

function fakeQueryable(rows: readonly Record<string, unknown>[]): ControlQueryable {
  return {
    query<Row>(): AsyncIterable<Row> {
      return {
        async *[Symbol.asyncIterator](): AsyncIterator<Row> {
          for (const row of rows) yield row as Row;
        },
      };
    },
  };
}

const validMarkerRow = {
  id: new RecordId(MARKER_TABLE, 'app'),
  storageHash: 'sh',
  profileHash: 'ph',
  contractJson: null,
  canonicalVersion: null,
  updatedAt: '2024-05-06T07:08:09Z',
  appTag: null,
  meta: {},
  invariants: [],
};

describe('readAllMarkerRows — corrupt rows', () => {
  it('reads a row keyed by its RecordId', async () => {
    const all = await readAllMarkerRows(fakeQueryable([validMarkerRow]));
    expect([...all.keys()]).toEqual(['app']);
  });

  it('throws naming the id field when a row id is neither a RecordId nor a string', async () => {
    const corrupt = { ...validMarkerRow, id: 42 };
    await expect(readAllMarkerRows(fakeQueryable([corrupt]))).rejects.toMatchObject({
      code: 'CONTRACT.MARKER_INVALID',
      meta: { field: 'id' },
    });
  });

  it('throws naming the id field when a row id is a bare string with no colon', async () => {
    const corrupt = { ...validMarkerRow, id: 'not-a-record-id' };
    await expect(readAllMarkerRows(fakeQueryable([corrupt]))).rejects.toMatchObject({
      code: 'CONTRACT.MARKER_INVALID',
      meta: { field: 'id' },
    });
  });

  it('throws naming the field when updatedAt is missing', async () => {
    const { updatedAt: _updatedAt, ...corrupt } = validMarkerRow;
    await expect(readAllMarkerRows(fakeQueryable([corrupt]))).rejects.toMatchObject({
      code: 'CONTRACT.MARKER_INVALID',
      meta: { field: 'updatedAt' },
    });
  });

  it('throws naming the field when updatedAt does not parse as a date', async () => {
    const corrupt = { ...validMarkerRow, updatedAt: 'not-a-date' };
    await expect(readAllMarkerRows(fakeQueryable([corrupt]))).rejects.toMatchObject({
      code: 'CONTRACT.MARKER_INVALID',
      meta: { field: 'updatedAt', value: 'not-a-date' },
    });
  });
});

describe('readMarkerRow — corrupt rows', () => {
  it('throws when the stored updatedAt is unparseable', async () => {
    const corrupt = { ...validMarkerRow, updatedAt: 'garbage' };
    await expect(readMarkerRow(fakeQueryable([corrupt]), 'app')).rejects.toMatchObject({
      code: 'CONTRACT.MARKER_INVALID',
      meta: { field: 'updatedAt' },
    });
  });
});

describe('readLedgerRows — corrupt rows', () => {
  const validLedgerRow = {
    space: 'app',
    migrationName: '0001_first',
    migrationHash: 'hash',
    from: null,
    to: 'sh',
    appliedAt: '2024-01-01T00:00:00Z',
    operationCount: 1,
  };

  it('reads a well-formed entry', async () => {
    const entries = await readLedgerRows(fakeQueryable([validLedgerRow]));
    expect(entries).toHaveLength(1);
  });

  it('throws naming the field when appliedAt does not parse as a date', async () => {
    const corrupt = { ...validLedgerRow, appliedAt: 'nope' };
    await expect(readLedgerRows(fakeQueryable([corrupt]))).rejects.toMatchObject({
      code: 'CONTRACT.MARKER_INVALID',
      meta: { field: 'appliedAt', value: 'nope' },
    });
  });

  it('throws naming the field when appliedAt is missing', async () => {
    const { appliedAt: _appliedAt, ...corrupt } = validLedgerRow;
    await expect(readLedgerRows(fakeQueryable([corrupt]))).rejects.toMatchObject({
      code: 'CONTRACT.MARKER_INVALID',
      meta: { field: 'appliedAt' },
    });
  });
});
