import { formatNumber, formatPercent, pluralize } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import {
	errorTextTokens,
	errorTrendBucket,
	failureStatus,
	unwrapToolErrorText,
	variantDifferences,
	type VariantDifference,
} from "../../../lib/agent-sessions/tool-error-display"
import { UNGROUPED_FINGERPRINT } from "@maple/web-data/lib/tool-analytics"
import { formatTimestampInTimezone } from "@maple/web-data/lib/timezone-format"
import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import type * as Dialog from "../../../ui/dialog"
import * as DialogView from "../../../ui/dialog-view"
import { linkButton } from "../../../ui/button"
import { eyebrow } from "../../../ui/eyebrow"
import { heading } from "../../../ui/heading"
import { icon } from "../../../ui/icon"
import { iconButton } from "../../../ui/icon-button"
import { miniBars } from "../../../ui/mini-bars"
import { errorTextHeading, failureStatusLine, windowRangeLabel } from "../tools-kit/error-parts"
import { type ErrorDetail, Message, type Model } from "./error-modal-model"
import { occurrencesOf } from "./error-modal-update"
import { railView } from "./view-error-modal-rail"
import { samplesPane } from "./view-error-modal-samples"
import type { Prepared } from "./view-errors"

// The tool error modal: one error group of one tool in full.

type H = HtmlBuilder<Message>

export type ModalInputs = Readonly<{
	tool: string
	group: Prepared
	position: Readonly<{ index: number; total: number }>
	/** Every failed call of this tool, for the "N% of failures" fact. */
	toolFailures: number
	toolCalls: number
	range: Readonly<{ startMs: number; endMs: number }>
	session: string | undefined
	variant: string | undefined
	timeZone: string
	nowMs: number
}>

const EMPTY_DETAIL: ErrorDetail = { sessions: [], variants: [], breakdown: [] }

export const detailOf = (model: Model): ErrorDetail =>
	Option.getOrElse(AsyncData.getData(model.detail.data), () => EMPTY_DETAIL)

export const differencesOf = (detail: ErrorDetail): ReadonlyMap<string, VariantDifference> => {
	const found = variantDifferences(detail.variants.map((row) => unwrapToolErrorText(row.message).text))
	return new Map(
		detail.variants.flatMap((row, index) =>
			Option.toArray(Option.fromUndefinedOr(found[index])).map(
				(difference) => [row.message, difference] as const,
			),
		),
	)
}

const facts = (h: H, items: ReadonlyArray<Html | string>): ReadonlyArray<Html> =>
	items.map((item, index) =>
		h.span(
			[h.Class("contents")],
			[
				...(index > 0
					? [h.span([h.AriaHidden(true), h.Class("text-foreground-faint")], ["·"])]
					: []),
				typeof item === "string" ? h.span([h.Class("text-muted-foreground")], [item]) : item,
			],
		),
	)

const mutedHeading = (h: H, text: string): Html =>
	heading(h, { level: 2, variant: "code", className: "text-muted-foreground" }, [text])

const headingOf = (h: H, group: Prepared, text: string): Html => {
	if (group.fingerprint === UNGROUPED_FINGERPRINT)
		return h.div(
			[h.Class("flex flex-col gap-1")],
			[
				mutedHeading(h, "Failures recorded before error grouping"),
				h.p(
					[h.Class("max-w-[90ch] font-mono text-xs leading-[17px] text-muted-foreground")],
					[
						"These calls failed before Maple kept a failure's text, so they cannot be told apart by what they said. They leave this list as raw retention ages them out.",
					],
				),
			],
		)
	if (text === "") return mutedHeading(h, "No error message recorded")
	return errorTextHeading(h, errorTextTokens(text))
}

const headerFacts = (h: H, inputs: ModalInputs): ReadonlyArray<Html> => {
	const { group, timeZone } = inputs
	const share = formatPercent(inputs.toolFailures > 0 ? group.calls / inputs.toolFailures : 0, {
		floor: 0.01,
	})
	return facts(h, [
		h.span(
			[h.Class("text-foreground")],
			[formatNumber(group.calls), ` failed ${pluralize(group.calls, "call")}`],
		),
		`${share} of failures`,
		`${formatNumber(group.sessions)} ${pluralize(group.sessions, "session")}`,
		`first seen ${formatTimestampInTimezone(group.firstSeen, { timeZone })}`,
		`last seen ${formatTimestampInTimezone(group.lastSeen, { timeZone })}`,
	])
}

const headerLead = (h: H, inputs: ModalInputs): Html => {
	const { group, position } = inputs
	return h.div(
		[h.Class("flex min-w-0 flex-1 flex-col gap-2.5")],
		[
			h.div(
				[
					h.Class(
						"flex flex-wrap items-center gap-2.5 font-mono text-2xs leading-3.5 text-foreground-subtle",
					),
				],
				[
					h.span([], [inputs.tool]),
					h.span([h.Class("text-foreground-faint")], ["/"]),
					h.span([], ["errors"]),
					h.span([h.Class("text-foreground-faint")], ["/"]),
					h.span([], [String(position.index + 1), " of ", String(position.total)]),
					...(group.errorType === ""
						? []
						: [
								h.span(
									[
										h.Class(
											"ml-1 rounded-sm border border-border px-1.5 text-2xs text-foreground-subtle",
										),
									],
									["error.type ", group.errorType],
								),
							]),
				],
			),
			headingOf(h, group, unwrapToolErrorText(group.message).text),
			h.div(
				[
					h.Class(
						"flex flex-wrap items-center gap-x-3.5 gap-y-1 pt-1 font-mono text-2xs leading-3.5",
					),
				],
				headerFacts(h, inputs),
			),
		],
	)
}

/** The group's trend over the window, and whether it has stopped. */
const headerTrend = (h: H, inputs: ModalInputs): Html => {
	const { group, range, timeZone } = inputs
	const bucket = errorTrendBucket(range.startMs, range.endMs)
	const status = failureStatus({
		lastSeen: group.lastSeen,
		callsSince: group.callsSince,
		failures: group.calls,
		calls: inputs.toolCalls,
		nowMs: inputs.nowMs,
	})
	return h.div(
		[h.Class("flex w-[340px] flex-col gap-1.5")],
		[
			h.div(
				[h.Class("flex items-baseline justify-between font-mono")],
				[
					eyebrow(h, { variant: "mono", className: "leading-3.5" }, [
						"Failed calls / ",
						bucket.unit,
					]),
					h.span(
						[h.Class("text-2xs leading-3.5 tabular-nums text-foreground-subtle")],
						["max ", formatNumber(Math.max(0, ...group.spark))],
					),
				],
			),
			miniBars(h, {
				values: group.spark,
				color: "var(--color-severity-error)",
				floor: 4.5,
				floorColor: "var(--input)",
				minHeight: 6.8,
				gap: group.spark.length > 12 ? 0.3 : 3.5,
				className: "h-11 w-[340px] shrink-0",
			}),
			h.div(
				[h.Class("flex justify-between font-mono text-2xs leading-3.5 text-foreground-subtle")],
				[
					h.span([], [windowRangeLabel(range.startMs, range.startMs, timeZone)]),
					h.span([], [windowRangeLabel(range.endMs, range.endMs, timeZone)]),
				],
			),
			failureStatusLine(h, {
				status,
				scope: "group",
				timeZone,
				nowMs: inputs.nowMs,
				calls: inputs.toolCalls,
				failures: group.calls,
				activeBuckets: {
					active: group.spark.filter((count) => count > 0).length,
					total: group.spark.length,
					unit: bucket.unit,
				},
				className: "justify-end pt-0.5",
			}),
		],
	)
}

const content = (h: H, model: Model, inputs: ModalInputs): Html => {
	const detail = detailOf(model)
	const differences = differencesOf(detail)
	const { group, session, variant } = inputs
	const occurrences = occurrencesOf(model)
	const samplesTotal =
		variant !== undefined && session === undefined
			? (detail.variants.find((row) => row.message === variant)?.calls ?? occurrences.length)
			: session !== undefined && variant === undefined
				? (detail.sessions.find((row) => row.sessionId === session)?.hits ?? occurrences.length)
				: variant === undefined
					? group.calls
					: occurrences.length
	return h.div(
		[h.DataAttribute("slot", "tool-error-modal"), h.Class("flex min-h-0 min-w-0 grow flex-col")],
		[
			h.header(
				[
					h.Class(
						"flex shrink-0 items-start gap-8 border-b border-border px-6 py-5 max-lg:flex-col max-lg:gap-4",
					),
				],
				[
					headerLead(h, inputs),
					h.div(
						[h.Class("flex w-[340px] shrink-0 flex-col items-end gap-3.5 max-lg:items-start")],
						[headerActions(h, model, inputs), headerTrend(h, inputs)],
					),
				],
			),
			h.div(
				[h.Class("flex min-h-0 grow max-md:flex-col")],
				[
					railView(h, model, inputs, detail, differences),
					samplesPane(h, model, inputs, {
						total: samplesTotal,
						differences: detail.variants.length > 1 ? differences : undefined,
					}),
				],
			),
		],
	)
}

/** The modal as the page embeds it; `inputs` is absent while no row is open. */
export const view = Submodel.defineView<Model, Message, Readonly<{ inputs: ModalInputs | undefined }>>(
	(model, { inputs }, h) => errorModal(h, model, inputs),
)

/** The modal over the page: the dialog Submodel draws the frame, this the group. */
const errorModal = (h: H, model: Model, inputs: ModalInputs | undefined): Html =>
	h.submodel({
		slotId: "agent-tool-error-modal",
		model: model.dialog,
		view: DialogView.view,
		toParentMessage: (message: Dialog.Message) => Message.GotDialogMessage({ message }),
		viewInputs: {
			hasTrigger: false,
			showCloseButton: false,
			hasTitle: false,
			hasDescription: false,
			isBottomStickOnMobile: false,
			className: cn(
				"h-[86vh] w-[94vw] max-w-none gap-0 overflow-clip p-0",
				"max-sm:h-[calc(100dvh-2rem)] max-sm:w-[calc(100vw-2rem)]",
			),
			toView: ({ portal }) => portal ?? h.empty,
			toContent: () => (inputs === undefined ? [] : [content(h, model, inputs)]),
		},
	})

const NAV_BUTTON = "text-muted-foreground hover:text-foreground active:text-foreground"

const headerActions = (h: H, model: Model, inputs: ModalInputs): Html => {
	const { position } = inputs
	return h.div(
		[h.Class("flex items-center gap-2")],
		[
			iconButton(
				h,
				{
					label: "Previous error",
					variant: "outline",
					className: NAV_BUTTON,
					isDisabled: position.index === 0,
					attributes: [h.OnClick(Message.ClickedStep({ offset: -1 }))],
				},
				[icon(h, "ChevronUpIcon", { attributes: [h.AriaHidden(true)] })],
			),
			iconButton(
				h,
				{
					label: "Next error",
					variant: "outline",
					className: NAV_BUTTON,
					isDisabled: position.index >= position.total - 1,
					attributes: [h.OnClick(Message.ClickedStep({ offset: 1 }))],
				},
				[icon(h, "ChevronDownIcon", { attributes: [h.AriaHidden(true)] })],
			),
			iconButton(
				h,
				{
					label:
						model.linkCopy === "failed"
							? "Copy failed"
							: model.linkCopy === "copied"
								? "Link copied"
								: "Copy link",
					variant: "outline",
					className: NAV_BUTTON,
					attributes: [h.OnClick(Message.ClickedCopyLink())],
				},
				[
					icon(h, model.linkCopy === "copied" ? "CheckIcon" : "LinkIcon", {
						attributes: [h.AriaHidden(true)],
					}),
				],
			),
			linkButton(
				h,
				{
					variant: "outline",
					size: "sm",
					className: "font-mono text-2xs sm:text-2xs",
					href: hrefOf(
						AppRoute.AgentSessions({ search: { tools: [inputs.tool], hasErrors: true } }),
					),
				},
				[
					"Open in Sessions",
					icon(h, "ExternalLinkIcon", {
						size: 12,
						className: "text-muted-foreground",
						attributes: [h.AriaHidden(true)],
					}),
				],
			),
			iconButton(h, { label: "Close", attributes: [h.OnClick(Message.ClickedClose())] }, [
				icon(h, "XmarkIcon", { attributes: [h.AriaHidden(true)] }),
			]),
		],
	)
}
