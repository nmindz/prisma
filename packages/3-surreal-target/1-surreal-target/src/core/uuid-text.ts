import type { ToCanonicalForm } from '@internal/framework-components/codec';
import { castRefused, wrongShape } from './errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A UUID as SurrealDB writes one, hyphenated and in lower case, or a refusal. */
export function canonicalUuidText(text: string): string {
  if (UUID.test(text)) return text.toLowerCase();
  return castRefused(
    `"${text}" is not a UUID: surrealdb/uuid reads 32 hexadecimal digits in groups of 8, 4, 4, 4 and 12, separated by hyphens, as in "018e0d1e-0000-7000-8000-000000000000".`,
    'Write the UUID in its hyphenated form.',
  );
}

/** The canonical form of `surrealdb/uuid`. */
export const uuidCanonicalForm: ToCanonicalForm = (value) =>
  typeof value === 'string' ? canonicalUuidText(value) : wrongShape(value, 'UUID text');
