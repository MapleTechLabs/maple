import { Array as Arr, Config, Option, Redacted } from "effect"
import { connectors } from "./connectors/index"
import type { ConnectorConfig, ConnectorConfigKey } from "./ingress"
import type { ChatConnectorConfig } from "./install"

/**
 * Resolving every registered connector's declared INSTALL config in one place,
 * so the hosts (the API worker's env catalog, the deploy-time binding list) name
 * no connector and stay correct when one is added.
 *
 * The ingress half's config is deliberately not here: it is resolved by
 * `apps/chat-bot`, which is a different deployable. The OUTBOUND half's is, for
 * the hosts that post without receiving anything — alert delivery, and the
 * channel listing behind its picker.
 *
 * Absent names are simply left out of the map: a deployment that has not set a
 * connector's secrets reports that connector as unavailable rather than failing
 * to boot.
 */

/** Every install config key the registered connectors declare, de-duplicated by name. */
export const chatConnectorConfigKeys: ReadonlyArray<ConnectorConfigKey> = Arr.dedupeWith(
	connectors.flatMap((connector) => connector.install.requiredConfig),
	(left, right) => left.name === right.name,
)

export const chatConnectorConfigNames: ReadonlyArray<string> = chatConnectorConfigKeys.map((key) => key.name)

export const chatConnectorConfig: Config.Config<ChatConnectorConfig> = Config.all(
	chatConnectorConfigNames.map((name) =>
		Config.option(Config.String(name)).pipe(
			Config.map((value) =>
				Option.flatMap(value, (raw) =>
					raw.trim().length > 0
						? Option.some([name, Redacted.make(raw.trim())] as const)
						: Option.none(),
				),
			),
		),
	),
).pipe(Config.map((entries) => new Map(Arr.getSomes(entries))))

/** Every OUTBOUND config key the registered connectors declare, de-duplicated by name. */
export const chatConnectorOutboundConfigKeys: ReadonlyArray<ConnectorConfigKey> = Arr.dedupeWith(
	connectors.flatMap((connector) => connector.outbound.requiredConfig),
	(left, right) => left.name === right.name,
)

/**
 * The outbound keys resolved into the plain map a transport reads from `ConnectorCredentials`.
 *
 * Plain rather than `Redacted`, because that is what the transport contract takes; the map
 * never leaves the host that hands it to a connector.
 */
export const chatConnectorOutboundConfig: Config.Config<ConnectorConfig> = Config.all(
	chatConnectorOutboundConfigKeys.map((key) =>
		Config.option(Config.String(key.name)).pipe(
			Config.map((value) =>
				Option.flatMap(value, (raw) =>
					raw.trim().length > 0 ? Option.some([key.name, raw.trim()] as const) : Option.none(),
				),
			),
		),
	),
).pipe(Config.map((entries) => new Map(Arr.getSomes(entries))))
