import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "../../../ui/icon"
import type { FlowStage } from "../../integrations/flow"
import { platformMeta } from "../kit/platforms"
import { Message } from "./message"
import type { Model } from "./model"
import { flowSpecOf, isReceiving } from "./update"
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

const STAGE_LABEL = { connect: "Connect", choose: "Choose data", live: "Go live" } satisfies Record<
	FlowStage,
	string
>

export const trailOf = (model: Model): ReadonlyArray<TrailItem> => {
	// The token step stays on screen once a source exists, even if the route moved on.
	if (model.created !== null) {
		const { source } = model.created
		return [
			done(platformMeta(source.platform).label),
			done(source.name),
			isReceiving(model) ? done("Receiving data") : current("Send data"),
		]
	}
	if (model.platform !== null)
		return [done(platformMeta(model.platform).label), current("Name"), next("Send data")]
	const spec = flowSpecOf(model)
	if (model.integration !== null && spec !== null) {
		const source = done(integrationMeta(model.integration).label)
		const at = spec.stages.indexOf(model.stage)
		return [
			source,
			...spec.stages.map((stage, index): TrailItem => {
				if (index > at) return next(STAGE_LABEL[stage])
				if (stage === "live")
					return spec.live === "healthy"
						? done("Live")
						: spec.live === "attention"
							? { label: "Go live: needs attention", state: "blocked" }
							: current("Go live")
				const answer = stage === "connect" ? spec.connected : spec.chosen
				if (index === at) return current(STAGE_LABEL[stage])
				// A passed step is only ticked while it still has its answer; a poll can take it back.
				return answer === null ? next(STAGE_LABEL[stage]) : done(answer)
			}),
		]
	}
	return [current("Source"), next("Connect"), next("Go live")]
}

const ITEM_CLASS = {
	done: "text-muted-foreground",
	current: "text-foreground border-primary border-b pb-0.5 font-medium",
	next: "text-muted-foreground",
	blocked: "text-warning border-warning border-b pb-0.5 font-medium",
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
				: [
						// An arrow, not a slash: the steps are a flow, not a path back up.
						h.li(
							[h.AriaHidden(true), h.Class("inline-flex text-muted-foreground/60")],
							[icon(h, "ArrowRightIcon", { size: 12 })],
						),
						item(h, entry),
					],
		),
	)
