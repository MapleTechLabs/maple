import type { GcpConnectorId } from "./primitives"

/**
 * Names of the resources a connector's setup script creates in the customer's Google Cloud
 * project. Derived from the connector id alone, so nothing extra is stored and the names cannot
 * be chosen by a caller: the metrics reader of one connector is never the account another
 * organization's connector impersonates.
 *
 * 24 hex characters of the id keep the service account id at Google's 30-character limit.
 */
export const gcpConnectorResourceNames = (connectorId: GcpConnectorId) => {
	const name = `maple-${connectorId.replaceAll("-", "").slice(0, 24)}`
	return { serviceAccountId: name, topic: name, subscription: name, sink: name }
}
