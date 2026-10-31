import type { V2AwsConnection, V2AwsSetup } from "@maple/domain/http/v2"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as CopyButton from "../../ui/copy-button"
import { errorState } from "../../ui/error-state"
import { segmentedSelect } from "../../ui/segmented-select"
import { skeleton } from "../../ui/skeleton"
import { codeBlock } from "../settings/kit/code-block"
import type { AwsSetupMethod, AwsSetupPart } from "./aws"
import { Message } from "./message"
import type { Model } from "./model"
import { externalLink } from "./view-gcp-configure-parts"

// The AWS stack's setup, by method: shared by the connected card and the connect flow.

type H = HtmlBuilder<Message>

// The stack's region (`stack_region`, always us-east-1): the console opens where the scripts deploy.
export const CLOUDSHELL_URL = "https://us-east-1.console.aws.amazon.com/cloudshell/home?region=us-east-1"
const CREATE_STACK_URL =
	"https://us-east-1.console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/create"
export const SMALL = "text-xs text-muted-foreground"

/** A generated file to copy, its name in the eyebrow; a long one scrolls under its copy button. */
export const fileBlock = (h: H, model: Model, id: string, name: string, text: string): Html =>
	codeBlock(h, {
		code: text.trimEnd(),
		language: name,
		bodyClassName: "max-h-72 overflow-y-auto",
		copy: model.awsCard.copies[id] ?? CopyButton.init(),
		toCopyMessage: (message) => Message.GotAwsCopyMessage({ id, message }),
	})

const ROLE_METHODS: ReadonlyArray<Readonly<{ value: AwsSetupMethod; label: string }>> = [
	{ value: "cloudshell", label: "CloudShell" },
	{ value: "console", label: "Console" },
	{ value: "terraform", label: "Terraform" },
]

// Terraform covers only the role, so the metric stream is set up from CloudShell or the console.
const STREAM_METHODS = ROLE_METHODS.filter((option) => option.value !== "terraform")

export type SetupPart = AwsSetupPart

/** The method picker for the role's setup or the metric stream's. */
export const methodSelect = (h: H, model: Model, part: SetupPart): Html =>
	segmentedSelect(h, {
		options: part === "role" ? ROLE_METHODS : STREAM_METHODS,
		value: methodOf(model, part),
		onChange: (method) => Message.ClickedAwsSetupMethod({ part, method }),
		size: "sm",
		ariaLabel: "Setup method",
	})

const methodOf = (model: Model, part: SetupPart): AwsSetupMethod =>
	part === "role" ? model.awsCard.method : model.awsCard.streamMethod

const roleBody = (
	h: H,
	model: Model,
	connection: V2AwsConnection,
	setup: V2AwsSetup,
): ReadonlyArray<Html> => {
	switch (methodOf(model, "role")) {
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

const streamBody = (
	h: H,
	model: Model,
	connection: V2AwsConnection,
	setup: V2AwsSetup,
): ReadonlyArray<Html> => {
	const regions = connection.metric_stream?.regions.join(", ") ?? ""
	return methodOf(model, "stream") === "console" && setup.metrics_cloudformation_template !== null
		? [
				h.p(
					[h.Class(SMALL)],
					[
						"Save this template, then ",
						externalLink(h, CREATE_STACK_URL, "create a stack"),
						` with it in each of ${regions}, in account ${connection.account_id}. Name it ${setup.metrics_stack_name ?? ""} and set its AccessKey parameter to the one in the CloudShell script.`,
					],
				),
				fileBlock(
					h,
					model,
					"aws-metrics-template",
					`${setup.metrics_stack_name ?? "maple-metrics"}.json`,
					setup.metrics_cloudformation_template,
				),
			]
		: [
				h.p(
					[h.Class(SMALL)],
					[
						"Open ",
						externalLink(h, CLOUDSHELL_URL, "AWS CloudShell"),
						` signed in to account ${connection.account_id}, paste this, and press Enter. It updates the role and deploys the metric stream to ${regions}.`,
					],
				),
				fileBlock(h, model, "aws-setup-script", "setup.sh", setup.setup_script),
			]
}

/** The open setup's files for `part`, while it loads, or why it failed to. */
export const setupBody = (
	h: H,
	model: Model,
	connection: V2AwsConnection,
	part: SetupPart,
): ReadonlyArray<Html> => {
	const body = (setup: V2AwsSetup) =>
		part === "role" ? roleBody(h, model, connection, setup) : streamBody(h, model, connection, setup)
	return AsyncData.match(model.awsCard.setup.data, {
		onIdle: () => [skeleton(h, "h-40 w-full rounded-lg")],
		onLoading: () => [skeleton(h, "h-40 w-full rounded-lg")],
		onFailure: (failure) => [
			errorState(h, {
				failure,
				title: "Couldn't load the setup",
				onRetry: Message.ClickedAwsSetup({ id: connection.id }),
			}),
		],
		onStale: ({ data }) => body(data),
		onRefreshing: body,
		onSuccess: body,
	})
}
