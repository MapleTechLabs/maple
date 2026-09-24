import type { HttpClient } from "effect/unstable/http"
import type { ChatConnector } from "../../connector"
import type { ConnectorCredentials } from "../../outbound"
import { SLACK_CONNECTOR_ID } from "./id"
import { slackInstall } from "./install"
import { slackManifest } from "./manifest"
import { slackOutbound } from "./outbound"
import { slackIngress } from "./webhook"

/**
 * Slack, every half: how it is installed, how its events arrive, how a turn is carried back.
 *
 * Its events arrive as signed HTTP requests rather than over a socket, so `ingress` is the webhook
 * kind and the host needs no connection, no Durable Object and no cron for it — one route, and the
 * connector verifies its own caller. `install` is driven by a different Worker; see `README.md` in
 * this directory for the one application setup all of them depend on.
 */
export const slack: ChatConnector<HttpClient.HttpClient | ConnectorCredentials> = {
	id: SLACK_CONNECTOR_ID,
	manifest: slackManifest,
	install: slackInstall,
	outbound: slackOutbound,
	ingress: slackIngress,
}
