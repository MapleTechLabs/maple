import { OrgId } from "@maple/domain"
import { encodePublicId, PublicIdPrefixes, V2AwsIntegration } from "@maple/domain/http/v2"
import { Option, Result, Schema } from "effect"
import { AsyncData } from "foldkit"
import { click, Command, expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../contract"
import { ScrollToTop } from "../sources/new/command"
import { Message } from "../sources/new/message"
import type { Model } from "../sources/new/model"
import { init, update } from "../sources/new/update"
import { view as pageView } from "../sources/new/view"
import { Message as IntegrationMessage } from "./message"

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_acme"),
	pinnedNamespace: null,
	timeZone: "UTC",
}
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const inner = (model: Model, message: IntegrationMessage) =>
	pageUpdate(model, Message.GotIntegrationsMessage({ message })).model
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const NOW = Date.parse("2026-10-23T09:00:00.000Z")
const ID = encodePublicId(PublicIdPrefixes.awsConnection, "018f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8")

const connection = (overrides: Record<string, unknown> = {}) => ({
	id: ID,
	object: "aws_connection",
	account_id: "123456789012",
	role_arn: "arn:aws:iam::123456789012:role/MapleIntegration-018f2b3c4d5e4f708192a3b4",
	oidc_issuer: "https://api.maple.dev/oidc/aws",
	oidc_subject: "aws-connection:018f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8",
	modules: [],
	granted_modules: [],
	template_version: 2,
	setup_outdated: false,
	verified_at: null,
	last_checked_at: null,
	last_check_error: null,
	metric_stream: null,
	metric_stream_changed_at: null,
	metrics_last_received_at: null,
	metrics_last_error: null,
	created_at: "2026-10-23T07:55:00.000Z",
	...overrides,
})

const VERIFIED = { verified_at: "2026-10-23T08:00:00.000Z", last_checked_at: "2026-10-23T08:58:00.000Z" }

const withConnections = (connections: ReadonlyArray<Record<string, unknown>>): Model => {
	const entered = init({ _tag: "SourcesNew", search: { integration: "aws" } }, context).model
	return inner(
		inner(entered, IntegrationMessage.CompletedReadClock({ nowMs: NOW })),
		IntegrationMessage.CompletedLoadAws({
			key: entered.integrations.statuses.aws.key ?? "",
			result: Result.succeed(
				Schema.decodeUnknownSync(V2AwsIntegration)({
					object: "aws_integration",
					available: true,
					modules: [],
					connections,
				}),
			),
		}),
	)
}

const continued = (model: Model, times: number): Model =>
	times === 0 ? model : continued(pageUpdate(model, Message.ClickedContinue()).model, times - 1)

const idOf = (model: Model) =>
	Option.getOrNull(AsyncData.getData(model.integrations.statuses.aws.data))?.connections[0]?.id ?? null

describe("aws connect flow", () => {
	test("with no account yet, Connect asks for the account ID and Continue stays locked", () => {
		scene(
			{ update: pageUpdate, view },
			given(withConnections([])),
			expectView(role("listitem", { current: "step", name: "Connect" })).toExist(),
			expectView(text("Deploy a read-only role")).toExist(),
			expectView(role("button", { name: "Build the role stack" })).toBeDisabled(),
			expectView(role("button", { name: "Continue" })).toBeDisabled(),
		)
	})

	test("after the flow's own account is disconnected, Connect asks for an account again", () => {
		const made = withConnections([connection()])
		const id = idOf(made)
		if (id === null) return expect.unreachable("the loaded status lists the connection")
		const flowing: Model = {
			...made,
			integrations: { ...made.integrations, awsCard: { ...made.integrations.awsCard, flowId: id } },
		}
		const disconnected = inner(
			flowing,
			IntegrationMessage.CompletedAwsDisconnect({
				id,
				removed: { connectionId: id, accountId: "123456789012", cleanupScript: "echo done" },
				error: null,
			}),
		)
		const reloaded = inner(
			disconnected,
			IntegrationMessage.CompletedLoadAws({
				key: disconnected.integrations.statuses.aws.key ?? "",
				result: Result.succeed(
					Schema.decodeUnknownSync(V2AwsIntegration)({
						object: "aws_integration",
						available: true,
						modules: [],
						connections: [],
					}),
				),
			}),
		)
		scene(
			{ update: pageUpdate, view },
			given(reloaded),
			expectView(text("Deploy a read-only role")).toExist(),
		)
	})

	test("a stack not deployed yet waits for the role; a refused check says why", () => {
		scene(
			{ update: pageUpdate, view },
			given(withConnections([connection()])),
			expectView(text("Run the role stack in 123456789012")).toExist(),
			expectView(role("button", { name: "Show the role script" })).toExist(),
			expectView(role("button", { name: "Continue" })).toBeDisabled(),
		)
		scene(
			{ update: pageUpdate, view },
			given(withConnections([connection({ last_check_error: "AccessDenied on AssumeRole." })])),
			expectView(text("AccessDenied on AssumeRole.", { exact: false })).toExist(),
			expectView(role("button", { name: "Check again" })).toExist(),
		)
	})

	test("once the role answers, Continue opens Choose data with every service picked", () => {
		scene(
			{ update: pageUpdate, view },
			given(withConnections([connection(VERIFIED)])),
			expectView(text("Read-only role deployed")).toExist(),
			expectView(
				text("Role found. Maple assumed MapleIntegration-018f2b3c4d5e4f708192a3b4 through OIDC."),
			).toExist(),
			click(role("button", { name: "Continue" })),
			Command.resolve(ScrollToTop, Message.CompletedScrollToTop()),
			expectView(role("listitem", { current: "step", name: "Choose data" })).toExist(),
			expectView(role("switch", { name: "Lambda" })).toBeChecked(),
			expectView(role("checkbox", { name: "us-east-1, N. Virginia" })).toBeChecked(),
			expectView(role("button", { name: "Continue" })).toBeEnabled(),
		)
	})

	test("without a region, Choose data does not continue", () => {
		const choosing = continued(withConnections([connection(VERIFIED)]), 1)
		const id = idOf(choosing)
		expect(id).not.toBeNull()
		const none =
			id === null
				? choosing
				: inner(choosing, IntegrationMessage.ToggledAwsRegion({ id, region: "us-east-1" }))
		scene(
			{ update: pageUpdate, view },
			given(none),
			expectView(role("button", { name: "Continue" })).toBeDisabled(),
			expectView(text("Pick at least one region and one service.")).toExist(),
		)
	})

	test("Go live saves the picked stream, then its checklist waits for the first delivery", () => {
		const live = continued(withConnections([connection(VERIFIED)]), 2)
		scene(
			{ update: pageUpdate, view },
			given(live),
			expectView(role("listitem", { current: "step", name: "Go live" })).toExist(),
			expectView(text("Role assumed")).toExist(),
			expectView(text("Get the stream script above to save it.")).toExist(),
		)
		const id = idOf(live)
		const saved =
			id === null
				? []
				: names(
						pageUpdate(
							live,
							Message.GotIntegrationsMessage({
								message: IntegrationMessage.SubmittedAwsMetrics({ id }),
							}),
						).commands,
					)
		expect(saved).toContain("UpdateAwsMetricStream")
	})

	test("a streaming account that delivers is live; one that stays silent needs attention", () => {
		const streaming = (metrics_last_received_at: string | null) =>
			continued(
				withConnections([
					connection({
						...VERIFIED,
						metric_stream: {
							regions: ["us-east-1"],
							namespaces: [
								"AWS/ECS",
								"ECS/ContainerInsights",
								"AWS/ApplicationELB",
								"AWS/NetworkELB",
								"AWS/RDS",
								"AWS/Lambda",
								"AWS/SQS",
								"AWS/EC2",
								"AWS/DynamoDB",
								"AWS/ApiGateway",
							],
						},
						metric_stream_changed_at: "2026-10-23T07:55:00.000Z",
						metrics_last_received_at,
					}),
				]),
				2,
			)
		scene(
			{ update: pageUpdate, view },
			given(streaming("2026-10-23T08:59:30.000Z")),
			expectView(role("listitem", { name: "Live" })).toExist(),
			expectView(text("Receiving metrics")).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(streaming(null)),
			expectView(text("No metrics arriving")).toExist(),
			expectView(role("listitem", { current: "step", name: "Go live: needs attention" })).toExist(),
		)
	})
})
