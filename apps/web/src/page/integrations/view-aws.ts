import { AWS_METRICS_OFF, AWS_NO_DELIVERY } from "@maple/domain/aws"
import type { V2AwsConnection, V2AwsIngest, V2AwsIntegration, V2AwsSetup } from "@maple/domain/http/v2"
import { countLabel, formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../ui/button"
import { confirmDialog } from "../../ui/confirm-dialog"
import * as CopyButton from "../../ui/copy-button"
import { badge } from "../../ui/display"
import { errorState } from "../../ui/error-state"
import * as Field from "../../ui/field"
import { icon } from "../../ui/icon"
import type { IconName } from "../../ui/icons.generated"
import { input } from "../../ui/input"
import { item, itemContent, itemMedia } from "../../ui/item"
import { skeleton } from "../../ui/skeleton"
import { relativeTime } from "../kit/relative-time"
import {
	integrationEmpty,
	integrationEmptyCard,
	integrationEmptyFeatures,
	integrationEmptyFooter,
	integrationEmptyHint,
	integrationEmptyMedia,
	integrationIconPlate,
} from "../infra-integrations/kit/integration-empty"
import {
	type AwsSetupMethod,
	decodeCreateRequest,
	METRIC_REGIONS_HINT,
	metricStreamOf,
	normalizeAccountId,
} from "./aws"
import { codeBlock } from "../settings/kit/code-block"
import { segmentedSelect } from "../../ui/segmented-select"
import { externalLink } from "./view-gcp-configure-parts"
import { AWS_ACCENT } from "./catalog"
import { AWS_CONDITION_LABEL, type AwsConnectionCondition, awsConditionOf, awsStreamOf } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"

// `AwsIntegrationCard`.

type H = HtmlBuilder<Message>

const BRAND = { icon: "AwsIcon", accent: AWS_ACCENT, iconClassName: "text-foreground" } as const
// The stack's region (`stack_region`, always us-east-1): the console opens where the scripts deploy.
const CLOUDSHELL_URL = "https://us-east-1.console.aws.amazon.com/cloudshell/home?region=us-east-1"
const CREATE_STACK_URL =
	"https://us-east-1.console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/create"
const SMALL = "text-xs text-muted-foreground"

const FEATURES = [
	{
		label: "Access",
		title: "One read-only role",
		description: "A CloudFormation stack creates it. Maple reads metadata, never your data.",
	},
	{
		label: "Security",
		title: "No stored secret",
		description: "The role trusts only short-lived tokens Maple signs for this connection.",
	},
	{
		label: "Modules",
		title: "One role for every module",
		description: "Metrics, inventory, security and cost each add their own policy to the same role.",
	},
]

const ACCOUNT_IDS: Field.FieldIds = {
	control: "aws-account-id",
	label: "aws-account-id-label",
	error: "aws-account-id-error",
}

const REGION_IDS: Field.FieldIds = {
	control: "aws-metric-regions",
	label: "aws-metric-regions-label",
	error: "aws-metric-regions-error",
	description: "aws-metric-regions-description",
}

/** The regions a metric stream reads, typed as codes; `actions` sit beside the input. */
const regionsField = (
	h: H,
	options: Readonly<{
		ids: Field.FieldIds
		label: string
		field: Field.Model
		toMessage: (message: Field.Message) => Message
		error: string | null
		actions: ReadonlyArray<Html>
	}>,
): Html => {
	const isInvalid =
		options.error !== null ||
		(options.field.isTouched && Option.isNone(metricStreamOf(options.field.value)))
	const state = Field.stateOf(options.field, isInvalid)
	return Field.field(h, { className: "items-stretch gap-2", state }, [
		Field.fieldLabel(h, { ids: options.ids, state }, options.label),
		h.div(
			[h.Class("flex flex-wrap items-center gap-2")],
			[
				input(h, {
					id: options.ids.control,
					className: "min-w-48 flex-1",
					controlClassName: "font-mono",
					fieldState: state,
					attributes: [
						h.Autocomplete("off"),
						h.Placeholder("us-east-1, eu-central-1"),
						...Field.controlAttributes(h, options.field, options.toMessage),
						h.AriaLabelledBy(options.ids.label),
						...(isInvalid ? [h.AriaInvalid(true)] : []),
					],
				}),
				...options.actions,
			],
		),
		options.error === null
			? Field.fieldDescription(h, { ids: options.ids, state }, METRIC_REGIONS_HINT)
			: Field.fieldError(h, { ids: options.ids, state, attributes: [h.Role("alert")] }, options.error),
	])
}

const accountForm = (h: H, model: Model, canCancel: boolean): Html => {
	const card = model.awsCard
	const typed = normalizeAccountId(card.accountId.value)
	const isValid =
		Option.isSome(decodeCreateRequest({ account_id: typed })) &&
		Option.isSome(metricStreamOf(card.regions.value))
	const state = Field.stateOf(card.accountId, card.createError !== null)
	return h.form(
		[h.Class("flex w-full flex-col gap-2 text-left"), h.OnSubmit(Message.SubmittedAwsAccount())],
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
						...(canCancel
							? [
									button(
										h,
										{
											variant: "outline",
											isDisabled: card.isCreating,
											attributes: [h.OnClick(Message.ClickedAwsAddCancel())],
										},
										["Cancel"],
									),
								]
							: []),
						button(h, { type: "submit", isDisabled: !isValid, isLoading: card.isCreating }, [
							icon(h, "AwsIcon"),
							"Connect AWS",
						]),
					],
				),
				...(card.createError === null
					? []
					: [
							Field.fieldError(
								h,
								{ ids: ACCOUNT_IDS, state, attributes: [h.Role("alert")] },
								card.createError,
							),
						]),
			]),
			regionsField(h, {
				ids: REGION_IDS,
				label: "Stream CloudWatch metrics from",
				field: card.regions,
				toMessage: (message) => Message.GotAwsRegionsMessage({ message }),
				error: null,
				actions: [],
			}),
		],
	)
}

/** Unavailable on this deployment: the card says so, without steps the reader can't take. */
const connectCard = (h: H, model: Model, status: V2AwsIntegration): Html =>
	integrationEmpty(h, [
		integrationEmptyFeatures(h, FEATURES),
		integrationEmptyCard(
			h,
			status.available
				? [
						integrationEmptyMedia(h, BRAND),
						integrationEmptyHint(h, [
							"Enter the account to connect. Maple then gives you a stack to deploy from AWS CloudShell, and confirms it by assuming the role.",
						]),
						accountForm(h, model, false),
						integrationEmptyFooter(h, [
							"You need permission to create IAM roles in the account. Each account connects separately.",
						]),
					]
				: [
						integrationEmptyMedia(h, BRAND),
						integrationEmptyHint(h, ["AWS can't be connected on this Maple deployment yet."]),
					],
		),
	])

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

const METRICS_IDS: Field.FieldIds = {
	control: "aws-stream-regions",
	label: "aws-stream-regions-label",
	error: "aws-stream-regions-error",
	description: "aws-stream-regions-description",
}

const metricsForm = (h: H, model: Model): Html => {
	const card = model.awsCard
	return h.form(
		[h.Class("flex w-full flex-col gap-2"), h.OnSubmit(Message.SubmittedAwsMetrics())],
		[
			regionsField(h, {
				ids: METRICS_IDS,
				label: "Stream CloudWatch metrics from",
				field: card.metricsRegions,
				toMessage: (message) => Message.GotAwsMetricsRegionsMessage({ message }),
				error: card.metricsError,
				actions: [
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
					button(
						h,
						{
							size: "sm",
							type: "submit",
							isDisabled: Option.isNone(metricStreamOf(card.metricsRegions.value)),
							isLoading: card.isSavingMetrics,
						},
						["Stream metrics"],
					),
				],
			}),
		],
	)
}

const roleName = (connection: V2AwsConnection) => connection.role_arn.split("/").at(-1) ?? connection.role_arn

type StepState = "done" | "current" | "warn" | "crit" | "todo"

interface Step {
	readonly title: string
	readonly state: StepState
	readonly detail: ReadonlyArray<Html | string>
	readonly extra?: ReadonlyArray<Html>
}

const STEP_GLYPH = {
	done: { icon: "CircleCheckIcon", className: "text-success-foreground" },
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
						"flex size-4 shrink-0 items-center justify-center rounded-full border text-[10px] tabular-nums text-muted-foreground",
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

const streamStep = (h: H, model: Model, connection: V2AwsConnection): Step => {
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
	const isOpen = model.awsCard.metricsId === connection.id
	return {
		title: "Metric stream",
		state: connection.verified_at === null ? "todo" : "warn",
		detail: [`${AWS_METRICS_OFF}.`],
		extra: isOpen
			? [metricsForm(h, model)]
			: [
					h.div(
						[],
						[
							button(
								h,
								{
									size: "sm",
									attributes: [h.OnClick(Message.ClickedAwsMetrics({ id: connection.id }))],
								},
								["Stream metrics"],
							),
						],
					),
				],
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
						`. ${AWS_NO_DELIVERY}.`,
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
			[h.Class("w-full overflow-x-auto rounded-md border")],
			[
				h.table(
					[h.Class("w-full text-xs")],
					[
						h.thead(
							[h.Class("bg-muted/30 text-left text-muted-foreground")],
							[
								h.tr(
									[],
									INGEST_COLUMNS.map((column) =>
										h.th(
											[
												h.Class(
													cn(
														"px-2.5 py-1.5 font-medium",
														(column === "Metrics" || column === "Data points") &&
															"text-right",
													),
												),
												h.Scope("col"),
											],
											[column],
										),
									),
								),
							],
						),
						h.tbody(
							[],
							ingest.groups.map((group) =>
								h.tr(
									[h.Class("border-t align-top")],
									[
										h.td([h.Class("px-2.5 py-1.5 font-mono")], [group.namespace]),
										h.td(
											[h.Class("px-2.5 py-1.5 font-mono text-muted-foreground")],
											[group.region ?? "unknown"],
										),
										h.td(
											[h.Class("px-2.5 py-1.5 text-right tabular-nums")],
											[formatNumber(group.metrics)],
										),
										h.td(
											[h.Class("px-2.5 py-1.5 text-right tabular-nums")],
											[formatNumber(group.data_points)],
										),
										h.td(
											[h.Class("px-2.5 py-1.5 [overflow-wrap:anywhere]")],
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
										),
										h.td(
											[
												h.Class(
													"whitespace-nowrap px-2.5 py-1.5 text-muted-foreground",
												),
											],
											[
												relativeTime(h, {
													value: group.last_point_at,
													nowMs: model.nowMs,
													timeZone,
													variant: "short",
												}),
											],
										),
									],
								),
							),
						),
					],
				),
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

const ingestPanel = (
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
				h.h4([h.Class("text-sm font-medium")], ["What Maple receives"]),
				...AsyncData.match(slot.data, {
					onIdle: () => [skeleton(h, "h-16 w-full rounded-md")],
					onLoading: () => [skeleton(h, "h-16 w-full rounded-md")],
					onFailure: (failure) => [
						errorState(h, {
							failure,
							title: "Failed to read what this account sends",
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
	return item(h, { variant: "card", className: "items-start gap-4 p-4" }, [
		itemMedia(h, {}, [integrationIconPlate(h, BRAND)]),
		itemContent(
			h,
			[
				h.div(
					[h.Class("flex flex-wrap items-center gap-2")],
					[
						h.h3(
							[h.Class("font-mono text-sm font-semibold tabular-nums")],
							[connection.account_id],
						),
						badge(h, { variant: CONDITION_VARIANT[condition] }, [AWS_CONDITION_LABEL[condition]]),
					],
				),
				stepList(h, [
					roleStep(h, model, connection, timeZone),
					streamStep(h, model, connection),
					...deliverySteps(h, model, connection, timeZone),
				]),
				...ingestPanel(h, model, connection, timeZone),
				h.div(
					[h.Class("flex flex-wrap gap-2 pt-1")],
					[
						button(
							h,
							{
								size: "sm",
								variant: isOpen ? "secondary" : "outline",
								attributes: [
									h.OnClick(
										isOpen
											? Message.ClickedAwsSetupClose()
											: Message.ClickedAwsSetup({ id: connection.id }),
									),
									h.AriaExpanded(isOpen),
								],
							},
							[connection.verified_at === null ? "Set up" : "Redeploy stack"],
						),
						button(
							h,
							{
								size: "sm",
								variant: "outline",
								isLoading: isChecking,
								attributes: [h.OnClick(Message.ClickedAwsCheck({ id: connection.id }))],
							},
							["Check connection"],
						),
						button(
							h,
							{
								size: "sm",
								variant: "outline",
								attributes: [h.OnClick(Message.ClickedAwsDisconnect({ id: connection.id }))],
							},
							["Disconnect"],
						),
					],
				),
				...(isOpen ? [setupPanel(h, model, connection)] : []),
			],
			"gap-3",
		),
	])
}

/** A generated file to copy, its name in the eyebrow; a long one scrolls under its copy button. */
const fileBlock = (h: H, model: Model, id: string, name: string, text: string): Html =>
	codeBlock(h, {
		code: text.trimEnd(),
		language: name,
		bodyClassName: "max-h-72 overflow-y-auto",
		copy: model.awsCard.copies[id] ?? CopyButton.init(),
		toCopyMessage: (message) => Message.GotAwsCopyMessage({ id, message }),
	})

const METHOD_OPTIONS: ReadonlyArray<Readonly<{ value: AwsSetupMethod; label: string }>> = [
	{ value: "cloudshell", label: "CloudShell" },
	{ value: "console", label: "Console" },
	{ value: "terraform", label: "Terraform" },
]

const methodBody = (
	h: H,
	model: Model,
	connection: V2AwsConnection,
	setup: V2AwsSetup,
): ReadonlyArray<Html> => {
	switch (model.awsCard.method) {
		case "cloudshell":
			return [
				h.p(
					[h.Class(SMALL)],
					[
						"Open ",
						externalLink(h, CLOUDSHELL_URL, "AWS CloudShell"),
						` signed in to account ${connection.account_id}, paste this, and press Enter. It deploys the stack ${setup.stack_name}.`,
					],
				),
				fileBlock(h, model, "aws-setup-script", "setup.sh", setup.setup_script),
			]
		case "console":
			return [
				h.p(
					[h.Class(SMALL)],
					[
						"Save this template, then ",
						externalLink(h, CREATE_STACK_URL, "create a stack"),
						` with it in account ${connection.account_id}, region ${setup.stack_region}. Name it ${setup.stack_name} and acknowledge that it creates IAM resources.`,
					],
				),
				fileBlock(
					h,
					model,
					"aws-template",
					`${setup.stack_name}.json`,
					setup.cloudformation_template,
				),
			]
		case "terraform":
			return [
				h.p(
					[h.Class(SMALL)],
					[
						`Apply this with the aws provider, using credentials for account ${connection.account_id}.`,
					],
				),
				fileBlock(h, model, "aws-terraform", "maple-aws.tf", setup.terraform),
			]
	}
}

const setupPanel = (h: H, model: Model, connection: V2AwsConnection): Html => {
	const waiting = connection.verified_at === null
	return h.div(
		[h.Class("mt-2 flex w-full flex-col gap-3 rounded-lg border bg-muted/20 p-3")],
		[
			h.div(
				[h.Class("flex flex-wrap items-center gap-2")],
				[
					h.h4(
						[h.Class("text-sm font-medium")],
						[waiting ? "Deploy the stack" : "Deploy the stack again"],
					),
					h.span(
						[h.Class("ml-auto")],
						[
							segmentedSelect(h, {
								options: METHOD_OPTIONS,
								value: model.awsCard.method,
								onChange: (method) => Message.ClickedAwsSetupMethod({ method }),
								size: "sm",
								ariaLabel: "Setup method",
							}),
						],
					),
				],
			),
			...AsyncData.match(model.awsCard.setup.data, {
				onIdle: () => [skeleton(h, "h-40 w-full rounded-lg")],
				onLoading: () => [skeleton(h, "h-40 w-full rounded-lg")],
				onFailure: (failure) => [
					errorState(h, {
						failure,
						title: "Failed to load the setup",
						onRetry: Message.ClickedAwsSetup({ id: connection.id }),
					}),
				],
				onStale: ({ data }) => methodBody(h, model, connection, data),
				onRefreshing: (data) => methodBody(h, model, connection, data),
				onSuccess: (data) => methodBody(h, model, connection, data),
			}),
			h.p(
				[h.Class(SMALL)],
				[
					waiting
						? "Maple checks the connection every 10 seconds while this is open."
						: "After changing what Maple reads, deploy the stack again and check the connection.",
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
				[h.Class("flex flex-col gap-3 rounded-lg border p-4")],
				[
					h.div(
						[h.Class("flex flex-wrap items-center gap-2")],
						[
							h.h4(
								[h.Class("text-sm font-medium")],
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
	return confirmDialog(h, {
		slotId: "aws-disconnect",
		model: model.awsCard.disconnectDialog,
		toParentMessage: (message) => Message.GotAwsDisconnectDialogMessage({ message }),
		title: `Disconnect AWS account ${connection?.account_id ?? ""}`,
		description:
			"Maple stops assuming the role and removes this source. Data already collected stays. Afterwards, delete the stack in AWS with the script Maple shows.",
		confirmLabel: "Disconnect",
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
				: model.awsCard.isAdding
					? [h.div([h.Class("rounded-lg border p-4")], [accountForm(h, model, true)])]
					: [
							h.div(
								[],
								[
									button(
										h,
										{
											size: "sm",
											variant: "outline",
											attributes: [h.OnClick(Message.ClickedAwsAdd())],
										},
										[icon(h, "PlusIcon", { size: 14 }), "Connect another account"],
									),
								],
							),
						]),
			...(focusId === null ? [awsDisconnectDialog(h, model)] : []),
		],
	)
}

const byStatus = (
	h: H,
	model: Model,
	status: V2AwsIntegration,
	timeZone: string,
	focusId: string | null,
): Html =>
	status.connections.length === 0
		? h.div(
				[h.Class("flex flex-col gap-3")],
				[...removedPanel(h, model, focusId), connectCard(h, model, status)],
			)
		: connectedView(h, model, status, timeZone, focusId)

export const awsCard = (h: H, model: Model, timeZone: string, focusId: string | null): Html =>
	AsyncData.match(model.statuses.aws.data, {
		onIdle: () => skeleton(h, "h-32 w-full rounded-md"),
		onLoading: () => skeleton(h, "h-32 w-full rounded-md"),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "Failed to load the AWS integration",
				onRetry: Message.ClickedRetryStatus({ name: "aws" }),
			}),
		onStale: ({ data }) => byStatus(h, model, data, timeZone, focusId),
		onRefreshing: (data) => byStatus(h, model, data, timeZone, focusId),
		onSuccess: (data) => byStatus(h, model, data, timeZone, focusId),
	})
