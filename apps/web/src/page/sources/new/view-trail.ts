import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "../../../ui/icon"
import { overviewOf } from "../../integrations/derive"
import { platformMeta } from "../kit/platforms"
import { Message } from "./message"
import type { Model } from "./model"
import { isReceiving } from "./update"
import { isIntegrationConnected } from "./view-integration"
import { integrationMeta } from "./view-picker"

// The connect flow's progress: one line under the title. A finished step shows its answer, not its name.

type H = HtmlBuilder<Message>

export type TrailItem = Readonly<{
	label: string
	state: "done" | "current" | "next" | "blocked"
}>

const done = (label: string): TrailItem => ({ label, state: "done" })
const current = (label: string): TrailItem => ({ label, state: "current" })
const next = (label: string): TrailItem => ({ label, state: "next" })

export const trailOf = (model: Model): ReadonlyArray<TrailItem> => {
	if (model.platform !== null) {
		const source = done(platformMeta(model.platform).label)
		if (model.created === null) return [source, current("Name"), next("Send data")]
		const named = done(model.created.source.name)
		return [source, named, isReceiving(model) ? done("Receiving data") : current("Send data")]
	}
	if (model.integration !== null) {
		const source = done(integrationMeta(model.integration).label)
		if (!isIntegrationConnected(model, model.integration))
			return [source, current("Connect"), next("Go live")]
		// WarpStream targets read as Prometheus ones, so its health is not its own: it ends at connected.
		const overview =
			model.integration === "warpstream"
				? null
				: overviewOf(model.integrations.statuses, model.integrations.nowMs, model.integration)
		const live: TrailItem =
			overview?.kind !== "connected" || overview.health === "healthy"
				? done("Live")
				: overview.health === "attention"
					? { label: "Go live: needs attention", state: "blocked" }
					: current("Go live")
		return [source, done("Connected"), live]
	}
	return [current("Source"), next("Connect"), next("Go live")]
}

const ITEM_CLASS = {
	done: "text-muted-foreground",
	current: "text-foreground border-primary border-b pb-0.5 font-medium",
	next: "text-muted-foreground/60",
	blocked: "text-foreground border-warning border-b pb-0.5 font-medium",
} satisfies Record<TrailItem["state"], string>

const item = (h: H, entry: TrailItem): Html =>
	h.li(
		[
			h.Class(cn("inline-flex items-center gap-1.5", ITEM_CLASS[entry.state])),
			...(entry.state === "current" || entry.state === "blocked" ? [h.AriaCurrent("step")] : []),
		],
		[
			...(entry.state === "done"
				? [icon(h, "CheckIcon", { size: 12, className: "text-success" })]
				: entry.state === "blocked"
					? [icon(h, "AlertWarningIcon", { size: 12, className: "text-warning" })]
					: []),
			entry.label,
		],
	)

export const trail = (h: H, model: Model): Html =>
	h.ol(
		[h.AriaLabel("Setup progress"), h.Class("flex flex-wrap items-center gap-2 font-mono text-xs")],
		trailOf(model).flatMap((entry, index) =>
			index === 0
				? [item(h, entry)]
				: [h.li([h.AriaHidden(true), h.Class("text-muted-foreground/50")], ["/"]), item(h, entry)],
		),
	)
