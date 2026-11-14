import type { Html, HtmlBuilder } from "foldkit/html"
import { answerTrail } from "@maple/views/ui/answer-trail"
import type { FlowStage } from "../../integrations/embed"
import { platformMeta } from "../kit/platforms"
import { Message } from "./message"
import type { Model } from "./model"
import { flowSpecOf, isReceiving } from "./update"
import { integrationMeta } from "./view-picker"
import { Array as Arr } from "effect"

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
			...Arr.map(spec.stages, (stage, index): TrailItem => {
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

export const trail = (h: H, model: Model): Html =>
	answerTrail(h, { label: "Setup progress", steps: trailOf(model) })
