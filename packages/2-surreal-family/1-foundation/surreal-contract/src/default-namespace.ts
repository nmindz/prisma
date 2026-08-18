import { UNBOUND_DOMAIN_NAMESPACE_ID } from '@internal/contract/default-namespace';
import { UNBOUND_NAMESPACE_ID } from '@internal/framework-components/ir';

/** Default storage namespace for SurrealDB-family contracts at runtime. */
export const defaultSurrealStorageNamespaceId = UNBOUND_NAMESPACE_ID;

/** Default domain namespace for SurrealDB-family contracts at runtime. */
export const defaultSurrealDomainNamespaceId = UNBOUND_DOMAIN_NAMESPACE_ID;
