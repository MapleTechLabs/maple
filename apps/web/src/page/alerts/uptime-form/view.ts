import { cn } from "@maple/ui/lib/utils"
import { AsyncData, Submodel } from "foldkit"
import type { Html } from "foldkit/html"
import { button, linkButton } from "../../../ui/button"
import { errorState } from "../../../ui/error-state"
import { icon, type IconName } from "../../../ui/icon"
import { alert, alertDescription, alertTitle } from "../../../ui/alert"
import { panel, panelBody, panelHeader } from "../../../ui/panel"
import { skeleton } from "../../../ui/skeleton"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { monitorHref, uptimeTabHref } from "../shared/uptime-commands"
import { formatMs } from "../shared/uptime-derive"
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
		description: "Status, response time, keyword or JSON in the body.",
	},
	{
		kind: "tcp",
		label: "TCP port",
		icon: "ServerIcon",
		description: "A host and port accept connections.",
	},
	{
		kind: "dns",
		label: "DNS record",
		icon: "NetworkNodesIcon",
		description: "A record resolves to the value you expect.",
	},
	{
		kind: "heartbeat",
		label: "Heartbeat",
		icon: "PulseIcon",
		description: "Your job pings Maple. Alert when it stops.",
	},
]

export const LIMIT_MESSAGE =
	"Your plan includes 10 uptime monitors. Remove one or contact us to raise the limit."

const kindPicker = (h: H, model: Model): Html =>
	h.div(
		[
			h.Role("radiogroup"),
			h.AriaLabel("Monitor type"),
			h.Class("grid gap-3 sm:grid-cols-2 lg:grid-cols-4"),
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
							"flex flex-col gap-1.5 rounded-md border p-4 text-left transition-colors",
							isSelected ? "border-primary bg-primary/10" : "bg-card hover:bg-muted/30",
							isDisabled && "cursor-not-allowed opacity-50",
						),
					),
				],
				[
					h.span(
						[h.Class("flex items-center gap-2 text-sm font-medium")],
						[
							icon(h, option.icon, {
								className: isSelected ? "text-primary" : "text-muted-foreground",
							}),
							option.label,
						],
					),
					h.span([h.Class("text-xs text-muted-foreground")], [option.description]),
				],
			)
		}),
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

const sidePanel = (h: H, model: Model): Html =>
	model.form.kind === "http"
		? panel(h, {}, [
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
						[
							icon(h, "ArrowRotateClockwiseIcon"),
							model.testResult === null ? "Run test" : "Run again",
						],
					),
				}),
				panelBody(h, [h.div([h.Class("flex flex-col gap-3")], testResultBody(h, model))]),
			])
		: model.form.kind === "heartbeat"
			? panel(h, {}, [
					panelHeader(h, { title: "Ping URL" }),
					panelBody(h, [
						h.p(
							[h.Class("text-sm text-muted-foreground")],
							["The ping URL appears after you create the monitor."],
						),
					]),
				])
			: panel(h, {}, [
					panelHeader(h, { title: "First check" }),
					panelBody(h, [
						h.p(
							[h.Class("text-sm text-muted-foreground")],
							["The first check runs from Ashburn, US right after you create the monitor."],
						),
					]),
				])

const actionBar = (h: H, model: Model): Html => {
	const issues = formIssues(model.form)
	const isEdit = model.editingId !== null
	return h.div(
		[h.Class("sticky bottom-0 z-20 -mx-4 -mb-4 mt-6 border-t bg-background/95 px-4 py-3 backdrop-blur")],
		[
			h.div(
				[h.Class("flex items-center justify-between gap-4")],
				[
					issues.length === 0
						? h.span(
								[h.Class("flex items-center gap-1.5 text-xs text-severity-info")],
								[icon(h, "CheckIcon", { size: 14 }), "Ready to save"],
							)
						: h.div(
								[h.Class("flex min-w-0 items-start gap-1.5 text-xs text-muted-foreground")],
								[
									icon(h, "CircleWarningIcon", {
										size: 14,
										className: "mt-px shrink-0 text-severity-warn",
									}),
									h.div(
										[],
										[
											h.span([], ["Fix before saving:"]),
											h.ul(
												[h.AriaLabel("Fix before saving")],
												issues.map((issue) =>
													h.li([h.Key(issue), h.Class("text-foreground")], [issue]),
												),
											),
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
									isDisabled: issues.length > 0,
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
				requestSection(h, model, model.form.headers !== ""),
				assertionsSection(h, model),
				scheduleSection(h, model),
			]
		case "tcp":
			return [tcpSection(h, model), scheduleSection(h, model)]
		case "dns":
			return [dnsSection(h, model), scheduleSection(h, model)]
		case "heartbeat":
			return [heartbeatSection(h, model)]
	}
}

const limitNotice = (h: H): Html =>
	alert(h, { variant: "warn" }, [
		icon(h, "CircleWarningIcon"),
		alertTitle(h, ["Uptime monitor limit reached"]),
		alertDescription(h, [LIMIT_MESSAGE]),
	])

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, _inputs, h) => {
	const isEdit = model.editingId !== null
	const header = {
		title: isEdit ? "Edit monitor" : "New monitor",
		description: "Maple checks it from Ashburn, US and records every check as a trace.",
	}
	if (isEdit && AsyncData.isFailure(model.existing.data))
		return dashboardPage(h, header, [
			errorState(h, { failure: model.existing.data.error, title: "Couldn't load the monitor" }),
		])
	if (isEdit && !AsyncData.isSuccess(model.existing.data) && !AsyncData.isRefreshing(model.existing.data))
		return dashboardPage(h, header, [skeleton(h, "h-24 w-full"), skeleton(h, "h-80 w-full")])
	return dashboardPage(h, { ...header, gap: "lg" }, [
		kindPicker(h, model),
		...(model.isLimitReached ? [limitNotice(h)] : []),
		h.div(
			[h.Class("grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]")],
			[
				h.div(
					[h.Class("flex min-w-0 flex-col gap-6")],
					[...kindSections(h, model), serviceSection(h, model), notifySection(h, model)],
				),
				h.div([h.Class("lg:sticky lg:top-4 lg:self-start")], [sidePanel(h, model)]),
			],
		),
		actionBar(h, model),
	])
})
