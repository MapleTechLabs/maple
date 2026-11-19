import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Schema } from "effect"
import {
	FEATURE_REQUEST_NOTE_MAX_LENGTH,
	FEATURE_REQUEST_SUBJECT_MAX_LENGTH,
	FeatureRequestArea,
} from "../feature-requests"
import { AnalystAccess } from "./analyst-access"
import { SessionAuthorization } from "./current-tenant"
import { HttpTaggedError } from "./error-policy"

export {
	FEATURE_REQUEST_NOTE_MAX_LENGTH,
	FEATURE_REQUEST_SUBJECT_MAX_LENGTH,
	FeatureRequestArea,
} from "../feature-requests"

/** Something someone wants Maple to support, as they named it, where they asked, and why. */
export class FeatureRequestPayload extends Schema.Class<FeatureRequestPayload>("FeatureRequestPayload")({
	area: FeatureRequestArea,
	subject: Schema.String.check(
		Schema.isTrimmed(),
		Schema.isMinLength(1),
		Schema.isMaxLength(FEATURE_REQUEST_SUBJECT_MAX_LENGTH),
	),
	note: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(FEATURE_REQUEST_NOTE_MAX_LENGTH))),
}) {}

export class FeatureRequestCreated extends Schema.Class<FeatureRequestCreated>("FeatureRequestCreated")({
	id: Schema.String,
}) {}

export class FeatureRequestPersistenceError extends HttpTaggedError<FeatureRequestPersistenceError>()(
	"@maple/http/feature-requests/FeatureRequestPersistenceError",
	{ message: Schema.String },
	{
		status: 503,
		code: "feature_request_unavailable",
		title: "Requests are temporarily unavailable",
		message: "The request could not be sent right now. Try again in a few seconds.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}

/**
 * Asks Maple to support something it does not yet: a cost provider, an integration. Any member may
 * ask, analysts included: a request is the caller's own and changes nothing in the org.
 */
export class FeatureRequestApiGroup extends HttpApiGroup.make("featureRequests")
	.add(
		HttpApiEndpoint.post("create", "/", {
			payload: FeatureRequestPayload,
			success: FeatureRequestCreated,
			error: [FeatureRequestPersistenceError],
		}),
	)
	.prefix("/internal/feature-requests")
	.annotate(AnalystAccess, "personal")
	.middleware(SessionAuthorization) {}
