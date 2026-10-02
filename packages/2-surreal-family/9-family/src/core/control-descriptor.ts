import type { AuthoringAttributeSpecContributions } from '@internal/framework-components/authoring';
import type { DataType } from '@internal/framework-components/codec';
import type { ControlFamilyDescriptor, ControlStack } from '@internal/framework-components/control';
import {
  SURREAL_EXPRESSION_DATA_TYPE_ID,
  surrealExpressionAuthoringEntry,
  surrealExpressionDataType,
} from '@internal/surreal-contract';
import { surrealAttributeSpecs } from '@internal/surreal-contract-psl';
import { surrealEmission } from '@internal/surreal-emitter';
import { createSurrealFamilyInstance, type SurrealControlFamilyInstance } from './control-instance';

const surrealFamilyAttributeSpecs: AuthoringAttributeSpecContributions = surrealAttributeSpecs;

/**
 * Registers the SurrealDB family with the framework's control stack.
 *
 * This is what makes the CLI able to reach SurrealDB: `emission` supplies the
 * `contract.d.ts` surface, and `create(stack)` yields the instance the
 * `db init`, `db verify` and migration commands drive. It also owns
 * `surreal/expression` and its `surql` tag, the one data type that is the
 * same on every SurrealDB target (ADR 254).
 */
class SurrealFamilyDescriptor
  implements ControlFamilyDescriptor<'surreal', SurrealControlFamilyInstance>
{
  readonly kind = 'family' as const;
  readonly id = 'surreal';
  readonly familyId = 'surreal' as const;
  readonly version = '0.0.1';
  readonly emission = surrealEmission;
  readonly dataTypes: readonly DataType[] = [surrealExpressionDataType];
  readonly authoring = {
    attributeSpecs: surrealFamilyAttributeSpecs,
    dataTypes: { [SURREAL_EXPRESSION_DATA_TYPE_ID]: surrealExpressionAuthoringEntry },
  } as const;

  create<TTargetId extends string>(
    stack: ControlStack<'surreal', TTargetId>,
  ): SurrealControlFamilyInstance {
    return createSurrealFamilyInstance(stack);
  }
}

export const surrealFamilyDescriptor: ControlFamilyDescriptor<
  'surreal',
  SurrealControlFamilyInstance
> = new SurrealFamilyDescriptor();
