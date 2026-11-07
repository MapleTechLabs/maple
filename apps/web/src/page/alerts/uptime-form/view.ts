import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { Option, Array as Arr, Record as Rec, String as Str } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html } from "foldkit/html"
import { button, linkButton } from "@maple/views/ui/button"
import { errorState } from "@maple/views/ui/error-state"
import { icon, type IconName } from "@maple/views/ui/icon"
import { alert, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { panel, panelHeader } from "@maple/views/ui/panel"
import { segmentedSelect } from "@maple/views/ui/segmented-select"
import { skeleton } from "@maple/views/ui/skeleton"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import {
	formActionBar,
	formCard,
	formScrollArea,
	formSection,
	managersOnlyPage,
} from "../../kit/form-section"
import { failureMessage, type LoadFailure } from "@maple/views/data/load-failure"
import { LIMIT_REACHED_CODE, monitorHref, uptimeTabHref } from "../shared/uptime-commands"
import { formatMs } from "../shared/uptime-derive"
import { uptimePanelBody } from "../shared/uptime-view"
import { formIssues } from "./derive"
import { ASSERTION_OPS, type AssertionDraft, type MonitorKind } from "./form"
import { Message } from "./message"
import { canManage, type Model } from "./model"
import { assertionsSection, type H, requestSection, scheduleSection } from "./view-fields"
import { dnsSection, heartbeatSection, notifySection, serviceSection, tcpSection } from "./view-kinds"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { hstack, hstackClass, vstack, vstackClass } from "@maple/views/ui/stack"

// `/alerts/uptime/new`: the kind picker, the kind's sections, the test panel and the action bar.

const KINDS: ReadonlyArray<{ kind: MonitorKind; label: string; icon: IconName; description: string }> = [
	{
		kind: "http",
		label: "HTTP",
		icon: "GlobeIcon",
		description: "Checks the status, response time, a keyword or JSON in the body.",
	},
	{
		kind: "tcp",
		label: "TCP port",
		icon: "ServerIcon",
		description: "Checks that a host and port accept connections.",
	},
	{
		kind: "dns",
		label: "DNS record",
		icon: "NetworkNodesIcon",
		description: "Checks that a record resolves to the value you expect.",
	},
	{
		kind: "heartbeat",
		label: "Heartbeat",
		icon: "PulseIcon",
		description: "Your job pings Maple, and Maple alerts when the pings stop.",
	},
]

/** The kind as a segmented control; the picked kind's sentence sits under it. */
const kindPicker = (h: H, model: Model): Html =>
	formSection(h, { title: "Type", isCompact: true }, [
		vstack(h, { gap: "2", shrink: true }, [
			segmentedSelect(h, {
				ariaLabel: "Monitor type",
				size: "sm",
				// Four labelled kinds outgrow a phone column, so the track wraps like the old picker.
				className: "w-fit flex-wrap",
				value: model.form.kind,
				onChange: (kind) => Message.PickedKind({ kind }),
				// Editing keeps the kind: the others stay visible but can't be picked.
				options: Arr.map(KINDS, (option) => ({
					value: option.kind,
					label: option.label,
					icon: icon(h, option.icon, { size: 14 }),
					isDisabled: model.editingId !== null && option.kind !== model.form.kind,
				})),
			}),
			typography(h, { size: "xs", tone: "muted", as: "p" }, [
				Arr.findFirst(KINDS, (option) => option.kind === model.form.kind).pipe(
					Option.flatMapNullishOr((found) => found.description),
					Option.getOrElse(() => ""),
				),
			]),
		]),
	])

const describeAssertion = (row: AssertionDraft): string => {
	const op = Arr.findFirst(ASSERTION_OPS[row.type], (entry) => entry.value === row.op).pipe(
		Option.flatMapNullishOr((found) => found.label),
		Option.getOrElse(() => row.op),
	)
	switch (row.type) {
		case "status":
			return `Status code ${op} ${row.value}`
		case "latency":
			return `Response time under ${row.value} ms`
		case "body":
			return `Body ${op} "${row.value}"`
		case "json_path":
			return row.op === "exists"
				? `JSON path ${row.target} exists`
				: `JSON path ${row.target} equals ${row.value}`
		case "header":
			return row.op === "exists"
				? `Header ${row.target} exists`
				: `Header ${row.target} ${op} ${row.value}`
	}
}

const testResultBody = (h: H, model: Model): ReadonlyArray<Html> => {
	if (model.testFailure !== null)
		return [
			typography(h, { size: "sm", tone: "destructive", as: "p", attributes: [h.Role("alert")] }, [
				model.testFailure.message,
			]),
		]
	const result = model.testResult
	if (result === null)
		return [
			typography(h, { size: "sm", tone: "muted", as: "p" }, [
				"Run the check once from Ashburn, US before you save it.",
			]),
		]
	return [
		h.p(
			[h.Class(hstackClass({ gap: "2", align: "baseline" }))],
			[
				h.span(
					[h.Class(cn("font-mono text-2xl font-semibold", TONE_TEXT[result.ok ? "ok" : "crit"]))],
					[result.status_code === null ? "No response" : String(result.status_code)],
				),
				typography(h, { size: "xs", tone: "muted", mono: true }, [formatMs(result.duration_ms)]),
			],
		),
		...(result.error === null ? [] : [h.p([h.Class(cn("text-sm", TONE_TEXT.crit))], [result.error])]),
		vstack(
			h,
			{ gap: "1.5", as: "ul", className: typographyClass({ size: "sm" }) },
			result.ok
				? Arr.map(model.form.assertions, (row) =>
						hstack(h, { gap: "2", as: "li", attributes: [h.Key(String(row.id))] }, [
							icon(h, "CheckIcon", { className: "text-severity-info" }),
							describeAssertion(row),
						]),
					)
				: [
						h.li(
							[h.Class(cn(hstackClass({ gap: "2" }), TONE_TEXT.crit))],
							[icon(h, "XmarkIcon"), result.failed_assertion ?? "The check did not pass."],
						),
					],
		),
		...(result.body_prefix === null
			? []
			: [
					h.pre(
						[
							h.Class(
								"max-h-40 overflow-auto rounded-md bg-surface-sunken p-2 font-mono text-xs whitespace-pre-wrap",
							),
						],
						[result.body_prefix, ...(result.body_truncated ? ["…"] : [])],
					),
				]),
	]
}

const testPanel = (h: H, model: Model): Html =>
	panel(h, {}, [
		panelHeader(h, {
			title: "Test check",
			action: button(
				h,
				{
					size: "sm",
					variant: "outline",
					isLoading: model.isTesting,
					isDisabled: Str.trim(model.form.url) === "",
					attributes: [h.OnClick(Message.ClickedTest())],
				},
				[icon(h, "ArrowRotateClockwiseIcon"), model.testResult === null ? "Run test" : "Run again"],
			),
		}),
		uptimePanelBody(h, [vstack(h, { gap: "3" }, testResultBody(h, model))]),
	])

/** What happens after creating, for the kinds without a test run; editing has nothing to announce. */
const afterSaveNote = (kind: MonitorKind): string =>
	kind === "heartbeat"
		? "The ping URL appears after you create the monitor."
		: "The first check runs from Ashburn, US right after you create the monitor."

/** Pinned under the scroller, outside it, so it never floats over the form. */
const actionBar = (h: H, model: Model, widthClass: string): Html => {
	const issues = formIssues(model.form)
	return formActionBar(h, {
		issues,
		widthClass,
		notice: model.saveFailure === null ? null : saveFailureNotice(h, model.saveFailure, widthClass),
		actions: [
			linkButton(
				h,
				{
					variant: "outline",
					href: model.editingId === null ? uptimeTabHref() : monitorHref(model.editingId),
				},
				["Cancel"],
			),
			button(
				h,
				{
					// Until the session says this is an admin, a click would be dropped by `save`.
					isDisabled: issues.length > 0 || !canManage(model),
					isLoading: model.isSaving,
					attributes: [h.OnClick(Message.ClickedSave())],
				},
				[model.editingId !== null ? "Save changes" : "Create monitor"],
			),
		],
	})
}

/**
 * The edited monitor's saved headers or body open the disclosure. Read from the saved monitor, not
 * the live fields, so clearing a header while typing never collapses it.
 */
const hasSavedRequestExtras = (model: Model): boolean =>
	Option.match(AsyncData.getData(model.existing.data), {
		onNone: () => false,
		onSome: (monitor) =>
			monitor.config.type === "http" &&
			(Rec.keys(monitor.config.headers ?? {}).length > 0 || (monitor.config.body ?? "") !== ""),
	})

const kindSections = (h: H, model: Model): ReadonlyArray<Html> => {
	switch (model.form.kind) {
		case "http":
			return [
				...requestSection(h, model, hasSavedRequestExtras(model)),
				assertionsSection(h, model),
				scheduleSection(h, model),
			]
		case "tcp":
			return [...tcpSection(h, model), scheduleSection(h, model)]
		case "dns":
			return [...dnsSection(h, model), scheduleSection(h, model)]
		case "heartbeat":
			return heartbeatSection(h, model)
	}
}

/** The last save's failure, in the server's words: the plan's limit, or why it was refused. */
const saveFailureNotice = (h: H, failure: LoadFailure, widthClass: string): Html =>
	failure.code === LIMIT_REACHED_CODE
		? alert(h, { variant: "warn", size: "sm", className: cn("mb-3", widthClass) }, [
				icon(h, "CircleWarningIcon"),
				alertTitle(h, ["Uptime monitor limit reached"]),
				alertDescription(h, [failure.message]),
			])
		: alert(h, { variant: "crit", size: "sm", className: cn("mb-3", widthClass) }, [
				icon(h, "CircleXmarkIcon"),
				alertTitle(h, ["Couldn't save the monitor"]),
				alertDescription(h, [failureMessage(failure)]),
			])

/** Members can read monitors but not create or change them; the API refuses them too. */
const adminOnlyPage = (h: H, model: Model, header: Readonly<{ title: string; description: string }>) =>
	managersOnlyPage(h, {
		header,
		title: "Only org admins and engineers can create or change uptime monitors",
		back:
			model.editingId === null
				? { href: uptimeTabHref(), label: "Back to uptime" }
				: { href: monitorHref(model.editingId), label: "Back to the monitor" },
	})

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, _inputs, h) => {
	const isEdit = model.editingId !== null
	const header = {
		title: isEdit ? "Edit monitor" : "New monitor",
		description: "Maple checks it from Ashburn, US and records every check as a trace.",
	}
	if (model.isSessionLoaded && !canManage(model)) return adminOnlyPage(h, model, header)
	if (isEdit && AsyncData.isFailure(model.existing.data))
		return dashboardPage(h, header, [
			errorState(h, { failure: model.existing.data.error, title: "Couldn't load the monitor" }),
		])
	if (isEdit && !AsyncData.isSuccess(model.existing.data) && !AsyncData.isRefreshing(model.existing.data))
		return dashboardPage(h, header, [skeleton(h, "h-24 w-full"), skeleton(h, "h-80 w-full")])
	const isHttp = model.form.kind === "http"
	const widthClass = isHttp ? "max-w-6xl" : "max-w-3xl"
	const card = formCard(h, [
		kindPicker(h, model),
		...kindSections(h, model),
		serviceSection(h, model),
		notifySection(h, model),
	])
	return dashboardPage(h, { ...header, fill: true }, [
		formScrollArea(h, [
			isHttp
				? h.div(
						[h.Class(cn("grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]", widthClass))],
						[card, h.div([h.Class("lg:sticky lg:top-0 lg:self-start")], [testPanel(h, model)])],
					)
				: h.div(
						[h.Class(cn(vstackClass({ gap: "2" }), widthClass))],
						[
							card,
							...(isEdit
								? []
								: [
										h.p(
											[
												h.Class(
													typographyClass({
														size: "xs",
														tone: "muted",
														className: "px-1",
													}),
												),
											],
											[afterSaveNote(model.form.kind)],
										),
									]),
						],
					),
		]),
		actionBar(h, model, widthClass),
	])
})
