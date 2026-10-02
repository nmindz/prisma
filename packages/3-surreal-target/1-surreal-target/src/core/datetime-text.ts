/**
 * The canonical form of `surrealdb/datetime`, the instant in UTC, and the text SurrealDB prints for
 * one. No `Date` is used, so a value reads the same on every runtime.
 */

import type { ToCanonicalForm } from '@internal/framework-components/codec';
import { castRefused, wrongShape } from './errors';

const ID = 'surrealdb/datetime';
const EXAMPLE = '2024-01-01T12:34:56Z';
const EARLIEST = '-262143-01-01T00:00:00Z';
const LATEST = '+262142-12-31T23:59:59.999999999Z';
const MAX_FRACTION_DIGITS = 9;
const SECONDS_PER_DAY = 86_400;

const DATETIME =
  /^([+-]\d{4,6}|\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?(?:([Zz])|([+-])(\d{2}):(\d{2}))?$/;

interface CivilDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** An instant in UTC: days from 1970-01-01, the second of that day, and the fraction's digits. */
interface Instant {
  readonly days: number;
  readonly second: number;
  readonly fraction: string;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Days from 1970-01-01 to a date of the proleptic Gregorian calendar, with year 0 as 1 BC. */
function daysFromCivil({ year, month, day }: CivilDate): number {
  const shifted = month <= 2 ? year - 1 : year;
  const era = Math.floor(shifted / 400);
  const yearOfEra = shifted - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

function civilFromDays(days: number): CivilDate {
  const shifted = days + 719_468;
  const era = Math.floor(shifted / 146_097);
  const dayOfEra = shifted - era * 146_097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1460) +
      Math.floor(dayOfEra / 36_524) -
      Math.floor(dayOfEra / 146_096)) /
      365,
  );
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthIndex = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthIndex + 2) / 5) + 1;
  const month = monthIndex < 10 ? monthIndex + 3 : monthIndex - 9;
  return { year: yearOfEra + era * 400 + (month <= 2 ? 1 : 0), month, day };
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

const EARLIEST_INSTANT: Instant = {
  days: daysFromCivil({ year: -262_143, month: 1, day: 1 }),
  second: 0,
  fraction: '',
};
const LATEST_INSTANT: Instant = {
  days: daysFromCivil({ year: 262_142, month: 12, day: 31 }),
  second: SECONDS_PER_DAY - 1,
  fraction: '999999999',
};

function isBefore(left: Instant, right: Instant): boolean {
  if (left.days !== right.days) return left.days < right.days;
  if (left.second !== right.second) return left.second < right.second;
  return (
    left.fraction.padEnd(MAX_FRACTION_DIGITS, '0') < right.fraction.padEnd(MAX_FRACTION_DIGITS, '0')
  );
}

function unreadable(text: string): never {
  return castRefused(
    `${ID} cannot read "${text}". Write a date and time with a UTC offset, as in "${EXAMPLE}".`,
    'Write ISO 8601 date and time text ending in Z or an offset such as +02:00.',
  );
}

/** The instant written datetime text names, or a refusal that says what is wrong with it. */
function readInstant(text: string): Instant {
  const match = DATETIME.exec(text);
  if (match === null) return unreadable(text);
  const [, yearText = '', month = '', day = '', hour, minute = '', second = '00'] = match;
  const [fraction = '', zulu, offsetSign, offsetHours = '', offsetMinutes = ''] = match.slice(7);
  const year = Number(yearText);
  if (yearText.startsWith('-') && year === 0) return unreadable(text);
  if (hour === undefined) {
    return castRefused(
      `${ID} holds a date and time with a UTC offset, but "${text}" has no time of day. Write the time too, as in "${EXAMPLE}".`,
      'Add a time of day and a UTC offset.',
    );
  }
  if (zulu === undefined && offsetSign === undefined) {
    return castRefused(
      `${ID} needs a UTC offset, but "${text}" has none. Add Z for UTC or an offset such as +02:00, as in "${EXAMPLE}".`,
      'Add Z or an offset.',
    );
  }
  if (fraction.length > MAX_FRACTION_DIGITS) {
    return castRefused(
      `"${text}" has ${fraction.length} digits after the decimal point, but ${ID} holds nanoseconds, so at most ${MAX_FRACTION_DIGITS}. Round it, as in "2024-01-01T12:34:56.123456789Z".`,
      'Round the fraction to nanoseconds.',
    );
  }
  const date = { year, month: Number(month), day: Number(day) };
  if (
    date.month < 1 ||
    date.month > 12 ||
    date.day < 1 ||
    date.day > daysInMonth(year, date.month)
  ) {
    return castRefused(
      `"${text}" is not a date that exists. Write a real date, as in "${EXAMPLE}".`,
      'Write a date of the Gregorian calendar.',
    );
  }
  const clock = { hour: Number(hour), minute: Number(minute), second: Number(second) };
  if (clock.hour > 23 || clock.minute > 59 || clock.second > 59) {
    return castRefused(
      `"${text}" is not a time of day that exists: hours run from 00 to 23, and minutes and seconds from 00 to 59. Write one, as in "${EXAMPLE}".`,
      'Write a time of day that exists.',
    );
  }
  if (Number(offsetHours) > 23 || Number(offsetMinutes) > 59) {
    return castRefused(
      `"${text}" has a UTC offset outside -23:59 to +23:59, which ${ID} does not hold. Write a smaller offset, as in "2024-01-01T12:34:56+02:00".`,
      'Write an offset SurrealDB holds.',
    );
  }
  const offset =
    (Number(offsetHours) * 3600 + Number(offsetMinutes) * 60) * (offsetSign === '-' ? -1 : 1);
  const utc =
    daysFromCivil(date) * SECONDS_PER_DAY +
    clock.hour * 3600 +
    clock.minute * 60 +
    clock.second -
    offset;
  const days = Math.floor(utc / SECONDS_PER_DAY);
  const instant = {
    days,
    second: utc - days * SECONDS_PER_DAY,
    fraction: fraction.replace(/0+$/, ''),
  };
  if (isBefore(instant, EARLIEST_INSTANT) || isBefore(LATEST_INSTANT, instant)) {
    return castRefused(
      `${ID} holds instants from ${EARLIEST} to ${LATEST}, and "${text}" is outside them.`,
      'Write an instant inside the range SurrealDB holds.',
    );
  }
  return instant;
}

function printInstant(
  instant: Instant,
  yearText: (year: number) => string,
  fractionText: (fraction: string) => string,
): string {
  const { year, month, day } = civilFromDays(instant.days);
  const hour = Math.floor(instant.second / 3600);
  const minute = Math.floor(instant.second / 60) % 60;
  const second = instant.second % 60;
  const fraction = instant.fraction === '' ? '' : `.${fractionText(instant.fraction)}`;
  return `${yearText(year)}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}${fraction}Z`;
}

/** A year from 0000 to 9999 has four digits; any other year is a sign and six digits. */
function isoYear(year: number): string {
  if (year >= 0 && year <= 9999) return pad(year, 4);
  return `${year < 0 ? '-' : '+'}${pad(Math.abs(year), 6)}`;
}

/** SurrealDB signs a year outside 0000–9999 and pads it to four digits only. */
function surrealYear(year: number): string {
  if (year >= 0 && year <= 9999) return pad(year, 4);
  return `${year < 0 ? '-' : '+'}${pad(Math.abs(year), 4)}`;
}

/** SurrealDB writes a fraction in milliseconds, microseconds or nanoseconds, whichever holds it. */
function surrealFraction(fraction: string): string {
  const width = fraction.length <= 3 ? 3 : fraction.length <= 6 ? 6 : 9;
  return fraction.padEnd(width, '0');
}

/** The canonical form of datetime text, or a refusal naming what is wrong with it. */
export function canonicalDatetimeText(text: string): string {
  return printInstant(readInstant(text), isoYear, (fraction) => fraction);
}

/** Datetime text as SurrealDB prints it, the body of the `d'…'` literal it echoes back. */
export function surrealDatetimeText(text: string): string {
  return printInstant(readInstant(text), surrealYear, surrealFraction);
}

export const datetimeCanonicalForm: ToCanonicalForm = (value) =>
  typeof value === 'string' ? canonicalDatetimeText(value) : wrongShape(value, 'datetime text');
