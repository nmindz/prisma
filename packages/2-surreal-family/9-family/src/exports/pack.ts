import type { AuthoringAttributeSpecContributions } from '@internal/framework-components/authoring';
import type { FamilyPackRef } from '@internal/framework-components/components';
import { surrealAttributeSpecs } from '@internal/surreal-contract-psl';

const surrealFamilyAttributeSpecs: AuthoringAttributeSpecContributions = surrealAttributeSpecs;

/**
 * The SurrealDB family pack reference.
 *
 * Shared-plane and data-only: a contract names this to say which family it
 * belongs to, and the language server reads its PSL attribute specs.
 */
const surrealFamilyPack = {
  kind: 'family',
  id: 'surreal',
  familyId: 'surreal',
  version: '0.0.1',
  authoring: {
    attributeSpecs: surrealFamilyAttributeSpecs,
  },
} as const satisfies FamilyPackRef<'surreal'>;

export default surrealFamilyPack;
