import type { GcpConnectorRow } from "@maple/db/tables"
import type { GcpApiError } from "./api"

export const RETRIES = "Maple retries in 5 minutes."

type ExplainedConnector = Pick<
	GcpConnectorRow,
	"scopeType" | "scopeId" | "projectId" | "lastMetricsReceivedAt"
>

/**
 * Why a failed call failed and what to do about it, in the customer's terms. `live` is a query a
 * person is waiting on, which nothing retries; otherwise it is the poller's.
 */
const explainGcpApiError = (error: GcpApiError, connector: ExplainedConnector, live = false) => {
	// The host project is the one Google checks for billing, enabled APIs and quota. A project
	// scope is its own host, and reads as "the project".
	const host = `${connector.scopeType === "project" ? "project" : "host project"} ${connector.projectId}`
	const scope = `${connector.scopeType} ${connector.scopeId}`
	const retries = live ? "Try again in a few minutes." : RETRIES
	if (error.reason === "BILLING_DISABLED") {
		return `The ${host} has no active billing account, and ${error.api} only answers for projects that have one. Link one: https://console.cloud.google.com/billing/linkedaccount?project=${connector.projectId}${live ? "" : " Maple retries every 5 minutes."}`
	}
	if (error.reason === "SERVICE_DISABLED") {
		return `The ${error.api} API is switched off in the ${host}. Run the setup script again: it switches the API on.`
	}
	if (error.kind === "denied" || error.kind === "not_found") {
		if (error.api === "IAM Credentials") {
			if (live) {
				return "Maple can't sign in as this connection's read-only service account, which live queries read with. Run the setup script again: it creates the account and the grant to Maple. A new grant can take a few minutes."
			}
			// A connection that has been read before lost its account or its grant.
			if (connector.lastMetricsReceivedAt !== null) {
				return "Maple can no longer sign in as this connection's read-only service account. The account was deleted, or the grant to Maple was removed or is blocked by an organization policy. Run the setup script again: it restores both, or says what blocks it."
			}
			// Shown both before the script ever ran and for the minute or two after a run in
			// which Google does not accept the new grant yet, so it has to read right in both.
			return "Maple can't sign in as this connection's read-only service account yet. After a setup run Google needs a few minutes to accept the new grant, and Maple retries every 5 minutes. If this stays, the account does not exist, or the grant to Maple is missing or blocked by an organization policy: run the setup script and read its last lines."
		}
		return error.api === "Cloud Asset Inventory"
			? `Google denied the resource listing for ${scope}. Run the setup script again: it grants Cloud Asset Viewer.`
			: `Google denied Maple's read of ${scope}: the read-only roles are missing. Run the setup script again: it grants them. A new grant can take a few minutes.`
	}
	// Signing in is counted against Maple's own project, not the host project.
	if (error.kind === "rate_limited" && error.api !== "IAM Credentials") {
		return `Google rate-limited the ${error.api} API for the ${host}. ${retries} If this repeats, raise that API's quota on the project.`
	}
	return `Maple's request to Google's ${error.api} API failed. ${retries} If this repeats, write to support@maple.dev.`
}

/**
 * What the customer sees for a failed call: one sentence of cause, one of what to do, and
 * Google's status at the end.
 */
export const describeGcpApiError = (error: GcpApiError, connector: ExplainedConnector, live = false) =>
	`${explainGcpApiError(error, connector, live)} (${error.message})`
