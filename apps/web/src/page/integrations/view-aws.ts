import { AWS_METRICS_OFF } from "@maple/domain/aws"
import type { V2AwsConnection, V2AwsIngest, V2AwsIntegration } from "@maple/domain/http/v2"
import { countLabel, formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { heading } from "../../ui/heading"
import { AppRoute, hrefOf } from "../../route"
import { button, linkButton } from "../../ui/button"
import { badge } from "../../ui/display"
import { errorState } from "../../ui/error-state"
import { icon } from "../../ui/icon"
import type { IconName } from "../../ui/icons.generated"
import { item, itemContent, itemMedia } from "../../ui/item"
import { skeleton } from "../../ui/skeleton"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "../../ui/table"
import { relativeTime } from "../kit/relative-time"
import { integrationIconPlate } from "../infra-integrations/kit/integration-empty"
import { isSelectionSaved, metricStreamOf, selectionOf } from "./aws"
import { AWS_ACCENT } from "./catalog"
import { AWS_CONDITION_LABEL, type AwsConnectionCondition, awsConditionOf, awsStreamOf } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { dataPicker } from "./view-aws-choose"
import { CLOUDSHELL_URL, fileBlock, methodSelect, SMALL, setupBody } from "./view-aws-setup"
import { disconnectConfirm } from "./view-disconnect"
import { externalLink } from "./view-gcp-configure-parts"

// `AwsIntegrationCard`.

type H = HtmlBuilder<Message>

const BRAND = { icon: "AwsIcon", accent: AWS_ACCENT, iconClassName: "text-foreground" } as const

export const AWS_FLOW_HREF = hrefOf(AppRoute.SourcesNew({ search: { integration: "aws" } }))

const CONDITION_VARIANT = {
	setup: "muted",
	failing: "crit",
	"not-receiving": "crit",
	outdated: "warn",
	"metrics-off": "warn",
	stopped: "warn",
	waiting: "muted",
	receiving: "ok",
} satisfies Record<AwsConnectionCondition, "ok" | "warn" | "crit" | "muted">

/** Edit data: the regions and services to stream, saved with the stack's script reopened. */
const editDataPanel = (h: H, model: Model, connection: V2AwsConnection): Html => {
	const card = model.awsCard
	const selection = selectionOf(connection, card.selection)
	return h.form(
		[
			h.Class("flex w-full flex-col gap-4 rounded-md border bg-surface-faint p-3"),
			h.OnSubmit(Message.SubmittedAwsMetrics({ id: connection.id })),
		],
		[
			...dataPicker(h, model, connection),
			...(card.metricsError === null
				? []
				: [h.p([h.Class("text-xs text-destructive-foreground"), h.Role("alert")], [card.metricsError])]),
			h.div(
				[h.Class("flex flex-wrap gap-2")],
				[
					button(
						h,
						{
							size: "sm",
							type: "submit",
							isDisabled:
								Option.isNone(metricStreamOf(selection)) ||
								isSelectionSaved(connection, selection),
							isLoading: card.isSavingMetrics,
						},
						["Save changes"],
					),
					button(
						h,
						{
							size: "sm",
							variant: "outline",
							isDisabled: card.isSavingMetrics,
							attributes: [h.OnClick(Message.ClickedAwsMetricsCancel())],
						},
						["Cancel"],
					),
				],
			),
		],
	)
}

export const roleName = (connection: V2AwsConnection) =>
	connection.role_arn.split("/").at(-1) ?? connection.role_arn

type StepState = "done" | "current" | "warn" | "crit" | "todo"

interface Step {
	readonly title: string
	readonly state: StepState
	readonly detail: ReadonlyArray<Html | string>
	readonly extra?: ReadonlyArray<Html>
}

const STEP_GLYPH = {
	done: { icon: "CircleCheckIcon", className: "text-severity-info" },
	current: { icon: "ClockIcon", className: "text-muted-foreground" },
	warn: { icon: "CircleWarningIcon", className: "text-severity-warn" },
	crit: { icon: "CircleXmarkIcon", className: "text-severity-error" },
} satisfies Record<Exclude<StepState, "todo">, { icon: IconName; className: string }>

const STEP_LABEL = {
	done: "Done",
	current: "In progress",
	warn: "Needs a look",
	crit: "Failing",
	todo: "Not yet",
} satisfies Record<StepState, string>

const stepGlyph = (h: H, state: StepState, index: number): Html =>
	state === "todo"
		? h.span(
				[
					h.Class(
						"flex size-4 shrink-0 items-center justify-center rounded-full border text-3xs tabular-nums text-muted-foreground",
					),
				],
				[String(index + 1)],
			)
		: icon(h, STEP_GLYPH[state].icon, {
				size: 16,
				className: cn("shrink-0", STEP_GLYPH[state].className),
			})

const stepList = (h: H, steps: ReadonlyArray<Step>): Html =>
	h.ol(
		[h.Class("flex w-full flex-col gap-2.5"), h.AriaLabel("Connection status")],
		steps.map((step, index) =>
			h.li(
				[h.Class("flex gap-2.5"), h.DataAttribute("step-state", step.state)],
				[
					h.span([h.Class("mt-0.5")], [stepGlyph(h, step.state, index)]),
					h.div(
						[h.Class("flex min-w-0 flex-1 flex-col gap-1")],
						[
							h.p(
								[
									h.Class(
										cn(
											"text-sm",
											step.state === "todo" ? "text-muted-foreground" : "font-medium",
										),
									),
								],
								[step.title, h.span([h.Class("sr-only")], [`: ${STEP_LABEL[step.state]}`])],
							),
							...(step.detail.length === 0
								? []
								: [
										h.p(
											[
												h.Class(
													cn(
														"text-xs [overflow-wrap:anywhere]",
														step.state === "crit"
															? "text-severity-error"
															: "text-muted-foreground",
													),
												),
												...(step.state === "crit" ? [h.Role("alert")] : []),
											],
											step.detail,
										),
									]),
							...(step.extra ?? []),
						],
					),
				],
			),
		),
	)

const roleStep = (h: H, model: Model, connection: V2AwsConnection, timeZone: string): Step => {
	const checked =
		connection.last_checked_at === null
			? []
			: [
					" · ",
					relativeTime(h, {
						value: connection.last_checked_at,
						nowMs: model.nowMs,
						timeZone,
						prefix: "checked",
					}),
				]
	if (connection.verified_at === null) {
		return {
			title: "Deploy the role",
			state: "current",
			detail: [
				connection.last_check_error ??
					`Run the setup script in AWS CloudShell, signed in to account ${connection.account_id}.`,
				...checked,
			],
		}
	}
	if (connection.last_check_error !== null) {
		return { title: "Role", state: "crit", detail: [connection.last_check_error, ...checked] }
	}
	if (connection.setup_outdated) {
		return {
			title: "Role",
			state: "warn",
			detail: [
				"The deployed stack is older than this connection's setup. Deploy it again.",
				...checked,
			],
		}
	}
	return { title: "Role", state: "done", detail: [`Maple assumes ${roleName(connection)}`, ...checked] }
}

const streamStep = (connection: V2AwsConnection): Step => {
	const stream = connection.metric_stream
	if (stream !== null) {
		const scope = `${stream.regions.join(", ")} · ${countLabel(stream.namespaces.length, "namespace")}`
		// Asked for is not deployed: the setup script deploys each region's stack with the role.
		return connection.verified_at === null
			? {
					title: "Metric stream",
					state: "todo",
					detail: [`${scope}. The setup script deploys it with the role.`],
				}
			: { title: "Metric stream", state: "done", detail: [`${scope}. Each region has its own stack.`] }
	}
	return {
		title: "Metric stream",
		state: connection.verified_at === null ? "todo" : "warn",
		detail: [`${AWS_METRICS_OFF}. Edit data picks the regions and services to stream.`],
	}
}

const deliverySteps = (
	h: H,
	model: Model,
	connection: V2AwsConnection,
	timeZone: string,
): ReadonlyArray<Step> => {
	const at = (value: number, prefix: string) =>
		relativeTime(h, { value, nowMs: model.nowMs, timeZone, prefix })
	const first = "First delivery"
	const latest = "Latest delivery"
	const notYet: Step = { title: latest, state: "todo", detail: [] }
	const stream = awsStreamOf(connection, model.nowMs)
	switch (stream._tag) {
		case "off":
			return [{ title: first, state: "todo", detail: [] }, notYet]
		case "waiting":
			return [
				connection.verified_at === null
					? {
							title: first,
							state: "todo",
							detail: ["Arrives a few minutes after the stack is deployed."],
						}
					: {
							title: first,
							state: "current",
							detail: [
								"Waiting. Metrics arrive a few minutes after the setup script deploys the stream. Run it again if you have not since turning the stream on.",
							],
						},
				notYet,
			]
		case "undelivered":
			return [
				{
					title: first,
					state: "crit",
					detail: [
						"Nothing has arrived since the stream was set up ",
						at(stream.since, ""),
						". Run the setup script again: it deploys the stream in each region.",
					],
				},
				notYet,
			]
		case "refused":
			return stream.receivedAt === null
				? [{ title: first, state: "crit", detail: [stream.error] }, notYet]
				: [
						{ title: first, state: "done", detail: [] },
						{
							title: latest,
							state: "crit",
							detail: [stream.error, " · ", at(stream.receivedAt, "last accepted")],
						},
					]
		case "silent":
			return [
				{ title: first, state: "done", detail: [] },
				{
					title: latest,
					state: "warn",
					detail: [
						at(stream.receivedAt, ""),
						". CloudWatch stopped sending: check that each region's stack still exists, or run the setup script again.",
					],
				},
			]
		case "delivering":
			return [
				{ title: first, state: "done", detail: [] },
				{ title: latest, state: "done", detail: [at(stream.receivedAt, "")] },
			]
	}
}

const INGEST_COLUMNS = ["Namespace", "Region", "Metrics", "Data points", "Resources", "Newest"] as const

/** What the stream stored in the last hour, by namespace and region; regions with nothing are named. */
const ingestBody = (
	h: H,
	model: Model,
	connection: V2AwsConnection,
	ingest: V2AwsIngest,
	timeZone: string,
): ReadonlyArray<Html> => {
	if (ingest.groups.length === 0) {
		return [h.p([h.Class(SMALL)], ["Nothing stored in the last hour."])]
	}
	const namespaces = new Set(ingest.groups.map((group) => group.namespace)).size
	const silentRegions = (connection.metric_stream?.regions ?? []).filter(
		(region) => !ingest.groups.some((group) => group.region === region),
	)
	return [
		h.p(
			[h.Class(SMALL)],
			[
				`${formatNumber(ingest.data_points)} data points from ${countLabel(namespaces, "namespace")} in the last hour`,
				...(ingest.last_point_at === null
					? []
					: [
							" · ",
							relativeTime(h, {
								value: ingest.last_point_at,
								nowMs: model.nowMs,
								timeZone,
								prefix: "newest",
							}),
						]),
			],
		),
		h.div(
			[h.Class("w-full overflow-hidden rounded-md border")],
			[
				table(h, { size: "sm" }, [
					tableHeader(
						h,
						[
							tableRow(
								h,
								INGEST_COLUMNS.map((column) =>
									tableHead(
										h,
										[column],
										column === "Metrics" || column === "Data points" ? "text-right" : undefined,
										[h.Scope("col")],
									),
								),
							),
						],
						{ className: "bg-surface-sunken" },
					),
					tableBody(
						h,
						ingest.groups.map((group) =>
							tableRow(
								h,
								[
									tableCell(h, [group.namespace], "font-mono"),
									tableCell(h, [group.region ?? "unknown"], "font-mono text-muted-foreground"),
									tableCell(h, [formatNumber(group.metrics)], "text-right tabular-nums"),
									tableCell(h, [formatNumber(group.data_points)], "text-right tabular-nums"),
									tableCell(
										h,
										[
											h.span(
												[h.Class("tabular-nums")],
												[formatNumber(group.resources)],
											),
											h.span(
												[h.Class("text-muted-foreground")],
												[
													` · ${group.sample_resources.join(", ")}${group.resources > group.sample_resources.length ? ", ..." : ""}`,
												],
											),
										],
										"whitespace-normal [overflow-wrap:anywhere]",
									),
									tableCell(
										h,
										[
											relativeTime(h, {
												value: group.last_point_at,
												nowMs: model.nowMs,
												timeZone,
												variant: "short",
											}),
										],
										"text-muted-foreground",
									),
								],
								"align-top",
							),
						),
					),
				]),
			],
		),
		...silentRegions.map((region) =>
			h.p(
				[h.Class("text-xs text-severity-warn")],
				[
					`Nothing from ${region} in the last hour. If its resources publish metrics, its stack may not be deployed: run the setup script again.`,
				],
			),
		),
	]
}

export const ingestPanel = (
	h: H,
	model: Model,
	connection: V2AwsConnection,
	timeZone: string,
): ReadonlyArray<Html> => {
	const slot = model.awsCard.ingest[connection.id]
	if (connection.metric_stream === null || connection.verified_at === null || slot === undefined) return []
	const body = (data: V2AwsIngest) => ingestBody(h, model, connection, data, timeZone)
	return [
		h.section(
			[h.Class("flex w-full flex-col gap-2 border-t pt-3"), h.AriaLabel("What Maple receives")],
			[
				heading(h, { level: 4, variant: "subsection" }, ["What Maple receives"]),
				...AsyncData.match(slot.data, {
					onIdle: () => [skeleton(h, "h-16 w-full rounded-md")],
					onLoading: () => [skeleton(h, "h-16 w-full rounded-md")],
					onFailure: (failure) => [
						errorState(h, {
							failure,
							title: "Couldn't read what this account sends",
							onRetry: Message.ClickedRetryStatus({ name: "aws" }),
						}),
					],
					onStale: ({ data }) => body(data),
					onRefreshing: body,
					onSuccess: body,
				}),
			],
		),
	]
}

const connectionRow = (h: H, model: Model, connection: V2AwsConnection, timeZone: string): Html => {
	const condition = awsConditionOf(connection, model.nowMs)
	const isChecking = model.awsCard.checking.some((entry) => entry.id === connection.id)
	const isOpen = model.awsCard.setupId === connection.id
	const isEditing = model.awsCard.metricsId === connection.id
	const action = (
		label: string,
		message: Message,
		extra: Readonly<{ isLoading?: boolean; isExpanded?: boolean }> = {},
	) =>
		button(
			h,
			{
				size: "sm",
				variant: extra.isExpanded === true ? "secondary" : "outline",
				isLoading: extra.isLoading,
				attributes: [
					h.OnClick(message),
					...(extra.isExpanded === undefined ? [] : [h.AriaExpanded(extra.isExpanded)]),
				],
			},
			[label],
		)
	return item(h, { variant: "card", className: "items-start gap-4 p-4" }, [
		itemMedia(h, {}, [integrationIconPlate(h, BRAND)]),
		itemContent(
			h,
			[
				h.div(
					[h.Class("flex flex-wrap items-center gap-2")],
					[
						heading(
							h,
							{ level: 3, variant: "section", className: "font-mono tabular-nums" },
							[connection.account_id],
						),
						badge(h, { variant: CONDITION_VARIANT[condition] }, [AWS_CONDITION_LABEL[condition]]),
					],
				),
				stepList(h, [
					roleStep(h, model, connection, timeZone),
					streamStep(connection),
					...deliverySteps(h, model, connection, timeZone),
				]),
				...ingestPanel(h, model, connection, timeZone),
				h.div(
					[h.Class("flex flex-wrap gap-2 pt-1")],
					[
						// Reconnect deploys the stack again: it finishes a setup and updates an old one.
						action(
							"Reconnect",
							isOpen
								? Message.ClickedAwsSetupClose()
								: Message.ClickedAwsSetup({ id: connection.id }),
							{ isExpanded: isOpen },
						),
						...(connection.verified_at === null
							? []
							: [
									action(
										"Edit data",
										isEditing
											? Message.ClickedAwsMetricsCancel()
											: Message.ClickedAwsMetrics({ id: connection.id }),
										{ isExpanded: isEditing },
									),
								]),
						action("Sync now", Message.ClickedAwsCheck({ id: connection.id }), {
							isLoading: isChecking,
						}),
						action("Disconnect", Message.ClickedAwsDisconnect({ id: connection.id })),
					],
				),
				...(isEditing ? [editDataPanel(h, model, connection)] : []),
				...(isOpen ? [setupPanel(h, model, connection)] : []),
			],
			"gap-3",
		),
	])
}

const setupPanel = (h: H, model: Model, connection: V2AwsConnection): Html => {
	const waiting = connection.verified_at === null
	return h.div(
		[h.Class("mt-2 flex w-full flex-col gap-3 rounded-md border bg-surface-faint p-3")],
		[
			h.div(
				[h.Class("flex flex-wrap items-center gap-2")],
				[
					heading(
						h,
						{ level: 4, variant: "subsection" },
						[waiting ? "Deploy the stack" : "Deploy the stack again"],
					),
					h.span([h.Class("ml-auto")], [methodSelect(h, model, "role")]),
				],
			),
			...setupBody(h, model, connection, "role"),
			h.p(
				[h.Class(SMALL)],
				[
					waiting
						? "Maple checks the connection every 10 seconds while this is open."
						: "After changing what Maple reads, deploy the stack again and sync.",
				],
			),
		],
	)
}

/** Each stack a disconnect left in AWS, with the script that deletes it, until dismissed. */
const removedPanel = (h: H, model: Model, focusId: string | null): ReadonlyArray<Html> =>
	model.awsCard.removed
		.filter((stack) => focusId === null || stack.connectionId === focusId)
		.map((stack) =>
			h.div(
				[h.Class("flex flex-col gap-3 rounded-md border p-4")],
				[
					h.div(
						[h.Class("flex flex-wrap items-center gap-2")],
						[
							heading(
								h,
								{ level: 4, variant: "subsection" },
								[`Delete the stack in ${stack.accountId}`],
							),
							h.span(
								[h.Class("ml-auto")],
								[
									button(
										h,
										{
											size: "sm",
											variant: "ghost",
											attributes: [
												h.OnClick(
													Message.DismissedAwsRemoved({
														connectionId: stack.connectionId,
													}),
												),
											],
										},
										["Dismiss"],
									),
								],
							),
						],
					),
					h.p(
						[h.Class(SMALL)],
						[
							"Maple no longer assumes the role, but it exists until you delete its stack. Paste this into ",
							externalLink(h, CLOUDSHELL_URL, "AWS CloudShell"),
							".",
						],
					),
					fileBlock(
						h,
						model,
						`aws-cleanup-${stack.connectionId}`,
						"cleanup.sh",
						stack.cleanupScript,
					),
				],
			),
		)

/** Mounted once: by the card on the integrations page, by the header on a source page. */
export const awsDisconnectDialog = (h: H, model: Model): Html => {
	const status = Option.getOrNull(AsyncData.getData(model.statuses.aws.data))
	const connection = status?.connections.find((entry) => entry.id === model.awsCard.disconnectId)
	return disconnectConfirm(h, {
		provider: "aws",
		slotId: "aws-disconnect",
		model: model.awsCard.disconnectDialog,
		toParentMessage: (message) => Message.GotAwsDisconnectDialogMessage({ message }),
		subject: `AWS account ${connection?.account_id ?? ""}`,
		isPending: model.awsCard.isDisconnecting,
		onConfirm: Message.ConfirmedAwsDisconnect(),
	})
}

/** The connection a source page focuses on (`focusId`), or every connection. */
const connectedView = (
	h: H,
	model: Model,
	status: V2AwsIntegration,
	timeZone: string,
	focusId: string | null,
): Html => {
	const shown = status.connections.filter((connection) => focusId === null || connection.id === focusId)
	return h.div(
		[h.Class("flex flex-col gap-3")],
		[
			...removedPanel(h, model, focusId),
			...shown.map((connection) => connectionRow(h, model, connection, timeZone)),
			...(focusId !== null || !status.available
				? []
				: [
						h.div(
							[],
							[
								linkButton(h, { size: "sm", variant: "outline", href: AWS_FLOW_HREF }, [
									icon(h, "PlusIcon", { size: 14 }),
									"Add another account",
								]),
							],
						),
					]),
			...(focusId === null ? [awsDisconnectDialog(h, model)] : []),
		],
	)
}

/** A source whose connection was removed: the way back is the connect flow. */
const reconnectLink = (h: H): Html =>
	h.p(
		[h.Class(SMALL)],
		[
			"This AWS account is no longer connected. ",
			h.a(
				[h.Href(AWS_FLOW_HREF), h.Class("text-foreground underline-offset-4 hover:underline active:underline")],
				["Reconnect"],
			),
		],
	)

const byStatus = (
	h: H,
	model: Model,
	status: V2AwsIntegration,
	timeZone: string,
	focusId: string | null,
): Html =>
	status.connections.some((connection) => focusId === null || connection.id === focusId)
		? connectedView(h, model, status, timeZone, focusId)
		: h.div([h.Class("flex flex-col gap-3")], [...removedPanel(h, model, focusId), reconnectLink(h)])

export const awsCard = (h: H, model: Model, timeZone: string, focusId: string | null): Html =>
	AsyncData.match(model.statuses.aws.data, {
		onIdle: () => skeleton(h, "h-32 w-full rounded-md"),
		onLoading: () => skeleton(h, "h-32 w-full rounded-md"),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "Couldn't load the AWS integration",
				onRetry: Message.ClickedRetryStatus({ name: "aws" }),
			}),
		onStale: ({ data }) => byStatus(h, model, data, timeZone, focusId),
		onRefreshing: (data) => byStatus(h, model, data, timeZone, focusId),
		onSuccess: (data) => byStatus(h, model, data, timeZone, focusId),
	})
