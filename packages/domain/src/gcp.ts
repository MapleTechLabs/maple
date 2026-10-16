import type { GcpConnectorId } from "./primitives"

/**
 * Names of what a connector's setup script creates in the customer's Google Cloud project.
 * Derived from the connector id alone, so a caller can never pick them: one connector's metrics
 * account is not the one another organization's connector impersonates. 24 hex characters keep
 * the service account id at Google's 30-character limit.
 */
export const gcpConnectorResourceNames = (connectorId: GcpConnectorId) => {
	const name = `maple-${connectorId.replaceAll("-", "").slice(0, 24)}`
	return { serviceAccountId: name, topic: name, subscription: name, sink: name }
}
