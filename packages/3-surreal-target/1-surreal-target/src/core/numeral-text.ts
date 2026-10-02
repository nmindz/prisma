/**
 * Numeral text: how a written number and a `decimal` value are stored in the contract, and the
 * limits of SurrealDB's `decimal`, a 96-bit mantissa with at most 28 digits after the point.
 */

import type { ToCanonicalForm } from '@internal/framework-components/codec';
import { castRefused, wrongShape } from './errors';

const NUMERAL = /^(-?)(\d+)(?:\.(\d+))?$/;
const DECIMAL_MAX_MANTISSA = 2n ** 96n - 1n;
const DECIMAL_MAX_SCALE = 28;

/**
 * A number as a contract source writes it: no exponent, so the point moves to where the exponent
 * puts it. This is also the text SurrealDB prints for a float, before its `f` suffix.
 */
export function numeralText(value: number): string {
  const [coefficient = '', exponent] = String(value).split('e');
  if (exponent === undefined) return coefficient;
  const sign = coefficient.startsWith('-') ? '-' : '';
  const [whole = '', fraction = ''] = coefficient.slice(sign.length).split('.');
  const digits = `${whole}${fraction}`;
  const point = whole.length + Number(exponent);
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${'0'.repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/**
 * Numeral text without leading zeros or a negative zero, keeping trailing zeros; `undefined` when
 * the text is not a numeral.
 */
export function canonicalNumeralText(text: string): string | undefined {
  const numeral = NUMERAL.exec(text);
  if (numeral === null) return undefined;
  const [, sign = '', whole = '', fraction] = numeral;
  const digits = whole.replace(/^0+(?=\d)/, '');
  const zero = /^0+$/.test(digits) && (fraction === undefined || /^0+$/.test(fraction));
  return `${zero ? '' : sign}${digits}${fraction === undefined ? '' : `.${fraction}`}`;
}

/** Whether canonical numeral text is a value SurrealDB's `decimal` holds exactly. */
function fitsDecimal(canonical: string): boolean {
  const [whole = '', fraction = ''] = canonical.replace(/^-/, '').split('.');
  const significant = fraction.replace(/0+$/, '');
  return (
    significant.length <= DECIMAL_MAX_SCALE &&
    BigInt(`${whole}${significant}`) <= DECIMAL_MAX_MANTISSA
  );
}

/** Canonical numeral text a SurrealDB `decimal` holds exactly, or a refusal. */
export function canonicalDecimalText(text: string): string {
  const canonical = canonicalNumeralText(text);
  if (canonical === undefined) {
    return castRefused(
      `"${text}" is not decimal numeral text: write digits with an optional minus sign and fraction, as in "-7.50".`,
      'Write the decimal without an exponent, a plus sign or a bare point.',
    );
  }
  if (!fitsDecimal(canonical)) {
    return castRefused(
      `"${text}" is outside what surrealdb/decimal holds: at most ${DECIMAL_MAX_SCALE} digits after the point, and digits that, read without the point, are at most ${DECIMAL_MAX_MANTISSA}.`,
      'Write fewer digits, or store the value in a float or string field.',
    );
  }
  return canonical;
}

/** The canonical form of `surrealdb/decimal`. */
export const decimalCanonicalForm: ToCanonicalForm = (value) =>
  typeof value === 'string'
    ? canonicalDecimalText(value)
    : wrongShape(value, 'decimal numeral text');

/** Canonical decimal text as SurrealDB prints it: trailing zeros after the point dropped. */
export function normalizedDecimalText(canonical: string): string {
  const [whole = '', fraction] = canonical.split('.');
  const significant = fraction?.replace(/0+$/, '') ?? '';
  return significant === '' ? whole : `${whole}.${significant}`;
}
