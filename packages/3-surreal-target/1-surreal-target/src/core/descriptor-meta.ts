import { UNBOUND_NAMESPACE_ID } from '@internal/framework-components/ir';
import { surrealAuthoringFieldPresets, surrealAuthoringTypes } from './authoring';
import { surrealCodecDescriptors } from './codecs';
import { surrealDataTypeEntries } from './data-type-entries';
import { surrealDataTypes } from './data-types';
import { surrealTargetDescriptorMetaRuntime } from './descriptor-meta-runtime';

// Data types and codec descriptors ride on the pack, not the runtime slice:
// the control stack's assembly checks are what read them.
const surrealTargetDescriptorMetaBase = {
  ...surrealTargetDescriptorMetaRuntime,
  defaultNamespaceId: UNBOUND_NAMESPACE_ID,
  dataTypes: surrealDataTypes,
  types: {
    codecTypes: {
      codecDescriptors: surrealCodecDescriptors,
    },
  },
  authoring: {
    type: surrealAuthoringTypes,
    field: surrealAuthoringFieldPresets,
    dataTypes: surrealDataTypeEntries,
  },
} as const;

export const surrealTargetDescriptorMeta = surrealTargetDescriptorMetaBase;
