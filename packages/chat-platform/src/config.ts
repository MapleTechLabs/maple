import { Array as Arr, Config, Option, Redacted } from "effect"
import { connectors } from "./connectors/index"
import type { ChatConnectorConfig } from "./install"

/**
 * Resolving every registered connector's declared config in one place, so the
 * hosts (the API worker's env catalog, the deploy-time binding list) name no
 * connector and stay correct when one is added.
 *
 * Absent names are simply left out of the map: a deployment that has not set a
 * connector's secrets reports that connector as unavailable rather than failing
 * to boot.
 */

/** Every config name the registered connectors declare, de-duplicated. */
export const chatConnectorConfigNames: ReadonlyArray<string> = Arr.dedupe(
	connectors.flatMap((connector) => connector.install.requiredConfig),
)

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
