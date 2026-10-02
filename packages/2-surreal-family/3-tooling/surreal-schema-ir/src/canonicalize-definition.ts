/**
 * Normalizes a `DEFINE …` statement so a definition written by this codebase
 * and the same definition echoed back by SurrealDB compare equal.
 *
 * This is the piece a schema differ cannot do without. SurrealDB does not
 * store the text it was given — it stores a parsed definition and renders it
 * back in its own canonical form, which differs from the input in at least
 * six ways under v3.2.4. Each rule below cites the input/output pair it
 * collapses.
 */

/** Rules applied to every definition, whatever kind it is. */
const SHARED_RULES: readonly ((text: string) => string)[] = [
  // Backtick quoting is ours; SurrealDB echoes bare identifiers.
  //   in:  DEFINE TABLE `person` …        out: DEFINE TABLE person …
  (text) => text.replaceAll('`', ''),
  // Whitespace runs collapse — the renderer joins clauses with single spaces,
  // but a hand-written migration may not.
  (text) => text.replace(/\s+/g, ' ').trim(),
  // `DEFINE FIELD x ON TABLE t` is echoed back without the TABLE keyword:
  //   in:  DEFINE FIELD name ON TABLE person TYPE string
  //   out: DEFINE FIELD name ON person TYPE string PERMISSIONS FULL
  // The keyword is optional on input and absent on output, so both sides drop
  // it. Anchored on the word boundary so a table literally named `TABLE …`
  // cannot be mangled.
  (text) => text.replace(/\bON TABLE\s+/gi, 'ON '),
];

/**
 * Clauses SurrealDB appends when the definition omits them. Dropping them
 * from both sides is what keeps an unspecified default from reading as drift.
 *
 *   in:  DEFINE TABLE person TYPE NORMAL SCHEMAFULL
 *   out: DEFINE TABLE person TYPE NORMAL SCHEMAFULL PERMISSIONS NONE
 */
const MATERIALIZED_DEFAULTS: readonly RegExp[] = [/ PERMISSIONS NONE$/i, / PERMISSIONS FULL$/i];

/**
 * `option<T>` is sugar. SurrealDB stores and reports the expansion:
 *
 *   in:  DEFINE FIELD balance ON person TYPE option<decimal>
 *   out: DEFINE FIELD balance ON person TYPE none | decimal
 *
 * Rewriting ours to theirs (rather than the reverse) avoids having to find the
 * matching angle bracket in a nested type.
 */
/** Index of the `>` closing the `<` at `open`, or -1 when unbalanced. */
function matchingAngle(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '<') depth += 1;
    else if (text[i] === '>') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function expandOptionSugar(text: string): string {
  let out = text;
  // Bounded rather than `while (true)`: a malformed type would otherwise spin.
  for (let pass = 0; pass < 32; pass += 1) {
    const start = out.search(/\boption</);
    if (start === -1) break;
    const open = out.indexOf('<', start);
    const close = matchingAngle(out, open);
    if (close === -1) break;
    out = `${out.slice(0, start)}none | ${out.slice(open + 1, close)}${out.slice(close + 1)}`;
  }
  return out;
}

/**
 * Analyzer tokenizers and filters come back upper-cased:
 *
 *   in:  DEFINE ANALYZER english TOKENIZERS blank,class FILTERS lowercase
 *   out: DEFINE ANALYZER english TOKENIZERS BLANK,CLASS FILTERS LOWERCASE
 */
function upperCaseAnalyzerLists(text: string): string {
  return text.replace(
    /\b(TOKENIZERS|FILTERS)\s+([^\s]+(?:\s*,\s*[^\s]+)*)/gi,
    (_match, keyword: string, list: string) =>
      `${keyword.toUpperCase()} ${list.replace(/\s*,\s*/g, ',').toUpperCase()}`,
  );
}

/**
 * Index tuning parameters SurrealDB fills in when they are not given:
 *
 *   in:  … FULLTEXT ANALYZER english BM25
 *   out: … FULLTEXT ANALYZER english BM25(1.2,0.75)
 *
 *   in:  … HNSW DIMENSION 3 DIST COSINE
 *   out: … HNSW DIMENSION 3 DIST COSINE TYPE F32 EFC 150 M 12 M0 24 LM 0.402…f
 *
 * The HNSW tail is dropped from both sides rather than predicted: `LM` is a
 * derived float whose printed form carries an `f` suffix and full double
 * precision, and reproducing it here would be a second implementation of
 * SurrealDB's own arithmetic waiting to disagree.
 */
function dropIndexTuning(text: string): string {
  return text
    .replace(/BM25\([^)]*\)/gi, 'BM25')
    .replace(/\s+TYPE\s+F(?:32|64)\b/gi, '')
    .replace(/\s+EFC\s+\d+/gi, '')
    .replace(/\s+M0?\s+\d+/gi, '')
    .replace(/\s+LM\s+[\d.]+f?/gi, '');
}

/** Canonicalizes one `DEFINE …` statement for comparison. */
export function canonicalizeDefinition(text: string): string {
  let out = text;
  for (const rule of SHARED_RULES) out = rule(out);
  out = expandOptionSugar(out);
  out = upperCaseAnalyzerLists(out);
  out = dropIndexTuning(out);
  for (const pattern of MATERIALIZED_DEFAULTS) out = out.replace(pattern, '');
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Whether a field path is one SurrealDB generated rather than one the
 * contract declared.
 *
 * Defining `embedding` as `array<float>` makes SurrealDB add `embedding.*`
 * on its own. Treating that as an undeclared field would make every array in
 * the contract look like drift, and dropping it would make every `db update`
 * try to remove a field the database recreates.
 */
export function isGeneratedArrayChild(path: string, declaredPaths: ReadonlySet<string>): boolean {
  if (!path.endsWith('.*')) return false;
  return declaredPaths.has(path.slice(0, -2));
}
