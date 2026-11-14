import { SloPersistenceError } from "@maple/domain/http"
import { makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"

/** Shared `unknown -> SloPersistenceError` mapper for the SLO services. */
export const makeSloPersistenceError = makePersistenceErrorMapper(
	SloPersistenceError,
	"SLO persistence failed",
)
