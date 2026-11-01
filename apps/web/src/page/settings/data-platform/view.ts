import type {
	ClickHouseTableDiffEntry,
	OrgClickHouseApplySchemaStatus,
	OrgClickHouseSchemaDiffResponse,
	OrgClickHouseSettingsResponse,
} from "@maple/domain/http"
import { EMPTY_VALUE, formatNumber, formatStorageBytes } from "@maple/ui/lib/format"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import {
	columnDriftResolvedByApply,
	schemaApplyPlan,
	type SchemaDiffStatus,
	schemaDiffCounts,
} from "../../../components/settings/schema-apply-plan"
import { formatTimestampInTimezone } from "@maple/web-data/lib/timezone-format"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { confirmDialog } from "../../../ui/confirm-dialog"
import { errorState } from "../../../ui/error-state"
import { field, fieldDescription, type FieldIds, fieldLabel, input, type FieldState } from "../../../ui/field"
import { icon, type IconName } from "../../../ui/icon"
import { panel } from "../../../ui/panel"
import { refreshButton } from "../../../ui/refresh-button"
import { skeleton, skeletonList } from "../../../ui/skeleton"
import { truncatedId } from "../../../ui/truncated-id"
import { relativeTime } from "../../kit/relative-time"
import { statRail, statRailItem } from "../../kit/stat-rail"
import { settingsSection, settingsSections } from "../kit/section"
import { type ConnectionField, Message, type Model, type Totals } from "./model"
import { draftOf, isRunActive } from "./update"
import { statusDot } from "../../../ui/status-dot"

type H = HtmlBuilder<Message>
type Inputs = Readonly<{ nowMs: number; timeZone: string }>

const IDLE: FieldState = {
	isInvalid: false,
	isDirty: false,
	isFilled: false,
	isFocused: false,
	isTouched: false,
}
const ids = (name: string, hasDescription = false): FieldIds => {
	const base = { control: `ch-${name}`, label: `ch-${name}-label`, error: `ch-${name}-error` }
	return hasDescription ? { ...base, description: `ch-${name}-description` } : base
}

const isHttpUrl = (value: string): boolean => URL.canParse(value.trim()) && /^https?:/i.test(value.trim())

// CONNECTION

const connectionStatus = (h: H, settings: OrgClickHouseSettingsResponse, inputs: Inputs): Html => {
	if (!settings.configured)
		return h.div(
			[h.Class("flex items-center gap-2 border-b px-4 py-3 text-xs")],
			[
				statusDot(h, { tone: "neutral" }),
				h.span([], ["Not connected"]),
				h.span([h.Class("text-muted-foreground")], ["· Queries use Maple's warehouse"]),
			],
		)
	const isFailing = settings.syncStatus === "error"
	return h.div(
		[h.Class("flex flex-col gap-1 border-b px-4 py-3 text-xs")],
		[
			h.div(
				[h.Class("flex items-center gap-2")],
				[
					statusDot(h, { tone: isFailing ? "crit" : "ok" }),
					h.span([], [isFailing ? "Connection error" : "Connected"]),
					...(settings.lastSyncAt === null
						? []
						: [
								h.span(
									[h.Class("text-muted-foreground")],
									[
										"· last checked ",
										relativeTime(h, {
											value: settings.lastSyncAt,
											nowMs: inputs.nowMs,
											timeZone: inputs.timeZone,
										}),
									],
								),
							]),
				],
			),
			...(isFailing && settings.lastSyncError !== null
				? [h.p([h.Class(cn("break-words pl-3.5", TONE_TEXT.crit))], [settings.lastSyncError])]
				: []),
		],
	)
}

const textField = (
	h: H,
	options: Readonly<{
		name: string
		label: string
		value: string
		placeholder?: string
		type?: string
		isDisabled: boolean
		description?: string
		onInput: (value: string) => Message
	}>,
): Html => {
	const state: FieldState = { ...IDLE, isFilled: options.value !== "" }
	const fieldIds = ids(options.name, options.description !== undefined)
	return field(h, { state }, [
		fieldLabel(h, { ids: fieldIds, state }, options.label),
		input(h, {
			ids: fieldIds,
			state,
			attributes: [
				...(options.type === undefined ? [] : [h.Type(options.type)]),
				...(options.placeholder === undefined ? [] : [h.Placeholder(options.placeholder)]),
				h.Value(options.value),
				...(options.isDisabled ? [h.Disabled(true)] : []),
				h.OnInput(options.onInput),
			],
		}),
		...(options.description === undefined
			? []
			: [fieldDescription(h, { ids: fieldIds, state }, options.description)]),
	])
}

const connectionPanel = (
	h: H,
	model: Model,
	settings: OrgClickHouseSettingsResponse,
	inputs: Inputs,
): Html => {
	const draft = draftOf(model)
	const isBusy = model.isSaving || model.isDisconnecting
	const isValid = isHttpUrl(draft.url) && draft.user.trim() !== "" && draft.database.trim() !== ""
	const onField = (fieldName: ConnectionField) => (value: string) =>
		Message.ChangedConnection({ field: fieldName, value })
	return panel(h, { className: "overflow-hidden" }, [
		connectionStatus(h, settings, inputs),
		h.div(
			[h.Class("flex flex-col gap-4 p-4")],
			[
				textField(h, {
					name: "url",
					label: "ClickHouse URL",
					placeholder: "https://your-clickhouse.example.com:8123",
					value: draft.url,
					isDisabled: isBusy,
					description: "HTTP interface URL (port 8123 by default).",
					onInput: onField("url"),
				}),
				h.div(
					[h.Class("grid gap-3 sm:grid-cols-2")],
					[
						textField(h, {
							name: "user",
							label: "User",
							value: draft.user,
							isDisabled: isBusy,
							onInput: onField("user"),
						}),
						textField(h, {
							name: "database",
							label: "Database",
							value: draft.database,
							isDisabled: isBusy,
							onInput: onField("database"),
						}),
					],
				),
				textField(h, {
					name: "password",
					label: "Password",
					type: "password",
					placeholder: settings.configured
						? "Leave blank to keep the current password"
						: "Optional",
					value: model.password,
					isDisabled: isBusy,
					onInput: (value) => Message.ChangedPassword({ value }),
				}),
			],
		),
		h.div(
			[
				h.Class(
					"bg-surface-sunken flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t px-4 py-3",
				),
			],
			[
				settings.configured
					? button(
							h,
							{
								variant: "outline",
								size: "sm",
								isDisabled: isBusy,
								attributes: [h.OnClick(Message.ClickedDisconnect())],
							},
							["Disconnect"],
						)
					: h.span([], []),
				h.div(
					[h.Class("flex items-center gap-3")],
					[
						h.span(
							[h.Class("text-muted-foreground text-xs")],
							["Saving runs a test query first."],
						),
						button(
							h,
							{
								size: "sm",
								isLoading: model.isSaving,
								isDisabled: isBusy || !isValid,
								attributes: [h.OnClick(Message.ClickedSave())],
							},
							["Save and test"],
						),
					],
				),
			],
		),
		confirmDialog(h, {
			slotId: "data-platform-disconnect-dialog",
			model: model.disconnectDialog,
			toParentMessage: (message) => Message.GotDisconnectDialogMessage({ message }),
			title: "Disconnect your ClickHouse?",
			description:
				"This organization goes back to Maple's managed warehouse. Tables on your cluster are not touched: disconnecting only removes Maple's pointer to it.",
			confirmLabel: "Disconnect",
			onConfirm: Message.ClickedConfirmDisconnect(),
			isPending: model.isDisconnecting,
		}),
	])
}

// SCHEMA

const STATUS_COUNTS: ReadonlyArray<{ status: SchemaDiffStatus; label: string; tone: string }> = [
	{ status: "up_to_date", label: "Up to date", tone: "text-foreground" },
	{ status: "missing", label: "Missing", tone: TONE_TEXT.crit },
	{ status: "drifted", label: "Drifted", tone: TONE_TEXT.warn },
	{ status: "wrong_kind", label: "Wrong kind", tone: TONE_TEXT.warn },
]
const DRIFT_LABEL = {
	missing: "Missing column",
	extra: "Extra column",
	type_mismatch: "Type mismatch",
} as const
const kindLabel = (kind: ClickHouseTableDiffEntry["kind"]) =>
	kind === "materialized_view" ? "view" : "table"

const entrySummary = (entry: ClickHouseTableDiffEntry): { text: string; tone: string } => {
	switch (entry.status) {
		case "missing":
			return { text: "Missing, created on apply", tone: TONE_TEXT.crit }
		case "wrong_kind":
			return { text: `Exists as a ${kindLabel(entry.actualKind)}, fix manually`, tone: TONE_TEXT.warn }
		case "drifted":
			return {
				text: `Drifted, ${entry.columnDrifts.length} ${entry.columnDrifts.length === 1 ? "column" : "columns"}`,
				tone: TONE_TEXT.warn,
			}
		case "up_to_date":
			return { text: "Up to date", tone: "text-muted-foreground" }
	}
}

const diffRow = (h: H, model: Model, entry: ClickHouseTableDiffEntry): Html => {
	const summary = entrySummary(entry)
	const head = [
		icon(h, entry.status === "missing" ? "CircleXmarkIcon" : "CircleWarningIcon", {
			size: 14,
			className: cn("shrink-0", summary.tone),
		}),
		h.span([h.Class("truncate font-mono")], [entry.name]),
		h.span([h.Class("text-muted-foreground")], [kindLabel(entry.kind)]),
		h.span([h.Class(cn("ml-auto shrink-0", summary.tone))], [summary.text]),
	]
	if (entry.status !== "drifted")
		return h.div(
			[h.Key(entry.name), h.Class("flex items-center gap-2 border-b py-2 pr-3 pl-8.5 text-xs")],
			head,
		)
	const isExpanded = !model.collapsedDrift.includes(entry.name)
	return h.div(
		[h.Key(entry.name), h.Class("border-b")],
		[
			h.button(
				[
					h.Type("button"),
					h.AriaExpanded(isExpanded),
					h.OnClick(Message.ToggledDrift({ name: entry.name })),
					h.Class(
						"hover:bg-surface-sunken active:bg-surface-sunken flex w-full items-center gap-2 px-3 py-2 text-left text-xs",
					),
				],
				[
					icon(h, "ChevronRightIcon", {
						size: 14,
						className: cn(
							"text-muted-foreground shrink-0 transition-transform",
							isExpanded && "rotate-90",
						),
					}),
					...head,
				],
			),
			...(isExpanded
				? [
						h.ul(
							[h.Class("bg-background mx-3 mb-3 divide-y overflow-hidden rounded-md border")],
							entry.columnDrifts.map((drift) => {
								const isResolved = columnDriftResolvedByApply(entry.kind, drift)
								return h.li(
									[
										h.Key(`${drift.kind}:${drift.column}`),
										h.Class(
											"flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs",
										),
									],
									[
										h.span(
											[h.Class("text-muted-foreground w-28 shrink-0")],
											[DRIFT_LABEL[drift.kind]],
										),
										h.span(
											[h.Class("min-w-0 font-mono break-all")],
											[
												drift.kind === "missing"
													? `${drift.column} ${drift.expectedType}`
													: drift.kind === "extra"
														? `${drift.column} ${drift.actualType}`
														: `${drift.column} ${drift.actualType} vs ${drift.expectedType}`,
											],
										),
										h.span(
											[
												h.Class(
													cn(
														"ml-auto shrink-0",
														isResolved ? "text-muted-foreground" : TONE_TEXT.warn,
													),
												),
											],
											[isResolved ? "Added on apply" : "Fix manually"],
										),
									],
								)
							}),
						),
					]
				: []),
		],
	)
}

const schemaDiff = (h: H, model: Model, diff: OrgClickHouseSchemaDiffResponse): ReadonlyArray<Html> => {
	const counts = schemaDiffCounts(diff.entries)
	const needsWork = diff.entries.filter((entry) => entry.status !== "up_to_date")
	const upToDate = diff.entries.filter((entry) => entry.status === "up_to_date")
	return [
		h.dl(
			[h.Class("grid grid-cols-2 border-b sm:grid-cols-4")],
			STATUS_COUNTS.map(({ status, label, tone }, index) =>
				h.div(
					[
						h.Key(status),
						h.Class(
							cn(
								"flex flex-col gap-1 px-4 py-3",
								index > 0 && "sm:border-l",
								index % 2 === 1 && "border-l",
							),
						),
					],
					[
						h.dt([h.Class("text-muted-foreground text-2xs font-medium")], [label]),
						h.dd(
							[
								h.Class(
									cn(
										"font-mono text-xl font-semibold",
										counts[status] === 0 ? "text-muted-foreground" : tone,
									),
								),
							],
							[String(counts[status])],
						),
					],
				),
			),
		),
		...(needsWork.length === 0 && diff.entries.length > 0
			? [
					h.p(
						[h.Class("text-muted-foreground border-b px-4 py-3 text-xs")],
						["Every table and view matches what Maple expects."],
					),
				]
			: []),
		...needsWork.map((entry) => diffRow(h, model, entry)),
		...(upToDate.length === 0
			? []
			: [
					h.button(
						[
							h.Type("button"),
							h.AriaExpanded(model.showUpToDate),
							h.OnClick(Message.ToggledUpToDate()),
							h.Class(
								"hover:bg-surface-sunken active:bg-surface-sunken flex w-full items-center gap-2 border-b px-3 py-2 text-left text-xs",
							),
						],
						[
							icon(h, "ChevronRightIcon", {
								size: 14,
								className: cn(
									"text-muted-foreground shrink-0 transition-transform",
									model.showUpToDate && "rotate-90",
								),
							}),
							icon(h, "CircleCheckIcon", {
								size: 14,
								className: cn("shrink-0", TONE_TEXT.info),
							}),
							h.span(
								[h.Class("text-muted-foreground")],
								[
									model.showUpToDate ? "Hide" : "Show",
									" up-to-date tables and views (",
									String(upToDate.length),
									")",
								],
							),
						],
					),
					...(model.showUpToDate
						? [
								h.ul(
									[h.Class("divide-y border-b")],
									upToDate.map((entry) =>
										h.li(
											[
												h.Key(entry.name),
												h.Class("flex items-center gap-2 py-1.5 pr-3 pl-11 text-xs"),
											],
											[
												h.span([h.Class("font-mono")], [entry.name]),
												h.span(
													[h.Class("text-muted-foreground")],
													[kindLabel(entry.kind)],
												),
											],
										),
									),
								),
							]
						: []),
				]),
	]
}

const applyRunStatus = (h: H, status: OrgClickHouseApplySchemaStatus | null): ReadonlyArray<Html> => {
	if (status === null) return []
	const isRunning = status.status === "queued" || status.status === "running"
	const steps =
		status.stepsTotal !== null && status.stepsDone !== null
			? ` (${status.stepsDone}/${status.stepsTotal})`
			: ""
	return [
		...(isRunning
			? [
					h.p(
						[h.Class("text-muted-foreground border-b px-4 py-3 text-xs")],
						[
							status.phase ?? "Applying schema",
							steps,
							status.currentMigration !== null ? ` · migration ${status.currentMigration}` : "",
							". Runs in the background, safe to leave this page.",
						],
					),
				]
			: []),
		...(status.status === "failed" && status.errorMessage !== null
			? [
					h.p(
						[h.Class(cn("border-b px-4 py-3 text-xs break-words", TONE_TEXT.crit))],
						["Last apply failed: ", status.errorMessage],
					),
				]
			: []),
		...(!isRunning && status.skipped.length > 0
			? [
					h.div(
						[h.Class("flex flex-col gap-1.5 border-b px-4 py-3 text-xs")],
						[
							h.p(
								[h.Class(TONE_TEXT.warn)],
								[
									"The last apply skipped",
									" ",
									status.skipped.length === 1
										? "one step"
										: `${status.skipped.length} steps`,
									". Apply again once the cause is fixed.",
								],
							),
							h.ul(
								[h.Class("flex flex-col gap-1")],
								status.skipped.map((item) =>
									h.li(
										[h.Key(item.id), h.Class("text-muted-foreground")],
										[
											h.span([h.Class("text-foreground font-mono")], [item.id]),
											": ",
											item.reason,
										],
									),
								),
							),
						],
					),
				]
			: []),
	]
}

const planList = (h: H, plan: ReturnType<typeof schemaApplyPlan>): Html => {
	const groups = [
		{ label: "Create", items: plan.create },
		{
			label: "Add columns",
			items: plan.addColumns.map((table) => `${table.name}: ${table.columns.join(", ")}`),
		},
		{
			label: "Not resolved by apply (fix manually)",
			items: plan.unresolved.map((entry) => `${entry.name}: ${entry.reason}`),
		},
	].filter((group) => group.items.length > 0)
	if (groups.length === 0)
		return h.p(
			[h.Class("text-muted-foreground text-xs")],
			["No tables or columns to add; only pending migrations run."],
		)
	return h.div(
		[h.Class("max-h-56 space-y-3 overflow-y-auto text-xs")],
		groups.map((group) =>
			h.div(
				[h.Key(group.label), h.Class("space-y-1")],
				[
					h.p(
						[h.Class("text-muted-foreground")],
						[group.label, " (", String(group.items.length), ")"],
					),
					h.ul(
						[h.Class("space-y-0.5 font-mono")],
						group.items.map((item) => h.li([h.Key(item), h.Class("break-all")], [item])),
					),
				],
			),
		),
	)
}

const schemaSection = (h: H, model: Model, settings: OrgClickHouseSettingsResponse, inputs: Inputs): Html => {
	const diff = AsyncData.getOrElse(model.diff, () => null)
	const status = AsyncData.getOrElse(model.applyStatus, () => null)
	const isApplying = model.isStarting || isRunActive(model)
	const plan = diff === null ? null : schemaApplyPlan(diff.entries)
	const isBehind = diff !== null && diff.appliedSchemaVersion !== diff.expectedSchemaVersion
	const hasWork = plan !== null && (plan.create.length > 0 || plan.addColumns.length > 0 || isBehind)
	return settingsSection(
		h,
		{
			id: "data-platform-schema-heading",
			title: "Schema",
			description: ["Your cluster compared with the schema Maple expects."],
			padded: false,
			actions: refreshButton(h, {
				variant: "outline",
				size: "sm",
				label: "Refresh diff",
				onRefresh: Message.ClickedRefreshDiff(),
				isPending: AsyncData.isRefreshing(model.diff),
				isDisabled: isApplying,
			}),
		},
		[
			...AsyncData.matchData(model.diff, {
				onEmpty: () => [
					skeletonList(h, { rows: 3, rowClassName: "h-9", gap: "2", className: "p-4" }),
				],
				onFailure: (failure) => [
					errorState(h, {
						failure,
						title: "Couldn't read your cluster's schema. Check that the connection works.",
						variant: "inline",
						className: "m-4",
					}),
				],
				onData: (data) => schemaDiff(h, model, data),
			}),
			...applyRunStatus(h, status),
			h.div(
				[
					h.Class(
						"bg-surface-sunken flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t px-4 py-3",
					),
				],
				[
					h.span(
						[h.Class("text-muted-foreground text-xs")],
						settings.schemaVersion !== null && settings.lastSyncAt !== null
							? [
									"Last applied version",
									" ",
									truncatedId(h, {
										value: settings.schemaVersion,
										kind: "sha",
										length: 10,
									}),
									" on",
									" ",
									formatTimestampInTimezone(settings.lastSyncAt, {
										timeZone: inputs.timeZone,
										withYear: true,
									}),
								]
							: ["Schema never applied"],
					),
					button(
						h,
						{
							size: "sm",
							isLoading: isApplying,
							isDisabled: isApplying || !hasWork,
							attributes: [h.OnClick(Message.ClickedReviewApply())],
						},
						["Review and apply"],
					),
				],
			),
			confirmDialog(h, {
				slotId: "data-platform-apply-dialog",
				model: model.applyDialog,
				toParentMessage: (message) => Message.GotApplyDialogMessage({ message }),
				tone: "default",
				icon: icon(h, "AlertWarningIcon", { size: 20, className: "text-severity-warn" }),
				title: "Apply the schema to your cluster?",
				description: [
					"This runs DDL against",
					" ",
					h.span([h.Class("font-mono")], [settings.chDatabase ?? ""]),
					" on your cluster. Pending Maple migrations run first and can rebuild Maple's own views and backfill data. The snapshot pass then only adds what is listed below.",
				],
				confirmLabel: "Apply schema",
				onConfirm: Message.ClickedConfirmApply(),
				isPending: model.isStarting,
				...(plan !== null && { body: [planList(h, plan)] }),
			}),
		],
	)
}

// USAGE

const STATS: ReadonlyArray<{
	key: keyof Totals
	label: string
	icon: IconName
	tone: string
	format: (n: number) => string
}> = [
	{ key: "logs", label: "Logs", icon: "FileIcon", tone: "text-chart-2", format: formatNumber },
	{ key: "traces", label: "Traces", icon: "PulseIcon", tone: "text-chart-5", format: formatNumber },
	{ key: "metrics", label: "Metrics", icon: "ChartLineIcon", tone: "text-chart-3", format: formatNumber },
	{
		key: "dataSize",
		label: "Storage",
		icon: "DatabaseIcon",
		tone: "text-chart-1",
		format: formatStorageBytes,
	},
]

const usageSection = (h: H, model: Model): Html => {
	const item = (stat: (typeof STATS)[number], value: Html | string) =>
		statRailItem(h, {
			compact: true,
			eyebrow: stat.label,
			value,
			action: icon(h, stat.icon, {
				size: 14,
				className: cn("shrink-0", stat.tone),
				attributes: [h.AriaHidden(true)],
			}),
		})
	return settingsSection(
		h,
		{
			id: "data-platform-usage-heading",
			title: "Stored data",
			description: ["Totals from your organization's warehouse, all time."],
			framed: false,
		},
		[
			statRail(
				h,
				{},
				AsyncData.matchData(model.usage, {
					onEmpty: () => STATS.map((stat) => item(stat, skeleton(h, "h-[26px] w-24"))),
					onFailure: () =>
						STATS.map((stat) =>
							item(stat, h.span([h.Class("text-sm text-muted-foreground")], [EMPTY_VALUE])),
						),
					onData: (totals) => STATS.map((stat) => item(stat, stat.format(totals[stat.key]))),
				}),
			),
		],
	)
}

export const view = Submodel.defineView<Model, Message, Inputs>((model, inputs, h) => {
	const settings = AsyncData.getOrElse(model.settings, () => null)
	return settingsSections(h, [
		settingsSection(
			h,
			{
				id: "data-platform-connection-heading",
				title: "Connection",
				description: ["Read queries for this organization run against your own ClickHouse server."],
				framed: false,
			},
			[
				AsyncData.matchData(model.settings, {
					onEmpty: () => skeleton(h, "h-72 w-full rounded-md"),
					onFailure: (failure) => errorState(h, { failure, title: "Couldn't load the connection" }),
					onData: (data) => connectionPanel(h, model, data, inputs),
				}),
			],
		),
		...(settings?.configured === true ? [schemaSection(h, model, settings, inputs)] : []),
		usageSection(h, model),
	])
})
