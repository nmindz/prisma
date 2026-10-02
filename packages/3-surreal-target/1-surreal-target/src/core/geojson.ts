/**
 * The GeoJSON geometries SurrealDB reads as a geometry rather than an object: RFC 7946 types, 2D
 * positions, no other members. Rings must be closed, since SurrealDB would close an open one.
 */

import type { JsonValue } from '@internal/contract/types';
import { isJsonArray, isJsonObject } from './json-document';

/** What is wrong with a value, or `undefined` when nothing is. */
type Check = (value: JsonValue) => string | undefined;

const position: Check = (value) =>
  isJsonArray(value) &&
  value.length === 2 &&
  value.every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate))
    ? undefined
    : `${JSON.stringify(value)} is not a position, two finite numbers`;

function listOf(element: Check, minimum: number, what: string): Check {
  return (value) => {
    if (!isJsonArray(value) || value.length < minimum) {
      return `${JSON.stringify(value)} is not ${what}`;
    }
    for (const member of value) {
      const problem = element(member);
      if (problem !== undefined) return problem;
    }
    return undefined;
  };
}

const lineString = listOf(position, 2, 'a line, at least two positions');

const linearRing: Check = (value) => {
  const problem = listOf(position, 4, 'a polygon ring, at least four positions')(value);
  if (problem !== undefined || !isJsonArray(value)) return problem;
  return JSON.stringify(value[0]) === JSON.stringify(value[value.length - 1])
    ? undefined
    : `${JSON.stringify(value)} is a polygon ring that does not end where it starts`;
};

const polygon = listOf(linearRing, 1, 'a polygon, at least one ring');

const COORDINATES: Readonly<Record<string, Check>> = {
  Point: position,
  MultiPoint: listOf(position, 0, 'a list of positions'),
  LineString: lineString,
  MultiLineString: listOf(lineString, 0, 'a list of lines'),
  Polygon: polygon,
  MultiPolygon: listOf(polygon, 0, 'a list of polygons'),
};

const GEOMETRY_TYPES = [...Object.keys(COORDINATES), 'GeometryCollection'].join(', ');

function hasExactly(
  value: { readonly [key: string]: JsonValue },
  keys: readonly string[],
): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}

/** What keeps `value` from being a GeoJSON geometry SurrealDB holds, or `undefined` when nothing does. */
export function geometryProblem(value: JsonValue): string | undefined {
  if (!isJsonObject(value)) return `${JSON.stringify(value)} is not an object`;
  const { type } = value;
  if (type === 'GeometryCollection') {
    const { geometries } = value;
    if (!hasExactly(value, ['type', 'geometries']) || geometries === undefined) {
      return 'a GeometryCollection has exactly the members type and geometries';
    }
    return listOf(geometryProblem, 0, 'a list of geometries')(geometries);
  }
  const check = typeof type === 'string' ? COORDINATES[type] : undefined;
  if (check === undefined) {
    return `its type is ${JSON.stringify(type)}, and a geometry's type is one of ${GEOMETRY_TYPES}`;
  }
  const { coordinates } = value;
  if (!hasExactly(value, ['type', 'coordinates']) || coordinates === undefined) {
    return `a ${String(type)} has exactly the members type and coordinates`;
  }
  return check(coordinates);
}
