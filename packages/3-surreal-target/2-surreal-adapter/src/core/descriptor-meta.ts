export const surrealAdapterDescriptorMeta = {
  kind: 'adapter',
  familyId: 'surreal',
  targetId: 'surrealdb',
  id: 'surrealdb',
  version: '0.0.1',
  capabilities: {
    surrealdb: {
      createReturnsRecord: true,
      upsertByRecordId: true,
      referenceOnDelete: true,
      graphEdges: true,
      sequences: true,
    },
    surreal: {
      upsertByUniqueIndex: true,
    },
  },
} as const;
