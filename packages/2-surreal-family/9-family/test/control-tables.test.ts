import { describe, expect, it } from 'vitest';
import { CONTROL_TABLE_DDL, LEDGER_TABLE, MARKER_TABLE } from '../src/exports/control';

describe('control table DDL', () => {
  it('guards every statement with IF NOT EXISTS', () => {
    for (const statement of CONTROL_TABLE_DDL) {
      expect(statement).toMatch(/IF NOT EXISTS/);
    }
  });

  it('defines the marker table before its fields', () => {
    const table = CONTROL_TABLE_DDL.findIndex((s) =>
      s.includes(`TABLE IF NOT EXISTS \`${MARKER_TABLE}\``),
    );
    const field = CONTROL_TABLE_DDL.findIndex((s) => s.includes(`ON TABLE \`${MARKER_TABLE}\``));
    expect(table).toBeGreaterThanOrEqual(0);
    expect(field).toBeGreaterThan(table);
  });

  it('defines the ledger index after the fields it covers', () => {
    const field = CONTROL_TABLE_DDL.findIndex((s) => s.includes('`space` ON TABLE'));
    const index = CONTROL_TABLE_DDL.findIndex((s) => s.includes('DEFINE INDEX'));
    expect(index).toBeGreaterThan(field);
  });

  it('makes both tables schemafull, so a bad hand-edit is rejected', () => {
    expect(CONTROL_TABLE_DDL.filter((s) => s.includes('SCHEMAFULL'))).toHaveLength(2);
  });

  it('keeps the contract payload flexible, since a contract is arbitrary JSON', () => {
    expect(CONTROL_TABLE_DDL.find((s) => s.includes('`contractJson`'))).toContain('FLEXIBLE');
  });

  it('prefixes both tables so they cannot collide with application tables', () => {
    expect(MARKER_TABLE.startsWith('_prisma_')).toBe(true);
    expect(LEDGER_TABLE.startsWith('_prisma_')).toBe(true);
  });
});
