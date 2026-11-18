import { createHmac, randomBytes } from "node:crypto"
import type { AwsConnectionId } from "@maple/primitives"

/** The header the setup's EventBridge connection sends the key in. */
export const AWS_EVENTS_KEY_HEADER = "x-maple-events-key"

/** A new salt for a connection's events key: storing it is what replaces the key. */
export const mintAwsEventsKeySalt = (): string => randomBytes(24).toString("base64url")

/**
 * The key a connection's EventBridge API destination sends with each finding event. Derived with
 * the lookup HMAC key from the connection id and the connection's salt, so only the salt is stored
 * and a new salt is a new key. A null salt is a connection made before salts: its id alone.
 */
export const awsEventsKey = (hmacKey: string, connectionId: AwsConnectionId, salt: string | null): string => {
	const message =
		salt === null
			? `aws-security-events/v1:${connectionId}`
			: `aws-security-events/v2:${connectionId}:${salt}`
	return `maple_awsev_${createHmac("sha256", hmacKey).update(message, "utf8").digest("base64url")}`
}

/** Where a connection's API destination posts, under the API's base URL. */
export const awsEventsPath = (connectionId: AwsConnectionId): string =>
	`/api/integrations/aws/events/${connectionId}`
