import { OrgClickHouseApplySchemaStarted, OrgClickHouseApplySchemaStatus, OrgClickHouseSettingsResponse } from "@maple/domain/http"
import { Result, Schema } from "effect"
import { describe, expect, test } from "vitest"
import { PageOutMessage } from "../../contract"
import { Message, type Model } from "./model"
import { init, isConnectionDirty, isRunActive, update } from "./update"

const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) => (commands ?? []).map(({ name }) => name)

const settings = Schema.decodeUnknownSync(OrgClickHouseSettingsResponse)({
	configured: true,
	chUrl: "https://ch.acme.test:8443",
	chUser: "maple_writer",
	chDatabase: "maple",
	syncStatus: "connected",
	lastSyncAt: "2026-10-17T11:56:00.000Z",
	lastSyncError: null,
	schemaVersion: "2026-09-30.1",
})
const status = (value: "running" | "succeeded") =>
	Schema.decodeUnknownSync(OrgClickHouseApplySchemaStatus)({
		status: value,
		phase: null,
		currentMigration: null,
		stepsTotal: null,
		stepsDone: null,
		appliedVersions: [],
		skipped: [],
		errorMessage: null,
		startedAt: null,
		finishedAt: null,
	})

const loaded = () => update(init().model, Message.CompletedFetchSettings({ result: Result.succeed(settings) }))

describe("data platform tab", () => {
	test("a configured cluster also reads the apply status", () => {
		expect(names(init().commands)).toEqual(
			expect.arrayContaining(["FetchOrgClickHouseSettings", "FetchOrgClickHouseSchemaDiff", "FetchDataPlatformUsage"]),
		)
		expect(names(init().commands)).not.toContain("FetchOrgClickHouseApplyStatus")
		expect(names(loaded().commands)).toEqual(["FetchOrgClickHouseApplyStatus"])
	})

	test("an edit is dirty and Save sends the trimmed connection", () => {
		const edited = update(loaded().model, Message.ChangedConnection({ field: "database", value: " maple_prod " })).model
		expect(isConnectionDirty(edited)).toBe(true)
		expect(update(edited, Message.ClickedSave()).commands?.[0]).toMatchObject({
			name: "SaveOrgClickHouseConnection",
			args: { request: { url: "https://ch.acme.test:8443", user: "maple_writer", database: "maple_prod" } },
		})
	})

	const answer = (model: Model, sequence: number, value: "running" | "succeeded") =>
		update(model, Message.CompletedFetchApplyStatus({ sequence, result: Result.succeed(status(value)) }))

	test("a run that finishes refreshes the connection and says so", () => {
		const running = answer(loaded().model, 1, "running").model
		const polled = update(running, Message.TickedApplyPoll()).model
		const done = answer(polled, 2, "succeeded")
		expect(names(done.commands)).toContain("FetchOrgClickHouseSettings")
		expect(names(done.commands)).toContain("FetchOrgClickHouseSchemaDiff")
		expect(done.outMessage).toEqual(
			PageOutMessage.RequestedToast({ type: "success", title: "Schema applied", description: "" }),
		)
	})

	test("a poll tick waits on a read still out, and a late running answer cannot undo a finished run", () => {
		const running = answer(loaded().model, 1, "running").model
		const polled = update(running, Message.TickedApplyPoll())
		expect(names(polled.commands)).toEqual(["FetchOrgClickHouseApplyStatus"])
		expect(names(update(polled.model, Message.TickedApplyPoll()).commands)).toEqual([])
		// A second read (the run was started again) answers first with the finished run.
		const started = update(
			polled.model,
			Message.CompletedApply({ result: Result.succeed(new OrgClickHouseApplySchemaStarted({ status: "already_running" })) }),
		).model
		const done = answer(started, 3, "succeeded")
		expect(done.outMessage).toEqual(PageOutMessage.RequestedToast({ type: "success", title: "Schema applied", description: "" }))
		const late = answer(done.model, 2, "running")
		expect(late.outMessage).toBeUndefined()
		expect(isRunActive(late.model)).toBe(false)
	})
})
