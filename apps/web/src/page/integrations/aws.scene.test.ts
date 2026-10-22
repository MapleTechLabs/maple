import { OrgId } from "@maple/domain"
import { Timestamp, type V2AwsConnection, type V2AwsIntegration } from "@maple/domain/http/v2"
import { AwsAccountId, AwsConnectionId } from "@maple/domain/primitives"
import { Result, Schema } from "effect"
import { AsyncData } from "foldkit"
import { describe, expect, test } from "vitest"
import * as Field from "../../ui/field"
import { PageOutMessage, type PageContext } from "../contract"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { statusKey } from "./update-status"
import { overviewOf } from "./derive"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const connectionId = Schema.decodeSync(AwsConnectionId)("018f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8")

const connection = (overrides: Partial<V2AwsConnection> = {}): V2AwsConnection => ({
	id: connectionId,
	object: "aws_connection",
	account_id: Schema.decodeSync(AwsAccountId)("123456789012"),
	role_arn: "arn:aws:iam::123456789012:role/MapleIntegration-018f2b3c4d5e4f708192a3b4",
	external_id: "9f1c4e2a7b3d4c6e8a0b1c2d3e4f5a6b",
	modules: [],
	granted_modules: null,
	template_version: null,
	setup_outdated: false,
	verified_at: null,
	last_checked_at: null,
	last_check_error: null,
	metric_stream: null,
	metrics_last_received_at: null,
	metrics_last_error: null,
	created_at: Schema.decodeSync(Timestamp)("2026-10-21T12:00:00.000Z"),
	...overrides,
})

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
				removed: { connectionId, accountId: "123456789012", cleanupScript: "aws cloudformation delete-stack" },
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
