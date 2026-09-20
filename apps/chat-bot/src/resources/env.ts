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
import { merge, optionalPlain, optionalSecret } from "@maple/infra/env"

export const connectorConfigEnv = merge(
	...connectors.flatMap((connector) =>
		connector.ingress.requiredConfig.map((key) =>
			key.secret ? optionalSecret(key.name) : optionalPlain(key.name),
		),
	),
)
