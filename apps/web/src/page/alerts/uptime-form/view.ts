import { cn } from "@maple/ui/lib/utils"
import { AsyncData, Submodel } from "foldkit"
import type { Html } from "foldkit/html"
import { button, linkButton } from "../../../ui/button"
import { errorState } from "../../../ui/error-state"
import { icon, type IconName } from "../../../ui/icon"
import { alert, alertDescription, alertTitle } from "../../../ui/alert"
import { panel, panelHeader } from "../../../ui/panel"
import { skeleton } from "../../../ui/skeleton"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { failureMessage, type LoadFailure } from "../../../data/load-failure"
import { LIMIT_REACHED_CODE, monitorHref, uptimeTabHref } from "../shared/uptime-commands"
import { formatMs } from "../shared/uptime-derive"
import { uptimePanelBody } from "../shared/uptime-view"
import { formIssues } from "./derive"
import { ASSERTION_OPS, type AssertionDraft, type MonitorKind } from "./form"
import { Message } from "./message"
import type { Model } from "./model"
import { assertionsSection, type H, requestSection, scheduleSection } from "./view-fields"
import { dnsSection, heartbeatSection, notifySection, serviceSection, tcpSection } from "./view-kinds"

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

/** The kind as one row of radios; the picked kind's sentence sits under it. */
const kindPicker = (h: H, model: Model): Html =>
	h.section(
		[h.AriaLabel("Type"), h.Class("grid gap-x-8 gap-y-2 px-4 py-4 sm:grid-cols-[136px_minmax(0,1fr)]")],
		[
			h.h3([h.Class("text-sm font-medium sm:pt-1.5")], ["Type"]),
			h.div(
				[h.Class("flex min-w-0 flex-col gap-2")],
				[
					h.div(
						[
							h.Role("radiogroup"),
							h.AriaLabel("Monitor type"),
							h.Class("flex w-fit flex-wrap gap-1 rounded-md border bg-muted/30 p-0.5"),
						],
						KINDS.map((option) => {
							const isSelected = model.form.kind === option.kind
							const isDisabled = model.editingId !== null && !isSelected
							return h.button(
								[
									h.Key(option.kind),
									h.Type("button"),
									h.Role("radio"),
									h.AriaChecked(isSelected),
									...(isDisabled ? [h.Disabled(true)] : []),
									h.OnClick(Message.PickedKind({ kind: option.kind })),
									h.Class(
										cn(
											"flex h-7 items-center gap-1.5 rounded-[5px] px-2.5 text-sm transition-colors",
											isSelected
												? "bg-background text-foreground shadow-xs ring-1 ring-border"
												: "text-muted-foreground hover:text-foreground",
											isDisabled &&
												"cursor-not-allowed opacity-50 hover:text-muted-foreground",
										),
									),
								],
								[
									icon(h, option.icon, {
										size: 14,
										className: isSelected ? "text-primary" : undefined,
									}),
									option.label,
								],
							)
						}),
					),
					h.p(
						[h.Class("text-xs text-muted-foreground")],
						[KINDS.find((option) => option.kind === model.form.kind)?.description ?? ""],
					),
				],
			),
		],
	)

const describeAssertion = (row: AssertionDraft): string => {
	const op = ASSERTION_OPS[row.type].find((entry) => entry.value === row.op)?.label ?? row.op
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
		return [h.p([h.Role("alert"), h.Class("text-sm text-destructive")], [model.testFailure.message])]
	const result = model.testResult
	if (result === null)
		return [
			h.p(
				[h.Class("text-sm text-muted-foreground")],
				["Run the check once from Ashburn, US before you save it."],
			),
		]
	return [
		h.p(
			[h.Class("flex items-baseline gap-2")],
			[
				h.span(
					[h.Class(cn("font-mono text-2xl", result.ok ? "text-success" : "text-destructive"))],
					[result.status_code === null ? "No response" : String(result.status_code)],
				),
				h.span([h.Class("font-mono text-xs text-muted-foreground")], [formatMs(result.duration_ms)]),
			],
		),
		...(result.error === null ? [] : [h.p([h.Class("text-sm text-destructive")], [result.error])]),
		h.ul(
			[h.Class("flex flex-col gap-1.5 text-sm")],
			result.ok
				? model.form.assertions.map((row) =>
						h.li(
							[h.Key(String(row.id)), h.Class("flex items-center gap-2")],
							[icon(h, "CheckIcon", { className: "text-success" }), describeAssertion(row)],
						),
					)
				: [
						h.li(
							[h.Class("flex items-center gap-2 text-destructive")],
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
								"max-h-40 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-xs whitespace-pre-wrap",
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
					isDisabled: model.form.url.trim() === "",
					attributes: [h.OnClick(Message.ClickedTest())],
				},
				[icon(h, "ArrowRotateClockwiseIcon"), model.testResult === null ? "Run test" : "Run again"],
			),
		}),
		uptimePanelBody(h, [h.div([h.Class("flex flex-col gap-3")], testResultBody(h, model))]),
	])

/** What happens after saving, for the kinds without a test run. */
const afterSaveNote = (kind: MonitorKind): string =>
	kind === "heartbeat"
		? "The ping URL appears after you create the monitor."
		: "The first check runs from Ashburn, US right after you create the monitor."

/** Pinned under the scroller, outside it, so it never floats over the form. */
const actionBar = (h: H, model: Model, widthClass: string): Html => {
	const issues = formIssues(model.form)
	const isEdit = model.editingId !== null
	return h.div(
		[h.Class("shrink-0 border-t bg-background px-4 py-3")],
		[
			...(model.saveFailure === null ? [] : [saveFailureNotice(h, model.saveFailure, widthClass)]),
			h.div(
				[h.Class(cn("flex items-center justify-between gap-4", widthClass))],
				[
					issues.length === 0
						? h.span(
								[h.Class("flex items-center gap-1.5 text-xs text-severity-info")],
								[icon(h, "CheckIcon", { size: 14 }), "Ready to save"],
							)
						: h.p(
								[
									h.AriaLabel("Fix before saving"),
									h.Title(issues.join(" ")),
									h.Class(
										"flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground",
									),
								],
								[
									icon(h, "CircleWarningIcon", {
										size: 14,
										className: "shrink-0 text-severity-warn",
									}),
									h.span(
										[h.Class("truncate")],
										[
											"Fix before saving: ",
											...issues.flatMap((issue, index) => [
												...(index === 0 ? [] : [" "]),
												h.span([h.Key(issue), h.Class("text-foreground")], [issue]),
											]),
										],
									),
								],
							),
					h.div(
						[h.Class("flex shrink-0 items-center gap-2")],
						[
							linkButton(
								h,
								{
									variant: "outline",
									href:
										model.editingId === null
											? uptimeTabHref()
											: monitorHref(model.editingId),
								},
								["Cancel"],
							),
							button(
								h,
								{
									// Until the session says this is an admin, a click would be dropped by `save`.
									isDisabled: issues.length > 0 || !model.isAdmin,
									isLoading: model.isSaving,
									attributes: [h.OnClick(Message.ClickedSave())],
								},
								[isEdit ? "Save changes" : "Create monitor"],
							),
						],
					),
				],
			),
		],
	)
}

const kindSections = (h: H, model: Model): ReadonlyArray<Html> => {
	switch (model.form.kind) {
		case "http":
			return [
				...requestSection(h, model, model.form.headers !== ""),
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
const adminOnlyPage = (
	h: H,
	model: Model,
	header: { readonly title: string; readonly description: string },
) =>
	dashboardPage(h, header, [
		alert(h, { variant: "info" }, [
			icon(h, "ShieldIcon"),
			alertTitle(h, ["Only org admins can create or change uptime monitors"]),
			alertDescription(h, ["Ask an admin to make this change."]),
		]),
		h.div(
			[],
			[
				linkButton(
					h,
					{
						variant: "outline",
						href: model.editingId === null ? uptimeTabHref() : monitorHref(model.editingId),
					},
					[model.editingId === null ? "Back to uptime" : "Back to the monitor"],
				),
			],
		),
	])

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, _inputs, h) => {
	const isEdit = model.editingId !== null
	const header = {
		title: isEdit ? "Edit monitor" : "New monitor",
		description: "Maple checks it from Ashburn, US and records every check as a trace.",
	}
	if (model.isSessionLoaded && !model.isAdmin) return adminOnlyPage(h, model, header)
	if (isEdit && AsyncData.isFailure(model.existing.data))
		return dashboardPage(h, header, [
			errorState(h, { failure: model.existing.data.error, title: "Couldn't load the monitor" }),
		])
	if (isEdit && !AsyncData.isSuccess(model.existing.data) && !AsyncData.isRefreshing(model.existing.data))
		return dashboardPage(h, header, [skeleton(h, "h-24 w-full"), skeleton(h, "h-80 w-full")])
	const isHttp = model.form.kind === "http"
	const widthClass = isHttp ? "max-w-6xl" : "max-w-3xl"
	const card = h.div(
		[h.Class("divide-y rounded-lg border bg-card")],
		[kindPicker(h, model), ...kindSections(h, model), serviceSection(h, model), notifySection(h, model)],
	)
	return dashboardPage(h, { ...header, fill: true }, [
		h.div(
			[h.DataAttribute("slot", "page-scroll-area"), h.Class("min-h-0 flex-1 overflow-auto p-4")],
			[
				isHttp
					? h.div(
							[h.Class(cn("grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]", widthClass))],
							[
								card,
								h.div([h.Class("lg:sticky lg:top-0 lg:self-start")], [testPanel(h, model)]),
							],
						)
					: h.div(
							[h.Class(cn("flex flex-col gap-2", widthClass))],
							[
								card,
								h.p(
									[h.Class("px-1 text-xs text-muted-foreground")],
									[afterSaveNote(model.form.kind)],
								),
							],
						),
			],
		),
		actionBar(h, model, widthClass),
	])
})
