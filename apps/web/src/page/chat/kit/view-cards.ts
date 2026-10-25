import { humanize } from "../../../lib/humanize"
import { formatTimestampInTimezone } from "@maple/web-data/lib/timezone-format"
import { EMPTY_VALUE } from "@maple/ui/lib/format"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { icon, type IconName } from "../../../ui/icon"
import { item, itemContent, itemMedia, itemTitle } from "../../../ui/item"
import { keyValue, keyValueList } from "../../../ui/key-value"
import { toolLabel } from "./tool-metadata"
import { inputRecord } from "./tool-output"
import { dashboardSummary } from "./view-approval"

// `ApprovalCard` and `TaskCard`: a proposal waiting on the user, and
// a sub-agent run as a line.

const stringify = (input: unknown): string => JSON.stringify(input, null, 2) ?? String(input)

type Formatted =
	| { readonly kind: "scalar"; readonly text: string }
	| { readonly kind: "blob"; readonly chars: number }

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/

/** An argument key for display: `RuleId`, `rule_id` and `ruleId` all read "Rule id". */
const argumentLabel = (key: string): string => {
	const words = key
		.replace(/([a-z\d])([A-Z])/g, "$1 $2")
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map((word) => word.toLowerCase())
	const sentence = words.join(" ")
	return sentence.charAt(0).toUpperCase() + sentence.slice(1)
}

const formatValue = (value: unknown, timeZone: string): Formatted => {
	if (value === null || value === undefined) return { kind: "scalar", text: EMPTY_VALUE }
	if (typeof value === "boolean") return { kind: "scalar", text: value ? "true" : "false" }
	if (typeof value === "number") return { kind: "scalar", text: String(value) }
	if (typeof value === "string" && ISO_TIMESTAMP.test(value))
		return { kind: "scalar", text: formatTimestampInTimezone(value, { timeZone, withYear: true }) }
	const text = typeof value === "string" ? value : JSON.stringify(value)
	return text.length > 200 ? { kind: "blob", chars: text.length } : { kind: "scalar", text }
}

const RAW_CLASS =
	"max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono text-2xs leading-snug"

/** `KeyValueFallback`: the proposal's arguments, one row each. */
const approvalSummary = <M>(h: HtmlBuilder<M>, input: unknown, timeZone: string): Html =>
	Option.match(inputRecord(input), {
		onNone: () => h.pre([h.Class(RAW_CLASS)], [stringify(input)]),
		onSome: (record) => {
			const entries = Object.entries(record).filter(
				([, value]) => value !== undefined && value !== null && value !== "",
			)
			if (entries.length === 0)
				return h.div([h.Class("text-xs text-muted-foreground")], ["No input fields"])
			return keyValueList(
				h,
				{ layout: "grid", className: "gap-x-2 gap-y-1" },
				entries.map(([key, value]) => {
					const formatted = formatValue(value, timeZone)
					return keyValue(h, { label: argumentLabel(key) }, [
						formatted.kind === "scalar"
							? h.span([h.Class("font-medium")], [formatted.text])
							: h.span(
									[h.Class("text-muted-foreground italic")],
									["JSON · ", String(formatted.chars), " chars"],
								),
					])
				}),
			)
		},
	})

export type ApprovalCardOptions<M> = Readonly<{
	toolName: string
	input: unknown
	timeZone: string
	resolved: "applied" | "denied" | undefined
	isRawOpen: boolean
	isDeciding: boolean
	onToggleRaw: M
	onApprove: M
	onDeny: M
}>

export const approvalCard = <M>(h: HtmlBuilder<M>, options: ApprovalCardOptions<M>): Html =>
	h.div(
		[h.Class("overflow-hidden rounded-lg border border-severity-warn/40 bg-severity-warn/5 text-xs")],
		[
			item(h, { size: "xs", variant: "flush", className: "gap-2 px-3" }, [
				itemMedia(h, { variant: "icon" }, [
					icon(h, "CircleWarningIcon", { className: cn("size-3.5", TONE_TEXT.warn) }),
				]),
				itemContent(h, [itemTitle(h, ["Approval required: ", toolLabel(options.toolName)])]),
			]),
			h.div(
				[h.Class("border-t border-severity-warn/20 bg-background/50 p-3")],
				[
					dashboardSummary(h, options.toolName, options.input) ??
						approvalSummary(h, options.input, options.timeZone),
					button(
						h,
						{
							variant: "link",
							size: "xs",
							className: "mt-3 text-muted-foreground hover:text-foreground",
							attributes: [h.OnClick(options.onToggleRaw)],
						},
						[
							icon(h, options.isRawOpen ? "ChevronDownIcon" : "ChevronRightIcon"),
							options.isRawOpen ? "Hide raw input" : "Show raw input",
						],
					),
					...(options.isRawOpen
						? [h.pre([h.Class(cn("mt-2", RAW_CLASS))], [stringify(options.input)])]
						: []),
					options.resolved === "applied"
						? h.div(
								[h.Class("mt-3 flex items-center gap-1.5 font-medium text-severity-info")],
								[icon(h, "CircleCheckIcon", { className: "size-3.5 shrink-0" }), "Applied"],
							)
						: options.resolved === "denied"
							? h.div(
									[
										h.Class(
											"mt-3 flex items-center gap-1.5 font-medium text-muted-foreground",
										),
									],
									[
										icon(h, "CircleXmarkIcon", { className: "size-3.5 shrink-0" }),
										"Denied",
									],
								)
							: h.div(
									[h.Class("mt-3 flex gap-2")],
									[
										button(
											h,
											{
												size: "sm",
												isLoading: options.isDeciding,
												attributes: [h.OnClick(options.onApprove)],
											},
											["Approve"],
										),
										button(
											h,
											{
												size: "sm",
												variant: "ghost",
												isDisabled: options.isDeciding,
												attributes: [h.OnClick(options.onDeny)],
											},
											["Deny"],
										),
									],
								),
				],
			),
		],
	)

// SUB-AGENTS

type AgentPresentation = Readonly<{ label: string; activity: string; icon: IconName }>

const AGENTS = new Map<string, AgentPresentation>([
	["explore", { label: "Explore", activity: "Exploring", icon: "MagnifierIcon" }],
	["investigation-planner", { label: "Planner", activity: "Planning", icon: "CompassIcon" }],
	["investigation-validator", { label: "Validator", activity: "Validating", icon: "ShieldIcon" }],
])

/** `agentPresentation`: a sub-agent's label and look. */
export const agentPresentation = (agent: string): AgentPresentation =>
	AGENTS.get(agent) ??
	(agent.startsWith("hypothesis-")
		? { label: "Hypothesis", activity: "Testing", icon: "CompassIcon" }
		: { label: humanize(agent), activity: "Working", icon: "FaceRobotIcon" })
