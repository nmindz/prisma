import type { Contract } from '@internal/contract/types';
import type {
  ContractSerializer,
  ControlTargetDescriptor,
  ControlTargetInstance,
} from '@internal/framework-components/control';
import type { SurrealStorageShape } from '@internal/surreal-contract/types';
import type { SurrealSchemaIR } from '@internal/surreal-schema-ir';
import { blindCast } from '@internal/utils/casts';
import { SurrealContractSerializer } from './contract-serializer';
import { contractToSurrealSchemaIR } from './contract-to-schema';
import { surrealTargetDescriptorMeta } from './descriptor-meta';

export interface SurrealControlTargetInstance
  extends ControlTargetInstance<'surreal', 'surrealdb'> {}

/**
 * The SurrealDB control target descriptor.
 *
 * Beyond the framework's `contractSerializer`, it carries `contractToSchema`:
 * the projection from a contract to the shape introspection reports. The
 * family verifier needs that projection but may not import this package —
 * rendering SurrealQL DDL is target-owned — so the target hands it over on
 * the descriptor.
 */
export interface SurrealControlTargetDescriptor<
  TContract extends Contract<SurrealStorageShape> = Contract<SurrealStorageShape>,
> extends ControlTargetDescriptor<'surreal', 'surrealdb', SurrealControlTargetInstance, TContract> {
  readonly contractToSchema: (contract: unknown) => SurrealSchemaIR;
}

const serializer: ContractSerializer<Contract<SurrealStorageShape>> =
  new SurrealContractSerializer();

const surrealControlTargetDescriptor: SurrealControlTargetDescriptor = {
  ...surrealTargetDescriptorMeta,
  contractSerializer: serializer,
  contractToSchema: (contract: unknown): SurrealSchemaIR =>
    contractToSurrealSchemaIR(
      blindCast<
        Contract<SurrealStorageShape>,
        'the control stack passes a contract this target itself deserialized, so its storage block holds the hydrated SurrealDB namespaces; the framework SPI types the argument as unknown'
      >(contract).storage.namespaces,
    ),
  create(): SurrealControlTargetInstance {
    return { familyId: 'surreal', targetId: 'surrealdb' };
  },
};

export default surrealControlTargetDescriptor;
