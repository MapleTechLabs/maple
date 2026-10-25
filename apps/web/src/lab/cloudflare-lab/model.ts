import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as List from "../../page/infra-integrations/cloudflare/list/model"
import * as Worker from "../../page/infra-integrations/cloudflare/worker/model"
import * as Zone from "../../page/infra-integrations/cloudflare/zone/model"

// `/lab/cloudflare`: the Cloudflare pages, whole, over a copy of
// production data, switched by the floating "Lab page" pivot.

export const LAB_PAGES = ["zones", "workers", "queues", "zone", "worker", "accounts"] as const
export const LabPage = Schema.Literals(LAB_PAGES)
export type LabPage = typeof LabPage.Type

export const PAGE_LABEL = {
	zones: "List · Zones",
	workers: "List · Workers",
	queues: "List · Queues",
	zone: "Zone · maple.dev",
	worker: "Worker · maple-api",
	accounts: "3 accounts (demo)",
} as const satisfies Record<LabPage, string>

/** The browser's zone, read before init: the chart axes and tooltips print in it. */
export const Flags = Schema.Struct({ timeZone: Schema.String })
export type Flags = typeof Flags.Type

export const Model = Schema.Struct({
	timeZone: Schema.String,
	page: LabPage,
	/** The "3 accounts" page's own view, kept apart from the single-account pages. */
	multiView: List.View,
	list: List.Model,
	zone: Zone.Model,
	worker: Worker.Model,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	ClickedLabPage: { page: LabPage },
	GotListMessage: { message: List.Message },
	GotZoneMessage: { message: Zone.Message },
	GotWorkerMessage: { message: Worker.Message },
})
export type Message = typeof Message.Type
