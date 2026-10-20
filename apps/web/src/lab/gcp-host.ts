import { OrgId } from "@maple/domain"
import { V2GcpConnector } from "@maple/domain/http/v2"
import { GcpConnectorId } from "@maple/domain/primitives"
import { Clock, Effect, Schema } from "effect"
import { AsyncData, type Command } from "foldkit"
import type { PageContext } from "../page/contract"
import type { Message as IntegrationsMessage } from "../page/integrations/message"
import type { Model as IntegrationsModel } from "../page/integrations/model"
import * as Integrations from "../page/integrations/update"
import type { Resources } from "../platform/resources"

// The integrations page's Model and update, hosted by the Google Cloud labs
// (connections, connect) over fixture connectors.

/** The labs run against a fixture org: the page's status reads are never sent. */
export const LAB_CONTEXT: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_lab_gcp"),
	pinnedNamespace: null,
	timeZone: "UTC",
}

/** The lab's clock (read once at boot) and the browser's zone. */
export const GcpLabFlags = Schema.Struct({ nowMs: Schema.Number, timeZone: Schema.String })
export type GcpLabFlags = typeof GcpLabFlags.Type

export const gcpLabFlags: Effect.Effect<GcpLabFlags> = Effect.all({
	nowMs: Clock.currentTimeMillis,
	timeZone: Effect.sync(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
})

const decodeConnector = Schema.decodeUnknownSync(V2GcpConnector)

/** `connector(over)`: the lab's base connector with its fields replaced, as the wire encodes them. */
export const connectorOf = (
	base: Readonly<Record<string, unknown>>,
	over: Readonly<Record<string, unknown>> = {},
): V2GcpConnector => decodeConnector({ ...base, ...over })

/** The fixture cards share one id; each needs its own, as menus and dialogs are keyed by it. */
export const withIndexId = (connector: V2GcpConnector, index: number): V2GcpConnector => ({
	...connector,
	id: Schema.decodeSync(GcpConnectorId)(
		`018f2b3c-4d5e-4f70-8192-a3b4c5d6e7${String(index).padStart(2, "0")}`,
	),
})

/** `ago(minutes)` against the lab clock, as an ISO string. */
export const agoOf =
	(nowMs: number) =>
	(minutes: number): string =>
		new Date(nowMs - minutes * 60_000).toISOString()

/** The page's Model with the Google Cloud status loaded, never requested. */
export const hubOf = (nowMs: number, connectors: ReadonlyArray<V2GcpConnector>): IntegrationsModel => {
	const hub = Integrations.init({ search: {} }, LAB_CONTEXT).model
	return {
		...hub,
		nowMs,
		statuses: {
			...hub.statuses,
			gcp: {
				key: null,
				data: AsyncData.Success({
					data: { object: "gcp_integration", metrics_available: true, connectors },
				}),
			},
		},
	}
}

type HubCommand = Command.Command<IntegrationsMessage, never, Resources>

/** Reads the page owns but the lab does not mount: its status, clock and the removed-connection list. */
const PAGE_READS =
	/^(Load(Integrations|GcpIntegration)|ReadIntegrationsClock|(Read|Write)GcpRemovedConnectors)/

export type HubStep = Readonly<{ hub: IntegrationsModel; commands: ReadonlyArray<HubCommand> }>

/** The page's own update; its navigation is the shell's, so it is not followed here. */
export const hubStep = (hub: IntegrationsModel, message: IntegrationsMessage): HubStep => {
	const next = Integrations.update(hub, message, LAB_CONTEXT)
	return {
		hub: next.model,
		commands: (next.commands ?? []).filter((command) => !PAGE_READS.test(command.name)),
	}
}
