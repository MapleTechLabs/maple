import { OrgId } from "@maple/domain"
import { Clock, Effect, Schema } from "effect"
import { Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import type { PageContext } from "../../page/contract"
import * as HostsList from "../../page/infra/hosts/list/message"
import { SortState, nextSort } from "../../page/kit/table-sort"
import * as RailwayList from "../../page/infra-integrations/railway/list/message"
import { Model as RailwayModel } from "../../page/infra-integrations/railway/list/model"
import * as RailwayUpdate from "../../page/infra-integrations/railway/list/update"
import type { Resources } from "../../platform/resources"

// `/lab/infra`: the infra overview, hosts list and Railway list
// over fixture rows. The Railway list's own Model hosts its table's sort and row tooltips.

const LAB_CONTEXT: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_lab_infra"),
	pinnedNamespace: null,
	timeZone: "UTC",
}

export const Model = Schema.Struct({
	/** `const NOW = Date.now()` at module load: the fixture is built from it. */
	nowMs: Schema.Number,
	timeZone: Schema.String,
	hostQuery: Schema.String,
	hostScope: Schema.optional(HostsList.HostScope),
	/** `HostTable`'s own `useTableSort`: CPU, descending. */
	hostSort: SortState,
	railway: RailwayModel,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	ChangedHostQuery: { value: Schema.String },
	ChangedHostScope: { scope: Schema.optional(HostsList.HostScope) },
	ClickedHostSort: { key: HostsList.HostSortKey },
	GotRailwayMessage: { message: RailwayList.Message },
})
export type Message = typeof Message.Type

export const Flags = Schema.Struct({ nowMs: Schema.Number, timeZone: Schema.String })
export type Flags = typeof Flags.Type

export const flags: Effect.Effect<Flags> = Effect.all({
	nowMs: Clock.currentTimeMillis,
	timeZone: Effect.sync(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
})

type Return = Update.Return<Model, Message, Resources>

/** The Railway list's reads are not sent: its Model only carries the table's local state. */
export const init = (flags: Flags): Return => ({
	model: {
		...flags,
		hostQuery: "",
		hostSort: { key: "cpuPct", dir: "desc" },
		railway: RailwayUpdate.init({ search: {} }, LAB_CONTEXT).model,
	},
})

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		ChangedHostQuery: ({ value }) => ({ model: { ...model, hostQuery: value } }),
		ChangedHostScope: ({ scope }) => ({ model: { ...model, hostScope: scope } }),
		ClickedHostSort: ({ key }) => ({
			model: { ...model, hostSort: nextSort(model.hostSort, key, { stringKeys: ["hostName"] }) },
		}),
		// Only the table's sort and tooltips; the Railway search box here is inert.
		GotRailwayMessage: ({ message: inner }) => {
			if (inner._tag !== "ClickedSort" && inner._tag !== "GotRowTooltipMessage") return { model }
			const next = RailwayUpdate.update(model.railway, inner, LAB_CONTEXT)
			return {
				model: { ...model, railway: next.model },
				commands: Command.mapMessages(next.commands ?? [], (child) =>
					Message.GotRailwayMessage({ message: child }),
				),
			}
		},
	})
