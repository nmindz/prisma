import type { FamilyPackRef } from '@internal/framework-components/components';

/**
 * The SurrealDB family pack reference.
 *
 * Shared-plane and data-only: a contract names this to say which family it
 * belongs to, and nothing here reaches the control or execution planes.
 */
const surrealFamilyPack = {
  kind: 'family',
  id: 'surreal',
  familyId: 'surreal',
  version: '0.0.1',
} as const satisfies FamilyPackRef<'surreal'>;

export default surrealFamilyPack;
