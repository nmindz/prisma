import { UNBOUND_NAMESPACE_ID } from '@internal/framework-components/ir';
import { surrealAuthoringFieldPresets, surrealAuthoringTypes } from './authoring';
import { surrealTargetDescriptorMetaRuntime } from './descriptor-meta-runtime';

const surrealTargetDescriptorMetaBase = {
  ...surrealTargetDescriptorMetaRuntime,
  defaultNamespaceId: UNBOUND_NAMESPACE_ID,
  authoring: {
    type: surrealAuthoringTypes,
    field: surrealAuthoringFieldPresets,
  },
} as const;

export const surrealTargetDescriptorMeta = surrealTargetDescriptorMetaBase;
