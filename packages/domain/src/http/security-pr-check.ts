/**
 * Worker-to-Worker only: api hands maple-ai a pull request event, and maple-ai decides whether the
 * org audits that pull request for the `Maple / security` check and starts the run.
 */
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { OrgId } from "@maple/primitives"
import { PullRequestEventJob } from "./vcs"

/** The check's name on GitHub; the one a branch rule requires. */
export const SECURITY_PR_CHECK_NAME = "Maple / security"

export const SecurityPrCheckRequest = Schema.Struct({
	orgId: OrgId,
	job: PullRequestEventJob,
})
export type SecurityPrCheckRequest = typeof SecurityPrCheckRequest.Type

/**
 * `started` ran an audit; `reported` posted a check without one (it could not run, which never
 * blocks the merge); `skipped` posted nothing (no target checks this pull request).
 */
export const SecurityPrCheckOutcome = Schema.Struct({
	outcome: Schema.Literals(["started", "reported", "skipped"]),
	reason: Schema.optionalKey(Schema.String),
})
export type SecurityPrCheckOutcome = typeof SecurityPrCheckOutcome.Type

export class SecurityPrCheckUnauthorizedError extends Schema.TaggedError<SecurityPrCheckUnauthorizedError>()(
	"@maple/http/errors/SecurityPrCheckUnauthorizedError",
	{ message: Schema.String },
	{ httpApiStatus: 401 },
) {}

/** Whether a target checks this pull request could not be read; api retries the delivery. */
export class SecurityPrCheckUnavailableError extends Schema.TaggedError<SecurityPrCheckUnavailableError>()(
	"@maple/http/errors/SecurityPrCheckUnavailableError",
	{ message: Schema.String },
	{ httpApiStatus: 503 },
) {}

export class SecurityPrCheckApiGroup extends HttpApiGroup.make("securityPrCheck")
	.add(
		HttpApiEndpoint.post("pullRequest", "/pull-request", {
			headers: Schema.Struct({ authorization: Schema.String }),
			payload: SecurityPrCheckRequest,
			success: SecurityPrCheckOutcome,
			error: [SecurityPrCheckUnauthorizedError, SecurityPrCheckUnavailableError],
		}),
	)
	.prefix("/internal/security-pr-check") {}
