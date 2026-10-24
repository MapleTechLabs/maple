import { OrgId } from "@maple/domain"
import { Timestamp, type V2AwsConnection, type V2AwsIntegration } from "@maple/domain/http/v2"
import { AwsAccountId, AwsConnectionId } from "@maple/domain/primitives"
import { AwsMetricStream } from "@maple/domain/aws"
import { AWS_METRIC_NAMESPACES } from "@maple/domain/primitives"
import { Result, Schema } from "effect"
import { AsyncData } from "foldkit"
import { expect as expectView, given, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import * as Field from "../../ui/field"
import { PageOutMessage, type PageContext } from "../contract"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { statusKey } from "./update-status"
import { overviewOf } from "./derive"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const connectionId = Schema.decodeSync(AwsConnectionId)("018f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8")

const connection = (overrides: Partial<V2AwsConnection> = {}): V2AwsConnection => ({
	id: connectionId,
	object: "aws_connection",
	account_id: Schema.decodeSync(AwsAccountId)("123456789012"),
	role_arn: "arn:aws:iam::123456789012:role/MapleIntegration-018f2b3c4d5e4f708192a3b4",
	oidc_issuer: "https://api.maple.dev/oidc/aws",
	oidc_subject: "aws-connection:018f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8",
	modules: [],
	granted_modules: null,
	template_version: null,
	setup_outdated: false,
	verified_at: null,
	last_checked_at: null,
	last_check_error: null,
	metric_stream: null,
	metric_stream_changed_at: null,
	metrics_last_received_at: null,
	metrics_last_error: null,
	created_at: Schema.decodeSync(Timestamp)("2026-10-21T12:00:00.000Z"),
	...overrides,
})

const stream = Schema.decodeSync(AwsMetricStream)({ regions: ["us-east-1"], namespaces: ["AWS/ECS"] })

const entered = (): Model => init({ search: { integration: "aws" } }, context).model

const withStatus = (model: Model, connections: ReadonlyArray<V2AwsConnection>): Model => {
	const status: V2AwsIntegration = { object: "aws_integration", available: true, modules: [], connections }
	return pageUpdate(
		model,
		Message.CompletedLoadAws({ key: statusKey(context, "aws"), result: Result.succeed(status) }),
	).model
}

const typed = (value: string): Model =>
	pageUpdate(entered(), Message.GotAwsAccountIdMessage({ message: Field.Message.ChangedValue({ value }) }))
		.model

describe("aws card", () => {
	test("an account ID pasted with dashes is sent once; one too short never is", () => {
		const short = pageUpdate(typed("12345678901"), Message.SubmittedAwsAccount())
		expect(names(short.commands)).toEqual([])
		expect(short.model.awsCard.createError).toBe("An AWS account ID is 12 digits.")

		const sent = pageUpdate(typed(" 1234-5678-9012 "), Message.SubmittedAwsAccount())
		expect(names(sent.commands)).toEqual(["CreateAwsConnection"])
		expect(names(pageUpdate(sent.model, Message.SubmittedAwsAccount()).commands)).toEqual([])
	})

	test("a new connection asks for the role only: the stream is picked once Maple sees the account", () => {
		const sent = pageUpdate(typed("123456789012"), Message.SubmittedAwsAccount())
		const [create] = sent.commands ?? []
		expect(create?.name).toBe("CreateAwsConnection")
		expect(create?.args).toEqual({ request: { account_id: "123456789012" } })
	})

	test("Edit data streams the picked regions, then the setup opens to redeploy", () => {
		const verified_at = Schema.decodeSync(Timestamp)("2026-10-21T12:05:00.000Z")
		const model = withStatus(entered(), [connection({ verified_at })])
		expect(overviewOf(model.statuses, model.nowMs, "aws")).toMatchObject({ issue: "Metrics off" })

		const opened = pageUpdate(model, Message.ClickedAwsMetrics({ id: connectionId })).model
		const edited = [
			Message.ToggledAwsRegion({ id: connectionId, region: "eu-central-1" }),
			Message.ToggledAwsRegion({ id: connectionId, region: "us-east-1" }),
			Message.ToggledAwsNamespace({ id: connectionId, namespace: "AWS/SQS" }),
		].reduce((next, message) => pageUpdate(next, message).model, opened)
		const sent = pageUpdate(edited, Message.SubmittedAwsMetrics({ id: connectionId }))
		const [update] = sent.commands ?? []
		expect(update?.name).toBe("UpdateAwsMetricStream")
		expect(update?.args).toEqual({
			id: connectionId,
			metricStream: {
				regions: ["eu-central-1"],
				namespaces: AWS_METRIC_NAMESPACES.filter((namespace) => namespace !== "AWS/SQS"),
			},
		})
		// A second submit while saving sends nothing.
		expect(
			names(pageUpdate(sent.model, Message.SubmittedAwsMetrics({ id: connectionId })).commands),
		).toEqual([])

		const saved = pageUpdate(
			sent.model,
			Message.CompletedAwsMetricStream({
				connection: connection({ verified_at, metric_stream: stream }),
				error: null,
			}),
		)
		expect(saved.model.awsCard.metricsId).toBeNull()
		expect(saved.model.awsCard.setupId).toBe(connectionId)
		expect(names(saved.commands)).toContain("LoadAwsSetup")
		expect(names(saved.commands)).toContain("LoadIntegrationsAwsStatus")
	})

	test("without a region nothing is sent, and the picker says what is missing", () => {
		const verified_at = Schema.decodeSync(Timestamp)("2026-10-21T12:05:00.000Z")
		const none = pageUpdate(
			withStatus(entered(), [connection({ verified_at })]),
			Message.ToggledAwsRegion({ id: connectionId, region: "us-east-1" }),
		).model
		const sent = pageUpdate(none, Message.SubmittedAwsMetrics({ id: connectionId }))
		expect(names(sent.commands)).toEqual([])
		expect(sent.model.awsCard.metricsError).toBe("Pick at least one region and one service.")
	})

	test("a stream saved while the setup is open reads the script again", () => {
		const verified_at = Schema.decodeSync(Timestamp)("2026-10-21T12:05:00.000Z")
		const model = withStatus(entered(), [connection({ verified_at })])
		const open = pageUpdate(model, Message.ClickedAwsSetup({ id: connectionId })).model
		const loaded = pageUpdate(
			open,
			Message.CompletedLoadAwsSetup({
				key: open.awsCard.setup.key ?? "",
				result: Result.succeed({
					object: "aws_connection.setup",
					stack_name: "maple-integration",
					stack_region: "us-east-1",
					setup_script: "no stream",
					cleanup_script: "",
					cloudformation_template: "{}",
					terraform: "",
					metrics_stack_name: null,
					metrics_cloudformation_template: null,
				}),
			}),
		).model
		const saved = pageUpdate(
			loaded,
			Message.CompletedAwsMetricStream({
				connection: connection({ verified_at, metric_stream: stream }),
				error: null,
			}),
		)
		expect(names(saved.commands)).toContain("LoadAwsSetup")
	})

	test("a refused metric stream keeps the form open with the reason", () => {
		const verified_at = Schema.decodeSync(Timestamp)("2026-10-21T12:05:00.000Z")
		const opened = pageUpdate(
			withStatus(entered(), [connection({ verified_at })]),
			Message.ClickedAwsMetrics({ id: connectionId }),
		).model
		const sent = pageUpdate(opened, Message.SubmittedAwsMetrics({ id: connectionId })).model
		const failed = pageUpdate(
			sent,
			Message.CompletedAwsMetricStream({ connection: null, error: "Not allowed." }),
		).model
		expect(failed.awsCard.metricsId).toBe(connectionId)
		expect(failed.awsCard.metricsError).toBe("Not allowed.")
		expect(failed.awsCard.isSavingMetrics).toBe(false)
	})

	test("a new connection opens its setup and re-reads the status", () => {
		const sent = pageUpdate(typed("123456789012"), Message.SubmittedAwsAccount()).model
		const created = pageUpdate(sent, Message.SucceededAwsCreate({ connection: connection() }))
		expect(created.model.awsCard.setupId).toBe(connectionId)
		expect(created.model.awsCard.accountId.value).toBe("")
		expect(names(created.commands)).toContain("LoadAwsSetup")
		expect(names(created.commands)).toContain("LoadIntegrationsAwsStatus")
	})

	test("while waiting, a tick checks quietly; the first success closes the setup with a toast", () => {
		const waiting = pageUpdate(
			withStatus(entered(), [connection()]),
			Message.ClickedAwsSetup({ id: connectionId }),
		).model
		const ticked = pageUpdate(waiting, Message.TickedAwsPending())
		expect(names(ticked.commands)).toEqual(["CheckAwsConnection"])
		// A check in flight is not sent twice.
		expect(names(pageUpdate(ticked.model, Message.TickedAwsPending()).commands)).toEqual([])

		const stillWaiting = pageUpdate(
			ticked.model,
			Message.CompletedAwsCheck({
				id: connectionId,
				quiet: true,
				connection: connection(),
				failure: null,
			}),
		)
		expect(stillWaiting.outMessage).toBeUndefined()
		expect(stillWaiting.model.awsCard.setupId).toBe(connectionId)

		const verified = connection({
			verified_at: Schema.decodeSync(Timestamp)("2026-10-21T12:05:00.000Z"),
			template_version: 1,
			granted_modules: [],
		})
		const done = pageUpdate(
			ticked.model,
			Message.CompletedAwsCheck({ id: connectionId, quiet: true, connection: verified, failure: null }),
		)
		expect(done.model.awsCard.setupId).toBeNull()
		// The check is newer than the page clock: it is read again so "checked" is not in the future.
		expect(names(done.commands)).toContain("ReadIntegrationsClock")
		expect(done.outMessage).toEqual(
			PageOutMessage.RequestedToast({
				type: "success",
				title: "AWS connected",
				description: "Maple can read account 123456789012.",
			}),
		)
	})

	test("opening another connection's setup never shows the first one's script meanwhile", () => {
		const other = Schema.decodeSync(AwsConnectionId)("028f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8")
		const model = withStatus(entered(), [connection(), connection({ id: other })])
		const first = pageUpdate(model, Message.ClickedAwsSetup({ id: connectionId }))
		const [load] = first.commands ?? []
		const loaded = pageUpdate(
			first.model,
			Message.CompletedLoadAwsSetup({
				key: first.model.awsCard.setup.key ?? "",
				result: Result.succeed({
					object: "aws_connection.setup",
					stack_name: "maple-integration-first",
					stack_region: "us-east-1",
					setup_script: "first",
					cleanup_script: "first",
					cloudformation_template: "{}",
					terraform: "",
					metrics_stack_name: null,
					metrics_cloudformation_template: null,
				}),
			}),
		).model
		expect(load?.name).toBe("LoadAwsSetup")
		const switched = pageUpdate(loaded, Message.ClickedAwsSetup({ id: other })).model
		expect(switched.awsCard.setupId).toBe(other)
		expect(AsyncData.getData(switched.awsCard.setup.data)._tag).toBe("None")
	})

	test("a click during a background check gets that check's result as a toast", () => {
		const waiting = pageUpdate(
			withStatus(entered(), [connection()]),
			Message.ClickedAwsSetup({ id: connectionId }),
		).model
		const polling = pageUpdate(waiting, Message.TickedAwsPending()).model
		const clicked = pageUpdate(polling, Message.ClickedAwsCheck({ id: connectionId }))
		// The check in flight answers for both: no second call to AWS.
		expect(names(clicked.commands)).toEqual([])
		const failing = connection({ last_check_error: "Maple cannot assume the role yet." })
		const done = pageUpdate(
			clicked.model,
			Message.CompletedAwsCheck({ id: connectionId, quiet: true, connection: failing, failure: null }),
		)
		expect(done.outMessage).toEqual(
			PageOutMessage.RequestedToast({
				type: "error",
				title: "The check failed",
				description: "Maple cannot assume the role yet.",
			}),
		)
	})

	test("a background check verifying another connection leaves the open setup alone", () => {
		const other = Schema.decodeSync(AwsConnectionId)("028f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8")
		const open = pageUpdate(
			withStatus(entered(), [connection(), connection({ id: other })]),
			Message.ClickedAwsSetup({ id: connectionId }),
		).model
		const polling = pageUpdate(open, Message.TickedAwsPending()).model
		const verified = connection({
			id: other,
			verified_at: Schema.decodeSync(Timestamp)("2026-10-21T12:05:00.000Z"),
		})
		const done = pageUpdate(
			polling,
			Message.CompletedAwsCheck({ id: other, quiet: true, connection: verified, failure: null }),
		)
		expect(done.model.awsCard.setupId).toBe(connectionId)
		expect(done.outMessage).toBeUndefined()
	})

	test("a connection waiting for its stack reads as setup in progress, not a failure", () => {
		const model = withStatus(entered(), [connection()])
		const overview = overviewOf(model.statuses, model.nowMs, "aws")
		expect(overview?.kind === "connected" && overview.health).toBe("pending")
		expect(overview?.kind === "connected" && overview.issue).toBe("Finish setup")
	})

	test("a verified connection whose stack is outdated needs attention, as its row says", () => {
		const verified_at = Schema.decodeSync(Timestamp)("2026-10-21T12:05:00.000Z")
		const model = withStatus(entered(), [connection({ verified_at, setup_outdated: true })])
		const overview = overviewOf(model.statuses, model.nowMs, "aws")
		expect(overview?.kind === "connected" && overview.health).toBe("attention")
		expect(overview?.kind === "connected" && overview.issue).toBe("Update the stack")
	})

	test("a verified stream is only fine while metrics arrive: the role check alone is not data", () => {
		const verified_at = Schema.decodeSync(Timestamp)("2026-10-23T08:00:00.000Z")
		const at = (iso: string, connections: ReadonlyArray<V2AwsConnection>) =>
			pageUpdate(
				withStatus(entered(), connections),
				Message.CompletedReadClock({ nowMs: Date.parse(iso) }),
			).model
		const overview = (model: Model) => overviewOf(model.statuses, model.nowMs, "aws")
		const streaming = connection({ verified_at, metric_stream: stream })

		// Minutes after the deploy the first delivery is on its way.
		const fresh = at("2026-10-23T08:10:00.000Z", [streaming])
		expect(overview(fresh)).toMatchObject({ health: "pending", issue: "Waiting for metrics" })
		// An hour later with nothing delivered, it is not working, whatever the role check says.
		const silent = at("2026-10-23T09:00:00.000Z", [streaming])
		expect(overview(silent)).toMatchObject({ health: "attention", issue: "No metrics arriving" })

		const delivering = connection({
			verified_at,
			metric_stream: stream,
			metrics_last_received_at: Schema.decodeSync(Timestamp)("2026-10-23T08:59:00.000Z"),
		})
		expect(overview(at("2026-10-23T09:00:00.000Z", [delivering]))).toMatchObject({
			health: "healthy",
			issue: null,
		})
		expect(overview(at("2026-10-23T10:00:00.000Z", [delivering]))).toMatchObject({
			health: "attention",
			issue: "Metrics stopped",
		})
	})

	test("the card says why nothing arrives, step by step", () => {
		const verified_at = Schema.decodeSync(Timestamp)("2026-10-23T08:00:00.000Z")
		const model = pageUpdate(
			withStatus(entered(), [connection({ verified_at, metric_stream: stream })]),
			Message.CompletedReadClock({ nowMs: Date.parse("2026-10-23T09:00:00.000Z") }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(text("No metrics arriving")).toExist(),
			expectView(
				text("Maple assumes MapleIntegration-018f2b3c4d5e4f708192a3b4", { exact: false }),
			).toExist(),
			expectView(text("Nothing has arrived since the stream was set up", { exact: false })).toExist(),
		)
	})

	test("a streaming connection's ingest is read with its status and shown by namespace and region", () => {
		const verified_at = Schema.decodeSync(Timestamp)("2026-10-23T08:00:00.000Z")
		const delivering = connection({
			verified_at,
			metric_stream: Schema.decodeSync(AwsMetricStream)({
				regions: ["us-east-1", "eu-central-1"],
				namespaces: ["AWS/ECS"],
			}),
			metrics_last_received_at: Schema.decodeSync(Timestamp)("2026-10-23T08:59:00.000Z"),
		})
		const status: V2AwsIntegration = {
			object: "aws_integration",
			available: true,
			modules: [],
			// One without a stream sends nothing to read.
			connections: [
				delivering,
				connection({
					id: Schema.decodeSync(AwsConnectionId)("028f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8"),
				}),
			],
		}
		const arrived = pageUpdate(
			pageUpdate(
				entered(),
				Message.CompletedReadClock({ nowMs: Date.parse("2026-10-23T09:00:00.000Z") }),
			).model,
			Message.CompletedLoadAws({ key: statusKey(context, "aws"), result: Result.succeed(status) }),
		)
		// Pages that do not show the AWS card never ask the warehouse.
		const elsewhere = pageUpdate(
			init({ search: {} }, context).model,
			Message.CompletedLoadAws({ key: statusKey(context, "aws"), result: Result.succeed(status) }),
		)
		expect(names(elsewhere.commands)).not.toContain("LoadAwsIngest")
		const loads = (arrived.commands ?? []).filter((command) => command.name === "LoadAwsIngest")
		expect(loads.map((command) => command.args)).toEqual([{ key: expect.any(String), id: connectionId }])
		const key = arrived.model.awsCard.ingest[connectionId]?.key ?? ""
		const loaded = pageUpdate(
			arrived.model,
			Message.CompletedLoadAwsIngest({
				id: connectionId,
				key,
				result: Result.succeed({
					object: "aws_connection.ingest",
					window_start: Schema.decodeSync(Timestamp)("2026-10-23T08:00:00.000Z"),
					window_end: Schema.decodeSync(Timestamp)("2026-10-23T09:00:00.000Z"),
					data_points: 3600,
					last_point_at: Schema.decodeSync(Timestamp)("2026-10-23T08:59:00.000Z"),
					groups: [
						{
							namespace: "AWS/ECS",
							region: "us-east-1",
							metrics: 12,
							data_points: 3600,
							resources: 9,
							sample_resources: ["api", "checkout"],
							last_point_at: Schema.decodeSync(Timestamp)("2026-10-23T08:59:00.000Z"),
						},
					],
				}),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(loaded),
			expectView(text("Receiving metrics")).toExist(),
			expectView(text("AWS/ECS")).toExist(),
			expectView(text("in the last hour", { exact: false })).toExist(),
			// A configured region that sent nothing is named, the one that did is not.
			expectView(text("Nothing from eu-central-1 in the last hour", { exact: false })).toExist(),
			expectView(text("Nothing from us-east-1 in the last hour", { exact: false })).not.toExist(),
		)
	})

	test("a status read that finds the open setup verified closes it", () => {
		const waiting = pageUpdate(
			withStatus(entered(), [connection()]),
			Message.ClickedAwsSetup({ id: connectionId }),
		).model
		const verified = connection({ verified_at: Schema.decodeSync(Timestamp)("2026-10-21T12:05:00.000Z") })
		const status: V2AwsIntegration = {
			object: "aws_integration",
			available: true,
			modules: [],
			connections: [verified],
		}
		const arrived = pageUpdate(
			waiting,
			Message.CompletedLoadAws({ key: statusKey(context, "aws"), result: Result.succeed(status) }),
		)
		expect(arrived.model.awsCard.setupId).toBeNull()
		expect(arrived.outMessage?._tag).toBe("RequestedToast")
	})

	test("a disconnect keeps the stack's cleanup script until it is dismissed", () => {
		const confirming = pageUpdate(
			withStatus(entered(), [connection()]),
			Message.ClickedAwsDisconnect({ id: connectionId }),
		).model
		const sent = pageUpdate(confirming, Message.ConfirmedAwsDisconnect())
		expect(names(sent.commands)).toEqual(["DeleteAwsConnection"])
		const removed = {
			connectionId,
			accountId: "123456789012",
			cleanupScript: "aws cloudformation delete-stack",
		}
		const done = pageUpdate(
			sent.model,
			Message.CompletedAwsDisconnect({ id: connectionId, removed, error: null }),
		)
		expect(done.model.awsCard.removed).toEqual([removed])
		// The role outlives the connection, so the script outlives the page.
		expect(names(done.commands)).toContain("WriteAwsRemovedStacks")
		expect(names(done.commands)).toContain("LoadIntegrationsAwsStatus")

		const dismissed = pageUpdate(done.model, Message.DismissedAwsRemoved({ connectionId }))
		expect(dismissed.model.awsCard.removed).toEqual([])
		expect(names(dismissed.commands)).toEqual(["WriteAwsRemovedStacks"])
	})

	test("a disconnect that lands after another was opened leaves that one alone", () => {
		const other = Schema.decodeSync(AwsConnectionId)("028f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8")
		const confirming = pageUpdate(
			withStatus(entered(), [connection(), connection({ id: other })]),
			Message.ClickedAwsDisconnect({ id: connectionId }),
		).model
		const sent = pageUpdate(confirming, Message.ConfirmedAwsDisconnect()).model
		const reopened = pageUpdate(
			pageUpdate(sent, Message.ClickedAwsSetup({ id: other })).model,
			Message.ClickedAwsDisconnect({ id: other }),
		).model
		const done = pageUpdate(
			reopened,
			Message.CompletedAwsDisconnect({
				id: connectionId,
				removed: {
					connectionId,
					accountId: "123456789012",
					cleanupScript: "aws cloudformation delete-stack",
				},
				error: null,
			}),
		).model
		expect(done.awsCard.disconnectId).toBe(other)
		expect(done.awsCard.disconnectDialog.isOpen).toBe(true)
		expect(done.awsCard.setupId).toBe(other)
	})

	test("entering the card reads the stacks this browser kept for the org", () => {
		expect(names(init({ search: { integration: "aws" } }, context).commands)).toContain(
			"ReadAwsRemovedStacks",
		)
	})
})
