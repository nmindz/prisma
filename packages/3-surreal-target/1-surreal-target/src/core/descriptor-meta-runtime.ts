// Runtime-safe slice of the SurrealDB target descriptor metadata.
//
// Separate from ./descriptor-meta on purpose: the runtime plane reads only
// kind/familyId/targetId/id/version/capabilities. The `authoring` slot lives
// on the pack descriptor alone, because authoring contributions are consumed
// at contract-construction time, never at runtime. Keeping the runtime
// closure free of the authoring import is what lets the bundler drop the
// control-plane chunk from the runtime entry.

const surrealTargetDescriptorMetaRuntimeBase = {
  kind: 'target',
  familyId: 'surreal',
  targetId: 'surrealdb',
  id: 'surrealdb',
  version: '0.0.1',
  capabilities: {
    surreal: {
      /** `RELATE` and `->edge->` traversal. */
      graph: true,
      /** HNSW and M-Tree indexes, and the `<|k,…|>` operator. */
      vectorSearch: true,
      /** BM25 `SEARCH` indexes over a `DEFINE ANALYZER`. */
      fullTextSearch: true,
      /** `record<…>` fields and `FETCH`. */
      recordLinks: true,
      /** Interactive transactions, over the websocket RPC only. */
      transactions: true,
      /** SurrealQL has no join; relationships are links or edges. */
      joins: false,
    },
  },
} as const;

export const surrealTargetDescriptorMetaRuntime = surrealTargetDescriptorMetaRuntimeBase;
