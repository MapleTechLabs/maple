/**
 * The deploy-time half of connector configuration.
 *
 * Kept in its own module, reached only from the Worker's props, so it is
 * dead-code-eliminated from the deployed bundle: `@maple/infra/env` is the
 * deploy graph, and a module the runtime also imports would drag it — and the
 * `Config` values built at its module scope — into the isolate's startup.
 *
 * The NAMES come from the connectors themselves. This file consumes them as an
 * opaque list, so the only place a vendor-flavoured variable name appears is the
 * connector directory that needs it.
 *
 * Every key is bound as OPTIONAL. A stage with no credentials for a connector
 * must deploy cleanly and run everything else; that connector is skipped.
 */
import { connectors } from "@maple/chat-platform/connectors"
import type { MapleRegion, MapleStage } from "@maple/infra/cloudflare"
import { configKeysEnv, merge, plainWithDefault, selfObservabilityEnv } from "@maple/infra/env"
import * as Secrets from "@maple/infra/secrets"
import { Array as Arr } from "effect"

const ingressConfigKeys = Arr.flatMap(connectors, (connector) => connector.ingress.requiredConfig)

/** The connectors declare their own secret keys; the Worker env audit accepts these beside the catalog. */
export const chatBotConnectorSecretNames: ReadonlyArray<string> = Arr.map(
	Arr.filter(ingressConfigKeys, (key) => key.secret),
	(key) => key.name,
)

/** Config-sourced env. Connector config is optional: a connector without it is skipped. */
export const chatBotConfiguredEnv = (input: {
	readonly stage: MapleStage
	readonly region: MapleRegion
	/** The dashboard origin links point at when `MAPLE_APP_BASE_URL` is unset. */
	readonly webOrigin: string
}) =>
	merge(
		selfObservabilityEnv(input.stage, input.region),
		// Not on previews: no webhook hostname, and a socket would fight dev's bot session.
		...(input.stage.kind === "pr" ? [] : [configKeysEnv(ingressConfigKeys)]),
		// App link base, and the chart-image signing key (without it charts render as text).
		plainWithDefault("MAPLE_APP_BASE_URL", input.webOrigin),
		Secrets.ShareTokenHmacKey.optional,
		// Opens credentials a connector sealed on a workspace row; only those connectors need it.
		Secrets.IngestKeyEncryptionKey.optional,
		Secrets.IngestKeyDecryptionKeys.optional,
	)
