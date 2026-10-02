/**
 * Reading a literal `@default(...)` value: the authoring entry for the syntax it is written in gives
 * it a data type, the field's type takes it directly or through a cast it declares, and the field's
 * codec reads the canonical form with `decodeJson`, which refuses a value the field would not store.
 * No per-type code lives here. ADR 254.
 */

import type { JsonValue } from '@internal/contract/types';
import type { DataTypeAuthoringEntry } from '@internal/framework-components/authoring';
import type {
  CodecLookupWithDescriptors,
  DataTypeId,
  DataTypeLookup,
} from '@internal/framework-components/codec';
import { codecForRef } from '@internal/framework-components/codec';
import { blindCast } from '@internal/utils/casts';
import { InternalError, isInternalError } from '@internal/utils/internal-error';

/** One written value, in the syntax PSL wrote it in. */
export type WrittenValue =
  | { readonly kind: 'tag'; readonly tag: string; readonly text: string }
  | { readonly kind: 'string'; readonly text: string }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'number'; readonly text: string }
  | { readonly kind: 'list'; readonly elements: readonly WrittenValue[] };

type WrittenScalar = Exclude<WrittenValue, { readonly kind: 'list' }>;

/** The assembled data types of a stack and the PSL support for them. */
export interface DataTypeSupport {
  readonly entries: Readonly<Record<string, DataTypeAuthoringEntry>>;
  readonly lookup: DataTypeLookup;
}

/** A value of a known data type: what an authoring entry reads written text into. */
export interface TypedValue {
  readonly type: DataTypeId;
  readonly value: JsonValue;
}

type RefusalBody =
  | { readonly kind: 'unreadable'; readonly message: string }
  | { readonly kind: 'unknown-tag'; readonly tag: string; readonly known: readonly string[] }
  | { readonly kind: 'unwritable'; readonly syntax: string }
  | { readonly kind: 'not-a-list' }
  | {
      readonly kind: 'no-cast';
      readonly fieldType: string;
      readonly valueType: string;
      readonly casts: readonly string[];
    }
  | { readonly kind: 'refused-by-codec'; readonly codecId: string; readonly message: string };

/** Why a default was refused; `elementIndex` names the list element it is about. */
export type DefaultRefusal = RefusalBody & { readonly elementIndex: number | undefined };

type ReadResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: DefaultRefusal };

export type DefaultDiagnosticResult =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly code: string; readonly message: string };

function refuse(body: RefusalBody, elementIndex: number | undefined): ReadResult<never> {
  return { ok: false, refusal: { ...body, elementIndex } };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The entry a tag names, or `undefined` when no pack registered that tag. */
export function entryForTag(
  support: DataTypeSupport,
  tag: string,
): { readonly key: string; readonly entry: DataTypeAuthoringEntry } | undefined {
  for (const [key, entry] of Object.entries(support.entries)) {
    if (entry.written.kind === 'tag' && entry.written.tag === tag) return { key, entry };
  }
  return undefined;
}

/** Every tag a stack registers, in the order the entries were merged. */
export function knownTags(support: DataTypeSupport): readonly string[] {
  return Object.values(support.entries).flatMap((entry) =>
    entry.written.kind === 'tag' ? [entry.written.tag] : [],
  );
}

function entryForPlain(
  support: DataTypeSupport,
  syntax: 'string' | 'boolean' | 'number',
): { readonly key: string; readonly entry: DataTypeAuthoringEntry } | undefined {
  for (const [key, entry] of Object.entries(support.entries)) {
    if (entry.written.kind === 'plain' && entry.written.syntax === syntax) return { key, entry };
  }
  return undefined;
}

function writtenText(written: WrittenScalar): string {
  return written.kind === 'boolean' ? String(written.value) : written.text;
}

/** Reads one written value through the entry for its syntax. */
export function readValue(
  support: DataTypeSupport,
  written: WrittenScalar,
  elementIndex: number | undefined,
): ReadResult<TypedValue> {
  const found =
    written.kind === 'tag'
      ? entryForTag(support, written.tag)
      : entryForPlain(support, written.kind);
  if (found === undefined) {
    return written.kind === 'tag'
      ? refuse({ kind: 'unknown-tag', tag: written.tag, known: knownTags(support) }, elementIndex)
      : refuse({ kind: 'unwritable', syntax: written.kind }, elementIndex);
  }

  const text = writtenText(written);
  const form = found.entry.written;
  if (form.kind === 'plain' && form.syntax === 'number') {
    const classified = form.classify(text);
    return classified === undefined
      ? refuse(
          { kind: 'unreadable', message: `no data type of this target holds the number ${text}` },
          elementIndex,
        )
      : { ok: true, value: classified };
  }

  try {
    return {
      ok: true,
      value: {
        type: blindCast<DataTypeId, 'an entry key is the id of the type it reads'>(found.key),
        value: form.parse(text),
      },
    };
  } catch (error) {
    if (isInternalError(error)) throw error;
    return refuse({ kind: 'unreadable', message: messageOf(error) }, elementIndex);
  }
}

/** Converts a value into the form the field's type stores, when that type takes it. */
function castInto(
  support: DataTypeSupport,
  fieldType: DataTypeId,
  typed: TypedValue,
  elementIndex: number | undefined,
): ReadResult<JsonValue> {
  if (typed.type === fieldType) return { ok: true, value: typed.value };
  const declaration = support.lookup.get(fieldType);
  const cast = declaration?.casts[typed.type];
  if (cast === undefined) {
    return refuse(
      {
        kind: 'no-cast',
        fieldType,
        valueType: typed.type,
        casts: Object.keys(declaration?.casts ?? {}),
      },
      elementIndex,
    );
  }
  try {
    return { ok: true, value: cast(typed.value) };
  } catch (error) {
    if (isInternalError(error)) throw error;
    return refuse({ kind: 'unreadable', message: messageOf(error) }, elementIndex);
  }
}

/** The field codec's data type, and `read`, which checks a canonical form with the codec's `decodeJson`. */
function storedValueReader(
  codecId: string,
  codecLookup: CodecLookupWithDescriptors,
  fieldPath: string,
): {
  readonly fieldType: DataTypeId;
  readonly read: (value: JsonValue, elementIndex: number | undefined) => ReadResult<JsonValue>;
} {
  const descriptor = codecLookup.descriptorFor(codecId);
  const codec = codecForRef(codecLookup, { codecId });
  if (descriptor === undefined || codec === undefined) {
    throw new InternalError(
      `Field "${fieldPath}": no codec descriptor is registered for "${codecId}", the codec its type implies.`,
    );
  }
  const read = (value: JsonValue, elementIndex: number | undefined): ReadResult<JsonValue> => {
    try {
      codec.decodeJson(value);
      return { ok: true, value };
    } catch (error) {
      if (isInternalError(error)) throw error;
      return refuse({ kind: 'refused-by-codec', codecId, message: messageOf(error) }, elementIndex);
    }
  };
  return { fieldType: descriptor.dataType, read };
}

const NESTED_LIST: RefusalBody = {
  kind: 'unreadable',
  message: 'a list holds values, not other lists',
};

/**
 * Reads one `@default(...)` value for a field. A list field's elements are each read, cast and
 * checked against the element codec; a field that is not a list takes a written list only through
 * its type's list cast.
 */
export function readDataTypeDefault(input: {
  readonly written: WrittenValue;
  readonly isList: boolean;
  readonly codecId: string;
  readonly codecLookup: CodecLookupWithDescriptors;
  readonly support: DataTypeSupport;
  readonly fieldPath: string;
}): ReadResult<JsonValue> {
  const { fieldType, read: readStored } = storedValueReader(
    input.codecId,
    input.codecLookup,
    input.fieldPath,
  );

  const readOne = (
    written: WrittenScalar,
    elementIndex: number | undefined,
  ): ReadResult<JsonValue> => {
    const read = readValue(input.support, written, elementIndex);
    if (!read.ok) return read;
    const cast = castInto(input.support, fieldType, read.value, elementIndex);
    if (!cast.ok) return cast;
    return readStored(cast.value, elementIndex);
  };

  if (input.written.kind !== 'list') {
    return input.isList
      ? refuse({ kind: 'not-a-list' }, undefined)
      : readOne(input.written, undefined);
  }

  if (!input.isList) {
    return readListIntoScalar({
      written: input.written,
      support: input.support,
      fieldType,
      readStored,
    });
  }

  const elements: JsonValue[] = [];
  for (const [elementIndex, written] of input.written.elements.entries()) {
    if (written.kind === 'list') return refuse(NESTED_LIST, elementIndex);
    const element = readOne(written, elementIndex);
    if (!element.ok) return element;
    elements.push(element.value);
  }
  return { ok: true, value: elements };
}

/** A written list on a field that is not a list: the field's type takes it through its list cast. */
function readListIntoScalar(input: {
  readonly written: Extract<WrittenValue, { readonly kind: 'list' }>;
  readonly support: DataTypeSupport;
  readonly fieldType: DataTypeId;
  readonly readStored: (
    value: JsonValue,
    elementIndex: number | undefined,
  ) => ReadResult<JsonValue>;
}): ReadResult<JsonValue> {
  const declaration = input.support.lookup.get(input.fieldType);
  const listCast = declaration?.listCast;
  if (listCast === undefined) {
    return refuse(
      {
        kind: 'no-cast',
        fieldType: input.fieldType,
        valueType: 'a list',
        casts: Object.keys(declaration?.casts ?? {}),
      },
      undefined,
    );
  }

  const elements: JsonValue[] = [];
  for (const [elementIndex, written] of input.written.elements.entries()) {
    if (written.kind === 'list') return refuse(NESTED_LIST, elementIndex);
    const read = readValue(input.support, written, elementIndex);
    if (!read.ok) return read;
    if (!listCast.of.includes(read.value.type)) {
      return refuse(
        {
          kind: 'no-cast',
          fieldType: input.fieldType,
          valueType: read.value.type,
          casts: [...listCast.of],
        },
        elementIndex,
      );
    }
    elements.push(read.value.value);
  }

  try {
    return input.readStored(listCast.cast(elements), undefined);
  } catch (error) {
    if (isInternalError(error)) throw error;
    return refuse({ kind: 'unreadable', message: messageOf(error) }, undefined);
  }
}

/** {@link readDataTypeDefault} worded as a PSL diagnostic's code and message. */
export function lowerDataTypeDefault(
  input: Parameters<typeof readDataTypeDefault>[0],
): DefaultDiagnosticResult {
  const read = readDataTypeDefault(input);
  return read.ok ? read : refusalDiagnostic(read.refusal, input.fieldPath);
}

function refusalDiagnostic(
  refusal: DefaultRefusal,
  fieldPath: string,
): Extract<DefaultDiagnosticResult, { readonly ok: false }> {
  const where = `Field "${fieldPath}"${
    refusal.elementIndex === undefined ? '' : ` at element ${refusal.elementIndex + 1}`
  }`;
  switch (refusal.kind) {
    case 'unreadable':
      return { ok: false, code: 'PSL_INVALID_LITERAL', message: `${where}: ${refusal.message}` };
    case 'unknown-tag':
      return {
        ok: false,
        code: 'PSL_UNKNOWN_LITERAL_TAG',
        message: unknownTagMessage(refusal.tag, refusal.known),
      };
    case 'unwritable':
      return {
        ok: false,
        code: 'PSL_VALUE_TYPE_INCOMPATIBLE',
        message: `${where}: this target has no data type for a ${refusal.syntax} value`,
      };
    case 'not-a-list':
      return {
        ok: false,
        code: 'PSL_DEFAULT_LIST_EXPECTED',
        message: `${where}: this field holds a list, so its default is a list literal, as in [1, 2]`,
      };
    case 'no-cast':
      return {
        ok: false,
        code: 'PSL_VALUE_TYPE_INCOMPATIBLE',
        message: `${where}: ${refusal.fieldType} has no cast from ${refusal.valueType}; ${
          refusal.casts.length === 0
            ? 'it casts from nothing'
            : `it casts from ${refusal.casts.join(', ')}`
        }`,
      };
    case 'refused-by-codec':
      return {
        ok: false,
        code: 'PSL_INVALID_DEFAULT_LITERAL',
        message: `${where}: ${refusal.message}`,
      };
  }
}

export function unknownTagMessage(tag: string, known: readonly string[]): string {
  return `Unknown literal tag "${tag}". Known tags: ${known.join(', ')}.`;
}
