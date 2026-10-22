import type { V2AwsConnection, V2AwsIntegration, V2AwsSetup } from "@maple/domain/http/v2"
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
import { type AwsSetupMethod, decodeCreateRequest, normalizeAccountId } from "./aws"
import { codeBlock } from "../settings/kit/code-block"
import { segmentedSelect } from "../../ui/segmented-select"
import { externalLink } from "./view-gcp-configure-parts"
import { AWS_ACCENT } from "./catalog"
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

const accountForm = (h: H, model: Model, canCancel: boolean): Html => {
	const card = model.awsCard
	const typed = normalizeAccountId(card.accountId.value)
	const isValid = Option.isSome(decodeCreateRequest({ account_id: typed }))
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

type Health = Readonly<{ label: string; variant: "ok" | "warn" | "crit" | "muted" }>

const healthOf = (connection: V2AwsConnection): Health => {
	if (connection.verified_at === null) return { label: "Waiting for setup", variant: "muted" }
	if (connection.last_check_error !== null) return { label: "Needs attention", variant: "crit" }
	if (connection.setup_outdated) return { label: "Update the stack", variant: "warn" }
	return { label: "Connected", variant: "ok" }
}

const roleName = (connection: V2AwsConnection) => connection.role_arn.split("/").at(-1) ?? connection.role_arn

const connectionRow = (h: H, model: Model, connection: V2AwsConnection, timeZone: string): Html => {
	const health = healthOf(connection)
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
						badge(h, { variant: health.variant }, [health.label]),
					],
				),
				h.p(
					[h.Class(cn(SMALL, "[overflow-wrap:anywhere]"))],
					[
						roleName(connection),
						...(connection.last_checked_at === null
							? []
							: [
									" · ",
									relativeTime(h, {
										value: connection.last_checked_at,
										nowMs: model.nowMs,
										timeZone,
										prefix: "checked",
									}),
								]),
					],
				),
				...(connection.last_check_error === null
					? []
					: [
							h.p(
								[
									h.Class(
										cn(
											"text-xs [overflow-wrap:anywhere]",
											connection.verified_at === null
												? "text-muted-foreground"
												: "text-severity-error",
										),
									),
									h.Role(connection.verified_at === null ? "status" : "alert"),
								],
								[connection.last_check_error],
							),
						]),
				h.div(
					[h.Class("flex flex-wrap gap-2")],
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
			"gap-2",
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

const disconnectConfirm = (h: H, model: Model, status: V2AwsIntegration): Html => {
	const connection = status.connections.find((entry) => entry.id === model.awsCard.disconnectId)
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
			disconnectConfirm(h, model, status),
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
