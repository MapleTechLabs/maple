import type { GcpConnectorRow } from "@maple/db/tables"
import type { GcpApiError } from "./api"

export const RETRIES = "Maple retries in 5 minutes."

type ExplainedConnector = Pick<
	GcpConnectorRow,
	"scopeType" | "scopeId" | "projectId" | "lastMetricsReceivedAt"
>

/** Whose call failed: the poller's, or a live query's that a person is waiting on and nothing retries. */
export type GcpCaller = "poll" | "live"

/** Why a failed call failed and what to do about it, in the customer's terms. */
const explainGcpApiError = (error: GcpApiError, connector: ExplainedConnector, caller: GcpCaller) => {
	// The host project is the one Google checks for billing, enabled APIs and quota. A project
	// scope is its own host, and reads as "the project".
	const host = `${connector.scopeType === "project" ? "project" : "host project"} ${connector.projectId}`
	const scope = `${connector.scopeType} ${connector.scopeId}`
	const live = caller === "live"
	const retries = live ? "Try again in a few minutes." : RETRIES
	if (error.reason === "BILLING_DISABLED") {
		return `The ${host} has no active billing account, and ${error.api} only answers for projects that have one. Link one: https://console.cloud.google.com/billing/linkedaccount?project=${connector.projectId}${live ? "" : " Maple retries every 5 minutes."}`
	}
	// A PromQL query that ran out of samples or time; Google's text, in the status, says which.
	if (error.reason === "QUERY_EXECUTION") {
		return "Google could not finish the query on this project. Narrow the query or widen the step."
	}
	if (error.reason === "SERVICE_DISABLED") {
		return `The ${error.api} API is switched off in the ${host}. Switch it on in the console, or run the setup script again.`
	}
	if (error.kind === "denied" || error.kind === "not_found") {
		if (error.api === "IAM Credentials") {
			if (live) {
				return "Maple can't sign in as this connection's read-only service account, which live queries read with. Google needs a few minutes to accept a new grant. If this stays, the account does not exist, or the grant to Maple is missing or blocked by an organization policy: finish the read-only account steps of a manual setup, or run the setup script again."
			}
			// A connection that has been read before lost its account or its grant.
			if (connector.lastMetricsReceivedAt !== null) {
				return "Maple can no longer sign in as this connection's read-only service account. The account was deleted, or the grant to Maple was removed or is blocked by an organization policy. Run the setup script again or redo the read-only steps: either restores both."
			}
			// Shown both before any setup and for the minutes after one in which Google does not
			// accept the new grant yet, so it has to read right in both.
			return "Maple can't sign in as this connection's read-only service account yet. Google needs a few minutes to accept a new grant, and Maple retries every 5 minutes. If this stays, the account does not exist, or the grant to Maple is missing or blocked by an organization policy: finish the read-only account steps of a manual setup, or run the setup script again."
		}
		return error.api === "Cloud Asset Inventory"
			? `Google denied the resource listing for ${scope}. Cloud Asset Viewer is missing. Grant it with the setup script, the console steps or your Terraform.`
			: `Google denied Maple's read of ${scope}: the read-only roles are missing. Grant them with the setup script, the console steps or your Terraform. A new grant can take a few minutes.`
	}
	// Signing in is counted against Maple's own project, not the host project.
	if (error.kind === "rate_limited" && error.api !== "IAM Credentials") {
		// Google answers a query past its size limit the same way as a spent quota.
		if (live) {
			return `Google refused the read for the ${host}: a rate limit, or an answer past Google's size limit. Narrow the query, or try again in a few minutes.`
		}
		return `Google rate-limited the ${error.api} API for the ${host}. ${RETRIES} If this repeats, raise that API's quota on the project.`
	}
	return `Maple's request to Google's ${error.api} API failed. ${retries} If this repeats, write to support@maple.dev.`
}

/**
 * What the customer sees for a failed call: one sentence of cause, one of what to do, and
 * Google's status at the end.
 */
export const describeGcpApiError = (error: GcpApiError, connector: ExplainedConnector, caller: GcpCaller) =>
	`${explainGcpApiError(error, connector, caller)} (${error.message})`
