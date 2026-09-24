import { AlertPersistenceError } from "@maple/domain/http"
import { makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"

/** Shared `unknown -> AlertPersistenceError` mapper for every alerts service. */
export const makePersistenceError = makePersistenceErrorMapper(
	AlertPersistenceError,
	"Alert persistence failed",
)
