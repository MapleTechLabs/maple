import { OrgClickHouseApplySchemaStatus, OrgClickHouseSettingsResponse } from "@maple/domain/http"
import { Result, Schema } from "effect"
import { describe, expect, test } from "vitest"
import { PageOutMessage } from "../../contract"
import { Message } from "./model"
import { init, isConnectionDirty, update } from "./update"

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
		expect(names(init().commands)).toEqual(["FetchOrgClickHouseSettings", "FetchOrgClickHouseSchemaDiff", "FetchDataPlatformUsage"])
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

	test("a run that finishes refreshes the connection and says so", () => {
		const running = update(loaded().model, Message.CompletedFetchApplyStatus({ result: Result.succeed(status("running")) })).model
		const done = update(running, Message.CompletedFetchApplyStatus({ result: Result.succeed(status("succeeded")) }))
		expect(names(done.commands)).toEqual(["FetchOrgClickHouseSettings", "FetchOrgClickHouseSchemaDiff"])
		expect(done.outMessage).toEqual(PageOutMessage.RequestedToast({ type: "success", title: "Schema applied", description: "" }))
	})
})
