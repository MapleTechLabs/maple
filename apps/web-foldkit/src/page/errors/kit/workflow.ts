import type { WorkflowState } from "@maple/domain/http"
import { TONE_COLOR } from "@maple/ui/lib/tone"
import type { Html, HtmlBuilder } from "foldkit/html"

export const WORKFLOW_LABEL = {
	triage: "Triage",
	regressed: "Regressed",
	todo: "Todo",
	in_progress: "In progress",
	in_review: "In review",
	verifying: "Verifying",
	done: "Done",
	cancelled: "Cancelled",
	wontfix: "Won't fix",
} satisfies Record<WorkflowState, string>

const WORKFLOW_COLOR = {
	triage: "oklch(0.72 0.17 55)",
	regressed: TONE_COLOR.crit,
	todo: "oklch(0.60 0.02 286)",
	in_progress: "oklch(0.75 0.15 85)",
	in_review: "oklch(0.65 0.16 290)",
	verifying: "oklch(0.68 0.13 190)",
	done: TONE_COLOR.done,
	cancelled: "oklch(0.55 0.01 286)",
	wontfix: "oklch(0.55 0.01 286)",
} satisfies Record<WorkflowState, string>

const polarToCartesian = (cx: number, cy: number, r: number, angleDeg: number) => {
	const rad = ((angleDeg - 90) * Math.PI) / 180
	return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) }
}

const describeArc = (cx: number, cy: number, r: number, startAngle: number, endAngle: number): string => {
	const start = polarToCartesian(cx, cy, r, endAngle)
	const end = polarToCartesian(cx, cy, r, startAngle)
	const largeArc = endAngle - startAngle <= 180 ? 0 : 1
	return `M ${cx} ${cy} L ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 0 ${end.x} ${end.y} Z`
}

/** Progress arcs, in degrees, for the states drawn as a ring with a filled wedge. */
const ARC_END = new Map<WorkflowState, number>([
	["in_progress", 140],
	["in_review", 280],
	["verifying", 330],
])

/** Marks inside the filled disc of the closed states. */
const CLOSED_MARK = new Map<WorkflowState, readonly [string, boolean]>([
	["done", ["M8 12 L11 15 L16 9", true]],
	["cancelled", ["M9 9 L15 15 M15 9 L9 15", false]],
	["wontfix", ["M8 12 L16 12", false]],
])

const circle = <M>(h: HtmlBuilder<M>, attributes: ReadonlyArray<readonly [string, string]>): Html =>
	h.circle(attributes.map(([name, value]) => h.Attribute(name, value)))

/** `WorkflowRingIcon`: the state as a ring that fills as the work progresses. */
export const workflowRingIcon = <M>(
	h: HtmlBuilder<M>,
	state: WorkflowState,
	size = 14,
	className?: string,
): Html => {
	const color = WORKFLOW_COLOR[state]
	const ring = circle(h, [
		["cx", "12"],
		["cy", "12"],
		["r", "9"],
		["stroke", color],
		["stroke-width", "2"],
		...(state === "triage" ? [["stroke-dasharray", "3 3"] as const] : []),
	])
	const arcEnd = ARC_END.get(state)
	const children: ReadonlyArray<Html> =
		state === "triage"
			? [
					ring,
					circle(h, [
						["cx", "12"],
						["cy", "12"],
						["r", "3"],
						["fill", color],
					]),
				]
			: state === "todo"
				? [ring]
				: arcEnd !== undefined
					? [
							ring,
							h.path([
								h.Attribute("d", describeArc(12, 12, 7, 0, arcEnd)),
								h.Attribute("fill", color),
							]),
						]
					: closedMark(h, state, color)
	return h.svg(
		[
			h.Attribute("xmlns", "http://www.w3.org/2000/svg"),
			h.Attribute("viewBox", "0 0 24 24"),
			h.Attribute("width", String(size)),
			h.Attribute("height", String(size)),
			...(className === undefined ? [] : [h.Attribute("class", className)]),
			h.Attribute("fill", "none"),
			h.Attribute("role", "img"),
			h.Attribute("aria-label", WORKFLOW_LABEL[state]),
		],
		children,
	)
}

/** The filled disc with its white mark (`regressed` falls through to won't fix's dash). */
const closedMark = <M>(h: HtmlBuilder<M>, state: WorkflowState, color: string): ReadonlyArray<Html> => {
	const [d, isJoined] = CLOSED_MARK.get(state) ?? ["M8 12 L16 12", false]
	return [
		circle(h, [
			["cx", "12"],
			["cy", "12"],
			["r", "10"],
			["fill", color],
		]),
		h.path([
			h.Attribute("d", d),
			h.Attribute("stroke", "white"),
			h.Attribute("stroke-width", "2"),
			h.Attribute("stroke-linecap", "round"),
			...(isJoined ? [h.Attribute("stroke-linejoin", "round")] : []),
		]),
	]
}
