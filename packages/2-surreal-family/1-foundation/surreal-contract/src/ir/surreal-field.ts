import { freezeNode, IRNodeBase } from '@internal/framework-components/ir';
import type { SurrealFieldType, SurrealPermissions, SurrealReferenceAction } from '../field-types';

/**
 * Construction input for {@link SurrealField}, mirroring the on-disk storage
 * JSON exactly so the family serializer can hand an arktype-validated literal
 * straight to `new`.
 */
export interface SurrealFieldInput {
  /**
   * The field's path on the record. SurrealDB addresses nested structure with
   * dots and array contents with `[*]`, so `meta.author` and `tags[*]` are
   * both legal field names and each gets its own `DEFINE FIELD`.
   */
  readonly name: string;
  readonly type: SurrealFieldType;
  /** Which codec encodes and decodes this field's values across the wire. */
  readonly codecId: string;
  /** `FLEXIBLE` — lets an `object` field hold keys the schema does not name. */
  readonly flexible?: boolean;
  /** `READONLY` — SurrealDB rejects an update that changes the field. */
  readonly readOnly?: boolean;
  /** `DEFAULT <expr>`, held as SurrealQL source. */
  readonly defaultExpression?: string;
  /** `DEFAULT ALWAYS <expr>` rather than default-on-create-only. */
  readonly defaultAlways?: boolean;
  /** `VALUE <expr>` — recomputed on every write. */
  readonly valueExpression?: string;
  /** `ASSERT <expr>` — a write that fails the predicate is rejected. */
  readonly assertExpression?: string;
  /** `REFERENCE ON DELETE …`, valid only on a `record<>` field. */
  readonly reference?: SurrealReferenceAction;
  readonly permissions?: SurrealPermissions;
  readonly comment?: string;
}

/**
 * Contract IR node for one `DEFINE FIELD` on a table.
 *
 * A SurrealDB field is richer than a relational column: it can compute itself
 * (`VALUE`), guard itself (`ASSERT`), carry its own permissions, and — when
 * its type is `record<…>` — be the link that another table is reached
 * through. All of that is declaration, not data, so it lives in the contract.
 */
export class SurrealField extends IRNodeBase {
  readonly kind = 'surreal-field' as const;
  readonly name: string;
  readonly type: SurrealFieldType;
  readonly codecId: string;
  declare readonly flexible?: boolean;
  declare readonly readOnly?: boolean;
  declare readonly defaultExpression?: string;
  declare readonly defaultAlways?: boolean;
  declare readonly valueExpression?: string;
  declare readonly assertExpression?: string;
  declare readonly reference?: SurrealReferenceAction;
  declare readonly permissions?: SurrealPermissions;
  declare readonly comment?: string;

  constructor(input: SurrealFieldInput) {
    super();
    this.name = input.name;
    this.type = input.type;
    this.codecId = input.codecId;
    if (input.flexible !== undefined) this.flexible = input.flexible;
    if (input.readOnly !== undefined) this.readOnly = input.readOnly;
    if (input.defaultExpression !== undefined) this.defaultExpression = input.defaultExpression;
    if (input.defaultAlways !== undefined) this.defaultAlways = input.defaultAlways;
    if (input.valueExpression !== undefined) this.valueExpression = input.valueExpression;
    if (input.assertExpression !== undefined) this.assertExpression = input.assertExpression;
    if (input.reference !== undefined) this.reference = input.reference;
    if (input.permissions !== undefined) this.permissions = input.permissions;
    if (input.comment !== undefined) this.comment = input.comment;
    freezeNode(this);
  }

  /** True when the declared type is `option<…>`, i.e. the field may be absent. */
  get optional(): boolean {
    return this.type.kind === 'option';
  }
}
