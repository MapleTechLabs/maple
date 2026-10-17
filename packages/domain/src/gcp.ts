import type { GcpConnectorId } from "./primitives"

/**
 * Names of what a connector's setup creates in the customer's Google Cloud project.
 * Derived from the connector id alone, so a caller can never pick them: one connector's metrics
 * account is not the one another organization's connector impersonates. 24 hex characters keep
 * the service account id at Google's 30-character limit.
 */
export const gcpConnectorResourceNames = (connectorId: GcpConnectorId) => {
	const hex = connectorId.replaceAll("-", "")
	const name = `maple-${hex.slice(0, 24)}`
	return {
		serviceAccountId: name,
		topic: name,
		subscription: name,
		sink: name,
		// The identity a console or infrastructure-as-code push subscription signs its requests as.
		// It holds no role. The ingest gateway accepts a push only with this account's email in the
		// connector's host project and an audience naming the connector in full, so the shorter
		// suffix is enough.
		pushServiceAccountId: `maple-push-${hex.slice(0, 19)}`,
	}
}
