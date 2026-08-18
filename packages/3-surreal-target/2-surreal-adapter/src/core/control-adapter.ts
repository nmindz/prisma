import type {
  ControlAdapterDescriptor,
  ControlAdapterInstance,
} from '@internal/framework-components/control';
import { surrealAdapterDescriptorMeta } from './descriptor-meta';

export interface SurrealControlAdapterInstance
  extends ControlAdapterInstance<'surreal', 'surrealdb'> {}

/**
 * The control-plane adapter.
 *
 * SurrealDB's control plane needs no dialect lowering of its own: DDL is
 * rendered by the target from contract IR, and the control driver sends it
 * verbatim. The descriptor exists so a control stack can be assembled at all —
 * the framework requires one per target — and it carries no behaviour rather
 * than pretending to.
 */
const surrealControlAdapterDescriptor: ControlAdapterDescriptor<
  'surreal',
  'surrealdb',
  SurrealControlAdapterInstance
> = {
  ...surrealAdapterDescriptorMeta,
  create(): SurrealControlAdapterInstance {
    return { familyId: 'surreal', targetId: 'surrealdb' };
  },
};

export default surrealControlAdapterDescriptor;
