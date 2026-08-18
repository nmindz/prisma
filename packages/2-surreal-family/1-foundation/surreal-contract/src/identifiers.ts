import { structuredError } from '@internal/utils/structured-error';

/**
 * SurrealQL identifiers that need no quoting: an ASCII letter or underscore
 * followed by ASCII letters, digits, or underscores. Anything else — a space,
 * a hyphen, a leading digit, a non-ASCII letter — has to be escaped, and so
 * does anything that might collide with a keyword.
 */
const BARE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Quotes an identifier for SurrealQL.
 *
 * Always quotes, even when the name would survive bare. SurrealQL has a large
 * and growing keyword set (`type`, `value`, `content`, `order`, …), and a
 * renderer that decides per-name which ones are safe is a renderer that
 * breaks when the next SurrealDB release adds a keyword. Unconditional
 * quoting has no such failure mode.
 *
 * Backticks are the escape form rather than the `⟨…⟩` brackets SurrealDB also
 * accepts: SurrealDB's parser has no escape for a closing `⟩` inside a
 * bracketed identifier, so a name containing one could not be represented at
 * all. Inside backticks both `\` and `` ` `` escape, which covers every name.
 */
export function quoteIdentifier(name: string): string {
  if (name.includes('\u0000')) {
    throw structuredError(
      'RUNTIME.AST_UNSUPPORTED',
      'SurrealQL identifiers cannot contain a NUL character',
      { meta: { target: 'surrealdb' } },
    );
  }
  return `\`${name.replaceAll('\\', '\\\\').replaceAll('`', '\\`')}\``;
}

/** True when `name` would parse unquoted. Used by diagnostics, not by rendering. */
export function isBareIdentifier(name: string): boolean {
  return BARE_IDENTIFIER.test(name);
}

/**
 * Renders a JS string as a single-quoted SurrealQL string literal.
 *
 * Only reached for text the contract itself owns — a literal type's members,
 * a table name inside a diagnostic. Application values travel as bound
 * parameters and never pass through here, which is what keeps the query text
 * free of user data.
 */
export function escapeStringLiteral(value: string): string {
  const escaped = value
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "\\'")
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t');
  return `'${escaped}'`;
}
