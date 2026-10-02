export type { ClassifiedFailure } from '../classify';
export { classifySurrealFailure } from '../classify';
export type { SurrealDriverError, SurrealFailureClass } from '../errors';
export {
  isTableNotFound,
  isUniqueConstraintViolation,
  SurrealConnectionError,
  SurrealQueryError,
} from '../errors';
