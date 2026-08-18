import type { ControlFamilyDescriptor, ControlStack } from '@internal/framework-components/control';
import { surrealEmission } from '@internal/surreal-emitter';
import { createSurrealFamilyInstance, type SurrealControlFamilyInstance } from './control-instance';

/**
 * Registers the SurrealDB family with the framework's control stack.
 *
 * This is what makes the CLI able to reach SurrealDB: `emission` supplies the
 * `contract.d.ts` surface, and `create(stack)` yields the instance the
 * `db init`, `db verify` and migration commands drive.
 */
class SurrealFamilyDescriptor
  implements ControlFamilyDescriptor<'surreal', SurrealControlFamilyInstance>
{
  readonly kind = 'family' as const;
  readonly id = 'surreal';
  readonly familyId = 'surreal' as const;
  readonly version = '0.0.1';
  readonly emission = surrealEmission;

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
