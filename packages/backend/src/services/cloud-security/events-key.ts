import { createHmac } from "node:crypto"
import type { AwsConnectionId } from "@maple/primitives"

/** The header the setup's EventBridge connection sends the key in. */
export const AWS_EVENTS_KEY_HEADER = "x-maple-events-key"

/**
 * The key a connection's EventBridge API destination sends with each finding event. Derived from
 * the connection id with the lookup HMAC key, so nothing is stored: deleting the connection is what
 * revokes it.
 */
export const awsEventsKey = (hmacKey: string, connectionId: AwsConnectionId): string =>
	`maple_awsev_${createHmac("sha256", hmacKey).update(`aws-security-events/v1:${connectionId}`, "utf8").digest("base64url")}`

/** Where a connection's API destination posts, under the API's base URL. */
export const awsEventsPath = (connectionId: AwsConnectionId): string =>
	`/api/integrations/aws/events/${connectionId}`
