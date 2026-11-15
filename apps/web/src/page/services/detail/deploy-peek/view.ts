import { PANEL_ROW_CLASS } from "../view-panels"
import { formatWarehouseDateTime, parseWarehouseDateTime } from "@maple/query-engine"
import { formatErrorRate, formatLatency, formatNumber, formatRate } from "@maple/ui/lib/format"
import { shortId } from "@maple/ui/lib/ids"
import { Array as Arr } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { linkButton } from "@maple/views/ui/button"
import * as DialogView from "@maple/views/ui/dialog-view"
import { badge } from "@maple/views/ui/display"
import { emptyMessage } from "@maple/views/ui/empty"
import { errorState } from "@maple/views/ui/error-state"
import { icon } from "@maple/views/ui/icon"
import { listRow } from "@maple/views/ui/list-row"
import { serviceLabel } from "@maple/views/ui/service-label"
import { skeletonList } from "@maple/views/ui/skeleton"
import { hstack, vstack, vstackClass } from "@maple/views/ui/stack"
import { truncatedText } from "@maple/views/ui/truncated-text"
import { typography } from "@maple/views/ui/typography"
import { AppRoute, hrefOf } from "../../../../route"
import { firstLine, isResolvableSha } from "../../../kit/commit-card"
import { relativeTime } from "../../../kit/relative-time"
import { sectionHeading } from "../../../kit/section-heading"
import { sheetDetailHeader } from "../../../kit/sheet-detail-header"
import { statRail, statRailItem } from "../../../kit/stat-rail"
import { type DeployCheck, deployChecks, isErrorRateUp, isP95Up } from "../derive-deploys"
import type { Issue } from "../model"
import type { CommitData } from "../../../kit/service-metrics/points"
import { verdictBadge } from "../view-verdict"
import { type OperationChange, operationChanges } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { afterSeconds, OPERATIONS_LIMIT, sidesOf } from "./update"

type H = HtmlBuilder<Message>

const OPERATIONS_SHOWN = 8

export type ViewInputs = Readonly<{
	check: DeployCheck | null
	serviceName: string
	commit: CommitData | undefined
	/** The page's open issues an issue tag gives to this deploy. */
	issues: ReadonlyArray<Issue>
	dataEndMs: number
	nowMs: number
	timeZone: string
	/** The page's window, carried onto the links to the commit's other deploys. */
	timeSearch: Readonly<{ startTime?: string; endTime?: string; timePreset?: string }>
}>

const shaLabel = (sha: string) => (isResolvableSha(sha) ? shortId(sha, "sha") : sha)

const header = (h: H, model: Model, check: DeployCheck, inputs: ViewInputs): Html => {
	const commit =
		inputs.commit !== undefined && AsyncData.isSuccess(inputs.commit) ? inputs.commit.data : null
	const subject = commit === null ? "" : firstLine(commit.message)
	const author = commit?.authorLogin ?? commit?.authorName ?? null
	return sheetDetailHeader(h, {
		dialogId: model.dialog.id,
		kind: "Deploy",
		title: [subject === "" ? shaLabel(check.sha) : subject],
		mono: subject === "",
		adornment: verdictBadge(h, check),
		description: `${inputs.serviceName} deploy ${check.sha}`,
		meta: [
			typography(h, { size: "xs", mono: true, tone: "muted", attributes: [h.Title(check.sha)] }, [
				shaLabel(check.sha),
			]),
			...(author === null ? [] : [typography(h, { size: "xs", tone: "muted" }, [author])]),
			...(check.environment === ""
				? []
				: [badge(h, { size: "xs", variant: "meta" }, [check.environment])]),
			relativeTime(h, {
				value: check.firstSeenMs,
				nowMs: inputs.nowMs,
				timeZone: inputs.timeZone,
				variant: "orDate",
				className: "text-xs text-muted-foreground",
			}),
		],
		className: "border-b pb-4",
	})
}

/** The two sides cover different minutes while a deploy verifies, so they compare as rates. */
const comparison = (h: H, check: DeployCheck, dataEndMs: number): Html => {
	const errorsUp = isErrorRateUp(check.before.errorRate, check.after.errorRate)
	const slower = isP95Up(check.before.p95Ms, check.after.p95Ms)
	return vstack(h, { gap: "2" }, [
		sectionHeading(h, {
			title:
				check.minutes === 0
					? `Since this deploy, against the ${check.windowMinutes} minutes before`
					: check.minutes < check.windowMinutes
						? `First ${check.minutes} of ${check.windowMinutes} minutes, against the ${check.windowMinutes} before`
						: `First ${check.windowMinutes} minutes, against the ${check.windowMinutes} before`,
		}),
		statRail(h, { columns: 3, className: "w-full overflow-hidden" }, [
			statRailItem(h, {
				eyebrow: "Requests",
				value: formatRate(check.after.spans / afterSeconds(check, dataEndMs)),
				hint: "/s",
				subline: `before ${formatRate(check.before.spans / (check.windowMinutes * 60))}/s`,
				compact: true,
			}),
			statRailItem(h, {
				eyebrow: "Error rate",
				value: formatErrorRate(check.after.errorRate),
				tone: errorsUp ? "crit" : "neutral",
				subline: `before ${formatErrorRate(check.before.errorRate)}`,
				compact: true,
			}),
			statRailItem(h, {
				eyebrow: "p95 latency",
				value: formatLatency(check.after.p95Ms),
				tone: slower ? "warn" : "neutral",
				subline: `before ${formatLatency(check.before.p95Ms)}`,
				compact: true,
			}),
		]),
	])
}

const CHANGE_BADGE = {
	"errors-up": { label: "Errors up", variant: "crit" },
	slower: { label: "Slower", variant: "warn" },
	new: { label: "New", variant: "info" },
	"few-before": { label: "Few before", variant: "muted" },
	faster: { label: "Faster", variant: "ok" },
	steady: { label: "Steady", variant: "muted" },
} as const

/** "errors 0.2% → 10% · p95 86ms → 131ms", or the after figures alone for a new operation. */
const operationFigures = (change: OperationChange): string => {
	const { before, after } = change
	// A New operation's few earlier calls are no baseline: it shows its after figures alone.
	return before === undefined || change.change === "new" || change.change === "few-before"
		? `errors ${formatErrorRate(after.errorRate)} · p95 ${formatLatency(after.p95DurationMs)}`
		: `errors ${formatErrorRate(before.errorRate)} → ${formatErrorRate(after.errorRate)} · p95 ${formatLatency(before.p95DurationMs)} → ${formatLatency(after.p95DurationMs)}`
}

const operationRow = (h: H, change: OperationChange): Html =>
	listRow(h, {
		density: "compact",
		className: PANEL_ROW_CLASS,
		leading: badge(
			h,
			{ size: "xs", variant: CHANGE_BADGE[change.change].variant, className: "w-16 justify-center" },
			[CHANGE_BADGE[change.change].label],
		),
		title: truncatedText(h, { text: change.spanName, mono: true, className: "text-xs font-normal" }),
		wrapMeta: true,
		meta: typography(h, { size: "2xs", mono: true, numeric: true, tone: "muted" }, [
			operationFigures(change),
		]),
	})

/**
 * The operations rollup has no commit, so its after side is every version serving then; and it
 * counts every span, not only the entry spans the comparison counts, so no share can be read off it.
 */
const sharedNote = (h: H): Html =>
	typography(h, { size: "2xs", tone: "muted", as: "p" }, [
		"These count every version serving after the deploy, not only this one.",
	])

const operationsSection = (h: H, model: Model): Html => {
	const heading = sectionHeading(h, { title: "Operations it moved" })
	const both = AsyncData.all([model.before.data, model.after.data])
	return vstack(h, { gap: "2" }, [
		heading,
		AsyncData.matchData(both, {
			onEmpty: () => skeletonList(h, { rows: 4 }),
			onFailure: (failure) =>
				errorState(h, {
					failure,
					title: "Couldn't load operations",
					onRetry: Message.ClickedRetry(),
				}),
			onData: ([before, after]) => {
				const changes = operationChanges(before, after, OPERATIONS_LIMIT)
				return changes.length === 0
					? emptyMessage(h, {}, ["Too little traffic after the deploy to compare operations"])
					: vstack(h, { gap: "1" }, [
							sharedNote(h),
							vstack(
								h,
								{ gap: "0" },
								Arr.map(changes.slice(0, OPERATIONS_SHOWN), (change) =>
									operationRow(h, change),
								),
							),
						])
			},
		}),
	])
}

const issuesSection = (h: H, issues: ReadonlyArray<Issue>): Html =>
	issues.length === 0
		? null
		: vstack(h, { gap: "2" }, [
				sectionHeading(h, { title: "Open issues first seen since", count: String(issues.length) }),
				vstack(
					h,
					{ gap: "0" },
					Arr.map(issues, (issue) =>
						listRow(h, {
							density: "compact",
							className: PANEL_ROW_CLASS,
							href: `/errors/issues/${issue.id}`,
							title: truncatedText(h, { text: issue.title, className: "font-normal" }),
							trailing: typography(
								h,
								{ size: "xs", tone: "muted", mono: true, numeric: true },
								[formatNumber(issue.occurrenceCount), "×"],
							),
						}),
					),
				),
			])

/** The commit's other deploys: other environments of this service, then other services. */
const shippedSection = (h: H, model: Model, check: DeployCheck, inputs: ViewInputs): Html => {
	if (AsyncData.isFailure(model.shipped.data))
		return vstack(h, { gap: "2" }, [
			sectionHeading(h, { title: "Also shipped to" }),
			errorState(h, {
				failure: model.shipped.data.error,
				title: "Couldn't look up the commit's other deploys",
				onRetry: Message.ClickedRetry(),
			}),
		])
	const others = AsyncData.getOrElse(
		AsyncData.map(model.shipped.data, (shipped) =>
			Arr.filter(
				deployChecks(shipped, Math.min(inputs.dataEndMs, parseWarehouseDateTime(shipped.readUntil))),
				(other) =>
					!(other.serviceName === inputs.serviceName && other.environment === check.environment),
			),
		),
		() => [],
	)
	if (others.length === 0) return null
	return vstack(h, { gap: "2" }, [
		sectionHeading(h, { title: "Also shipped to" }),
		vstack(
			h,
			{ gap: "0" },
			Arr.map(others, (other) =>
				listRow(h, {
					density: "compact",
					className: PANEL_ROW_CLASS,
					href: hrefOf(
						AppRoute.Service({
							serviceName: other.serviceName,
							// The same window, so the deploy is still in it when the page lands.
							search: {
								...inputs.timeSearch,
								deploy: other.sha,
								deployEnv: other.environment === "" ? undefined : other.environment,
								environments: other.environment === "" ? undefined : [other.environment],
							},
						}),
					),
					title: hstack(h, { gap: "2", shrink: true }, [
						serviceLabel(h, { serviceName: other.serviceName }),
						...(other.environment === ""
							? []
							: [typography(h, { size: "xs", tone: "muted" }, [other.environment])]),
					]),
					trailing: verdictBadge(h, other),
				}),
			),
		),
	])
}

const footer = (h: H, check: DeployCheck, inputs: ViewInputs): Html => {
	const after = sidesOf(check, inputs.dataEndMs).after
	return DialogView.dialogFooter(
		h,
		"sheet",
		[
			linkButton(
				h,
				{
					size: "sm",
					variant: "outline",
					href: hrefOf(
						AppRoute.Traces({
							search: {
								services: [inputs.serviceName],
								deploymentEnvs: check.environment === "" ? undefined : [check.environment],
								startTime: formatWarehouseDateTime(after.startMs),
								endTime: formatWarehouseDateTime(after.endMs),
							},
						}),
					),
				},
				["Traces after the deploy", icon(h, "ArrowRightIcon")],
			),
		],
		"flex-row items-center gap-3 border-t",
	)
}

const content = (h: H, model: Model, check: DeployCheck, inputs: ViewInputs): ReadonlyArray<Html> => [
	header(h, model, check, inputs),
	DialogView.dialogPanel(
		h,
		"sheet",
		model.dialog.id,
		[
			comparison(h, check, inputs.dataEndMs),
			operationsSection(h, model),
			issuesSection(h, inputs.issues),
			shippedSection(h, model, check, inputs),
		],
		vstackClass({ gap: "6" }),
	),
	footer(h, check, inputs),
]

/** The drawer; its content renders only while a deploy is open. */
export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) =>
	h.submodel({
		slotId: `${model.dialog.id}-sheet`,
		model: model.dialog,
		view: DialogView.view,
		viewInputs: {
			className: "p-0",
			size: "detail",
			side: "right",
			hasTrigger: false,
			isPopupFocused: true,
			toView: ({ portal }) => portal,
			toContent: () => (inputs.check === null ? [] : content(h, model, inputs.check, inputs)),
		},
		toParentMessage: (message) => Message.GotDialogMessage({ message }),
	}),
)
