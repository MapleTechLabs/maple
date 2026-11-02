import type { V2AwsConnection } from "@maple/domain/http/v2"
import { countLabel } from "@maple/ui/lib/format"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../ui/button"
import * as Field from "../../ui/field"
import { icon } from "../../ui/icon"
import { input } from "../../ui/input"
import { skeleton } from "../../ui/skeleton"
import {
	type CheckRow,
	flowColumns,
	flowRail,
	foundChips,
	liveChecklist,
	savedBanner,
	statusRow,
	stepCard,
} from "../kit/connect-flow"
import { relativeTime } from "../kit/relative-time"
import { decodeCreateRequest, isSelectionSaved, normalizeAccountId, selectionOf } from "./aws"
import { catalogEntry } from "./catalog"
import { awsStreamOf, isoMs } from "./derive"
import type { FlowStage } from "./flow"
import { awsChosenLabel, awsFlowConnection, awsStatusOf } from "./flow-aws"
import { Message } from "./message"
import type { Model } from "./model"
import { ingestPanel, roleName } from "./view-aws"
import { dataPicker, NAMESPACE_LABEL } from "./view-aws-choose"
import { methodSelect, SMALL, setupBody } from "./view-aws-setup"

// AWS in the connect flow: deploy a read-only role, pick regions and services, then deploy the
// metric stream and watch the first delivery.

type H = HtmlBuilder<Message>

const DOCS_HREF = catalogEntry("aws").docsUrl
const docs = (label: string) => (DOCS_HREF === undefined ? null : { label, href: DOCS_HREF })

const ACCOUNT_IDS: Field.FieldIds = {
	control: "aws-account-id",
	label: "aws-account-id-label",
	error: "aws-account-id-error",
	description: "aws-account-id-description",
}

const at = (h: H, model: Model, timeZone: string, iso: string | null, prefix: string): Html | null => {
	const value = isoMs(iso)
	return value === null ? null : relativeTime(h, { value, nowMs: model.nowMs, timeZone, prefix })
}

const stackRail = (h: H, connection: V2AwsConnection | null): Html =>
	flowRail(h, {
		eyebrow: "What the stack creates",
		items: [
			{
				icon: "KeyIcon",
				title: `IAM role ${connection === null ? "MapleIntegration" : roleName(connection)}`,
				detail: "Read-only: describe, list and metric reads, no data plane access",
			},
			{
				icon: "FingerprintIcon",
				title: "OIDC provider",
				detail: `${connection?.oidc_issuer ?? "Maple's issuer"}, one per account, shared by every Maple connection to it`,
			},
			{
				icon: "LayersIcon",
				title: "One CloudFormation stack",
				detail: "In us-east-1. IAM is global, so the role reads every region. Metric streams go to the regions you pick on Go live",
			},
		],
		trust: "The role trusts only short-lived tokens Maple signs for this connection. Maple stores no access keys. Delete the stack to revoke access.",
		timeNote: "Takes about 2 minutes. Needs IAM admin in the account",
		docs: docs("Setup docs"),
	})

const accountForm = (h: H, model: Model): Html => {
	const card = model.awsCard
	const isValid = Option.isSome(
		decodeCreateRequest({ account_id: normalizeAccountId(card.accountId.value) }),
	)
	const state = Field.stateOf(card.accountId, card.createError !== null)
	return h.form(
		[h.Class("flex flex-col gap-2"), h.OnSubmit(Message.SubmittedAwsAccount())],
		[
			Field.field(h, { className: "items-stretch gap-2", state }, [
				Field.fieldLabel(h, { ids: ACCOUNT_IDS, state }, "AWS account ID"),
				h.div(
					[h.Class("flex flex-wrap items-center gap-2")],
					[
						input(h, {
							id: ACCOUNT_IDS.control,
							className: "min-w-48 flex-1",
							controlClassName: "font-mono tabular-nums",
							fieldState: state,
							attributes: [
								h.Autocomplete("off"),
								h.Placeholder("123456789012"),
								h.InputMode("numeric"),
								...Field.controlAttributes(h, card.accountId, (message) =>
									Message.GotAwsAccountIdMessage({ message }),
								),
								h.AriaLabelledBy(ACCOUNT_IDS.label),
								...(card.createError === null ? [] : [h.AriaInvalid(true)]),
							],
						}),
						button(h, { type: "submit", isDisabled: !isValid, isLoading: card.isCreating }, [
							"Build the role stack",
						]),
						...(awsStatusOf(model)?.connections.length === 0
							? []
							: [
									button(
										h,
										{
											variant: "outline",
											isDisabled: card.isCreating,
											attributes: [h.OnClick(Message.ClickedAwsAddCancel())],
										},
										["Cancel"],
									),
								]),
					],
				),
				card.createError === null
					? Field.fieldDescription(
							h,
							{ ids: ACCOUNT_IDS, state },
							"12 digits, from the account menu at the top right of the AWS console.",
						)
					: Field.fieldError(
							h,
							{ ids: ACCOUNT_IDS, state, attributes: [h.Role("alert")] },
							card.createError,
						),
			]),
		],
	)
}

const ROLE_CARD = {
	icon: "AwsIcon",
	title: "Deploy a read-only role",
	note: "Template in your cloud",
} as const

const newAccount = (h: H, model: Model): ReadonlyArray<Html> => [
	stepCard(h, ROLE_CARD, [
		h.p(
			[h.Class(SMALL)],
			[
				"A CloudFormation stack creates one IAM role that trusts Maple through OIDC. Nothing is stored on our side.",
			],
		),
		accountForm(h, model),
	]),
	model.awsCard.isCreating
		? statusRow(h, { tone: "working", text: "Building the role stack for this account…" })
		: statusRow(h, {
				tone: "idle",
				text: "Enter the account ID. Maple builds its stack, then watches for the role.",
			}),
]

const accountLine = (h: H, connection: V2AwsConnection): Html =>
	h.div(
		[h.Class("flex flex-wrap items-center gap-2 text-sm")],
		[
			icon(h, "CircleCheckIcon", { size: 14, className: "text-severity-info" }),
			h.span([], ["AWS account ID"]),
			h.span([h.Class("font-mono tabular-nums")], [connection.account_id]),
			button(h, { size: "sm", variant: "ghost", attributes: [h.OnClick(Message.ClickedAwsAdd())] }, [
				"Change",
			]),
		],
	)

const checkButton = (h: H, model: Model, connection: V2AwsConnection, label: string): Html =>
	button(
		h,
		{
			size: "sm",
			variant: "outline",
			className: "w-fit",
			isLoading: model.awsCard.checking.some((entry) => entry.id === connection.id),
			attributes: [h.OnClick(Message.ClickedAwsCheck({ id: connection.id }))],
		},
		[label],
	)

const waitingForRole = (
	h: H,
	model: Model,
	connection: V2AwsConnection,
	timeZone: string,
): ReadonlyArray<Html> => {
	const isOpen = model.awsCard.setupId === connection.id
	const checked = at(h, model, timeZone, connection.last_checked_at, "checked")
	return [
		stepCard(h, ROLE_CARD, [
			accountLine(h, connection),
			h.div(
				[h.Class("flex flex-wrap items-center justify-between gap-2")],
				[
					h.h3([h.Class("text-sm")], [`Run the role stack in ${connection.account_id}`]),
					methodSelect(h, model, "role"),
				],
			),
			...(isOpen
				? setupBody(h, model, connection, "role")
				: [
						button(
							h,
							{
								size: "sm",
								className: "w-fit",
								attributes: [h.OnClick(Message.ClickedAwsSetup({ id: connection.id }))],
							},
							["Show the role script"],
						),
					]),
		]),
		connection.last_check_error !== null
			? statusRow(
					h,
					{
						tone: "error",
						text: `Maple can't assume the role in ${connection.account_id}. ${connection.last_check_error}`,
						meta: checked ?? "",
					},
					[checkButton(h, model, connection, "Check again")],
				)
			: isOpen
				? statusRow(
						h,
						{
							tone: "working",
							text: `Waiting for the role in ${connection.account_id}. Maple checks every 10 seconds.`,
							meta: checked ?? "",
						},
						[checkButton(h, model, connection, "Check now")],
					)
				: statusRow(h, {
						tone: "idle",
						text: "Show the script and run it. Maple watches for the role while it is open.",
					}),
	]
}

const roleDeployed = (
	h: H,
	model: Model,
	connection: V2AwsConnection,
	timeZone: string,
): ReadonlyArray<Html> => {
	const verified = at(h, model, timeZone, connection.verified_at, "")
	return [
		stepCard(h, { ...ROLE_CARD, title: "Read-only role deployed" }, [
			h.p(
				[h.Class(SMALL)],
				[`Maple can read account ${connection.account_id}. Nothing else is created until Go live.`],
			),
			h.dl(
				[
					h.Class(
						"grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 rounded-md border border-border p-3 text-sm",
					),
				],
				[
					h.dt([h.Class("text-muted-foreground")], ["Account"]),
					h.dd([h.Class("font-mono tabular-nums")], [connection.account_id]),
					h.dt([h.Class("text-muted-foreground")], ["Role"]),
					h.dd([h.Class("font-mono text-xs [overflow-wrap:anywhere]")], [connection.role_arn]),
				],
			),
			button(
				h,
				{
					size: "sm",
					variant: "outline",
					className: "w-fit",
					attributes: [h.OnClick(Message.ClickedAwsAdd())],
				},
				["Connect another account"],
			),
		]),
		statusRow(h, {
			tone: "ok",
			text: `Role found. Maple assumed ${roleName(connection)} through OIDC.`,
			meta: verified ?? "",
		}),
	]
}

const connectStep = (h: H, model: Model, timeZone: string): Html => {
	const status = awsStatusOf(model)
	const flow = awsFlowConnection(model)
	const connection = flow._tag === "found" ? flow.connection : null
	const main =
		status === null || flow._tag === "loading"
			? [skeleton(h, "h-48 w-full rounded-lg")]
			: !status.available
				? [
						stepCard(h, ROLE_CARD, []),
						statusRow(h, {
							tone: "error",
							text: "AWS can't be connected on this Maple deployment yet.",
						}),
					]
				: connection === null
					? newAccount(h, model)
					: connection.verified_at === null
						? waitingForRole(h, model, connection, timeZone)
						: roleDeployed(h, model, connection, timeZone)
	return flowColumns(h, main, stackRail(h, connection))
}

const selectionRail = (h: H, model: Model, connection: V2AwsConnection): Html => {
	const selection = selectionOf(connection, model.awsCard.selection)
	return flowRail(h, {
		eyebrow: "Your selection",
		items: [
			{
				icon: "GlobeIcon",
				title: countLabel(selection.regions.length, "region"),
				detail: selection.regions.length === 0 ? "None picked" : selection.regions.join(", "),
			},
			{
				icon: "LayersIcon",
				title: countLabel(selection.namespaces.length, "service"),
				detail:
					selection.namespaces.length === 0
						? "None picked"
						: selection.namespaces.map((namespace) => NAMESPACE_LABEL[namespace]).join(", "),
			},
			{
				icon: "ChartLineIcon",
				title: "Streamed metrics",
				detail: "Go live gives you a script that deploys the metric stream in each region",
			},
		],
		trust: "Maple saves the stream on Go live. Leaving after that is safe.",
		docs: docs("What each service sends"),
	})
}

const notConnectedYet = (h: H): Html =>
	flowColumns(
		h,
		[statusRow(h, { tone: "idle", text: "Connect the account first: go back to Connect." })],
		null,
	)

const chooseStep = (h: H, model: Model): Html => {
	const flow = awsFlowConnection(model)
	if (flow._tag !== "found" || flow.connection.verified_at === null) return notConnectedYet(h)
	const connection = flow.connection
	return flowColumns(
		h,
		[
			stepCard(h, { icon: "SlidersIcon", title: "Choose data" }, [
				h.p(
					[h.Class(SMALL)],
					[
						`What account ${connection.account_id} streams to Maple. You can change it later with Edit data.`,
					],
				),
				...dataPicker(h, model, connection),
			]),
		],
		selectionRail(h, model, connection),
	)
}

const streamRail = (h: H): Html =>
	flowRail(h, {
		eyebrow: "Per region, this stack creates",
		items: [
			{
				icon: "ChartLineIcon",
				title: "CloudWatch metric stream",
				detail: "Only the services you chose",
			},
			{
				icon: "PaperPlaneIcon",
				title: "Firehose delivery stream",
				detail: "Posts batches to Maple's ingest over HTTPS",
			},
			{
				icon: "DatabaseIcon",
				title: "S3 bucket for failed batches",
				detail: "Usually empty. Removed with the stack",
			},
		],
		timeNote: "First metrics 2 to 3 minutes after the deploy",
		docs: docs("Metric stream docs"),
	})

/** Go live's deploy card: save the picked stream, then run the script that deploys it. */
const deployCard = (h: H, model: Model, connection: V2AwsConnection): Html => {
	const card = model.awsCard
	const selection = selectionOf(connection, card.selection)
	const regions = selection.regions.join(", ")
	if (!isSelectionSaved(connection, selection))
		return stepCard(h, { icon: "LayersIcon", title: "Deploy the metric stream" }, [
			h.p(
				[h.Class(SMALL)],
				[
					`One stack per region: a CloudWatch metric stream and a Firehose that posts to Maple. Prefilled with ${regions}.`,
				],
			),
			...(card.metricsError === null
				? []
				: [h.p([h.Class("text-xs text-destructive-foreground"), h.Role("alert")], [card.metricsError])]),
			button(
				h,
				{
					className: "w-fit",
					isLoading: card.isSavingMetrics,
					attributes: [h.OnClick(Message.SubmittedAwsMetrics({ id: connection.id }))],
				},
				["Get the stream script"],
			),
		])
	const isOpen = card.setupId === connection.id
	return stepCard(h, { icon: "LayersIcon", title: "Deploy the metric stream" }, [
		h.div(
			[h.Class("flex flex-wrap items-center justify-between gap-2")],
			[h.p([h.Class(SMALL)], [`Prefilled with ${regions}.`]), methodSelect(h, model, "stream")],
		),
		...(isOpen
			? setupBody(h, model, connection, "stream")
			: [
					button(
						h,
						{
							size: "sm",
							className: "w-fit",
							attributes: [h.OnClick(Message.ClickedAwsSetup({ id: connection.id }))],
						},
						["Show the stream script"],
					),
				]),
	])
}

const liveRows = (
	h: H,
	model: Model,
	connection: V2AwsConnection,
	timeZone: string,
): ReadonlyArray<CheckRow> => {
	const stream = awsStreamOf(connection, model.nowMs)
	const regions = connection.metric_stream?.regions ?? []
	const isSaved = isSelectionSaved(connection, selectionOf(connection, model.awsCard.selection))
	const hasDelivered =
		stream._tag === "delivering" ||
		stream._tag === "silent" ||
		(stream._tag === "refused" && stream.receivedAt !== null)
	const since = (value: number, prefix: string) =>
		relativeTime(h, { value, nowMs: model.nowMs, timeZone, prefix })
	const firstDelivery = ((): CheckRow => {
		switch (stream._tag) {
			case "off":
				return { state: "waiting", title: "First delivery" }
			case "waiting":
				return {
					state: "working",
					title: "First delivery",
					detail: "Waiting. Arrives 2 to 3 minutes after each region's stack deploys.",
				}
			case "undelivered":
				return {
					state: "failed",
					title: "No metrics arriving",
					detail: h.span(
						[],
						[
							"Nothing has arrived since the stream was set up ",
							since(stream.since, ""),
							". Run the script again: it deploys the stream in each region.",
						],
					),
				}
			case "refused":
				return { state: "failed", title: "Metrics refused", detail: stream.error }
			case "silent":
				return {
					state: "failed",
					title: "Metrics stopped",
					detail: "CloudWatch stopped sending: check that each region's stack still exists, or run the script again.",
					meta: since(stream.receivedAt, "last"),
				}
			case "delivering":
				return { state: "done", title: "Receiving metrics", meta: since(stream.receivedAt, "latest") }
		}
	})()
	return [
		connection.setup_outdated
			? {
					state: "failed",
					title: "Stack out of date",
					detail: "The deployed stack is older than this connection's setup. Run the script again.",
				}
			: {
					state: "done",
					title: "Role stack applied",
					detail: "In us-east-1. IAM is global, so this covers every region",
				},
		connection.last_check_error !== null
			? { state: "failed", title: "Role refused", detail: connection.last_check_error }
			: {
					state: "done",
					title: "Role assumed",
					detail: `${roleName(connection)} through OIDC`,
					meta: at(h, model, timeZone, connection.last_checked_at, "checked"),
				},
		connection.metric_stream === null || !isSaved
			? { state: "waiting", title: "Metric stream", detail: "Get the stream script above to save it." }
			: {
					state: hasDelivered ? "done" : "working",
					title: `Metric stream in ${countLabel(regions.length, "region")}`,
					detail: hasDelivered
						? null
						: "Waiting for the stack in each region. Run the script above.",
					extra: foundChips(
						h,
						regions.map((region) => ({ label: region })),
					),
				},
		firstDelivery,
	]
}

const liveStep = (h: H, model: Model, timeZone: string): Html => {
	const flow = awsFlowConnection(model)
	if (flow._tag !== "found" || flow.connection.verified_at === null) return notConnectedYet(h)
	const connection = flow.connection
	const isDelivering = awsStreamOf(connection, model.nowMs)._tag === "delivering"
	// A delivering stream still needs the script again when the pick changed since it was saved.
	const needsDeploy =
		!isDelivering || !isSelectionSaved(connection, selectionOf(connection, model.awsCard.selection))
	const chosen = awsChosenLabel(model, connection)
	return flowColumns(
		h,
		[
			savedBanner(
				h,
				`Saved as AWS ${connection.account_id}. Safe to leave; Maple keeps checking.`,
				chosen ?? "",
			),
			...(needsDeploy ? [deployCard(h, model, connection)] : []),
			liveChecklist(h, { rows: liveRows(h, model, connection, timeZone) }),
			...ingestPanel(h, model, connection, timeZone),
		],
		streamRail(h),
	)
}

export const awsFlowView = (h: H, model: Model, stage: FlowStage, timeZone: string): Html =>
	stage === "connect"
		? connectStep(h, model, timeZone)
		: stage === "choose"
			? chooseStep(h, model)
			: liveStep(h, model, timeZone)
