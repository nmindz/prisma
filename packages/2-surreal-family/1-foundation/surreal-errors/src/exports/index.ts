export type { ClassifiedFailure } from '../classify';
export { classifySurrealFailure } from '../classify';
export type { SurrealDriverError, SurrealFailureClass } from '../errors';
export {
  isUniqueConstraintViolation,
  SurrealConnectionError,
  SurrealQueryError,
} from '../errors';
