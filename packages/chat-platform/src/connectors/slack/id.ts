import { chatConnectorId } from "../../connector"

/**
 * Its own module so each half can name the connector without importing the structure that is
 * assembled from all of them.
 */
export const SLACK_CONNECTOR_ID = chatConnectorId("slack")
