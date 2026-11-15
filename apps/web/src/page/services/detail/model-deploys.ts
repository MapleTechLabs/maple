import { Schema } from "effect"

// A service's deploys with their before and after, read by the page and its deploy drawer.

/** `DeployVerificationRow`: a deploy's first minutes against the minutes before it. */
export const DeployRow = Schema.Struct({
	serviceName: Schema.String,
	environment: Schema.String,
	commitSha: Schema.String,
	firstSeen: Schema.String,
	afterSpans: Schema.Number,
	afterErrors: Schema.Number,
	afterP95Ms: Schema.Number,
	beforeSpans: Schema.Number,
	beforeErrors: Schema.Number,
	beforeP95Ms: Schema.Number,
})
export type DeployRow = typeof DeployRow.Type

export const ServiceDeploys = Schema.Struct({
	deploys: Schema.Array(DeployRow),
	verifyWindowSeconds: Schema.Number,
	/** The window end this answer was read up to: a refresh in flight must not age its verdicts. */
	readUntil: Schema.String,
})
export type ServiceDeploys = typeof ServiceDeploys.Type
