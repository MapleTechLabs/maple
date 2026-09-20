import { chatConnectorId } from "../../connector"

/**
 * Its own module so the outbound half can name the connector without importing the structure that
 * is assembled from it.
 */
export const DISCORD_CONNECTOR_ID = chatConnectorId("discord")
