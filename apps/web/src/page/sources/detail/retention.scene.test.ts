import { OrgId } from "@maple/domain"
import type * as Policy from "@maple/domain/policy"
import { encodePublicId, PublicIdPrefixes, V2RetentionPolicy, V2Source } from "@maple/domain/http/v2"
import type { RetentionDays } from "@maple/domain/retention"
import { Array as Arr, Result, Schema } from "effect"
import { expect as expectView, given, label, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { ResolveThemeColors, ThemeMessage } from "@maple/views/charts/theme-colors"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { AppRoute } from "../../../route"
import type { PageContext } from "../../contract"
import { Message } from "./message"
import type { Model } from "./model"
import { changedRetentionSignals } from "./retention"
import { OWN_WAREHOUSE_NOTE } from "./view-retention"
import { init, isTabDirty, update } from "./update"
import { view as pageView } from "./view"

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_retention"),
	pinnedNamespace: null,
	timeZone: "UTC",
}
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const resolveTheme = Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} }))
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)

// 2026-11-25 12:00 UTC.
const NOW = Date.UTC(2026, 10, 25, 12)
const UUID = "0199a0e1-0000-7000-8000-000000000002"
const PUBLIC_ID = encodePublicId(PublicIdPrefixes.source, UUID)

const DEFAULTS = { traces: 30, logs: 30, metrics: 90, sessions: 30, events: 365, profiles: 14 }
const NOTHING_SET = { traces: null, logs: null, metrics: null, sessions: null, events: null, profiles: null }

const source = Schema.decodeSync(V2Source)({
	id: PUBLIC_ID,
	object: "source",
	name: "Checkout API",
	description: null,
	platform: "nodejs",
	kind: "token",
	is_default: false,
	key_prefix: "maple_src_Q7xZa",
	integration_id: null,
	status: "active",
	allowed_signals: ["traces", "logs"],
	rate_limit_rps: 200,
	resource_attributes: [],
	expires_at: null,
	paused_at: null,
	paused_until: null,
	last_used_at: null,
	rolled_at: null,
	created_at: "2026-09-01T12:00:00.000Z",
	updated_at: "2026-09-01T12:00:00.000Z",
	health: { status: "healthy", last_data_at: "2026-11-25T11:56:00.000Z", problem: null, resources: null },
})

/** The org keeps logs 90 days; this source keeps its own traces period when `traces` is set. */
const policy = (traces: RetentionDays | null, storage: "managed" | "own_warehouse" = "managed") =>
	Schema.decodeSync(V2RetentionPolicy)({
		object: "retention_policy",
		storage,
		periods: [3, 7, 14, 30, 60, 90, 180, 365, 730],
		defaults: DEFAULTS,
		organization: { set: { ...NOTHING_SET, logs: 90 }, days: { ...DEFAULTS, logs: 90 } },
		read_horizon_days: { ...DEFAULTS, logs: 90 },
		sources:
			traces === null
				? []
				: [
						{
							source_id: PUBLIC_ID,
							set: { ...NOTHING_SET, traces },
							days: { ...DEFAULTS, logs: 90, traces },
						},
					],
	})

const ADMIN: ReadonlyArray<Policy.Permission> = ["telemetry:read", "sources:manage", "retention:manage"]
const SOURCE_MANAGER: ReadonlyArray<Policy.Permission> = ["telemetry:read", "sources:manage"]

const run = (model: Model, messages: ReadonlyArray<Message>): Model =>
	Arr.reduce(messages, model, (current, message) => pageUpdate(current, message).model)

const onSettings = (grants = ADMIN) => {
	const entered = init(AppRoute.Source({ sourceId: PUBLIC_ID, search: { tab: "settings" } }), context).model
	const step = pageUpdate(
		run(entered, [
			Message.ReadClock({ nowMs: NOW }),
			Message.CompletedReadGrants({ grants: [...grants] }),
		]),
		Message.CompletedFetchList({ key: entered.list.key ?? "", result: Result.succeed([source]) }),
	)
	return step
}

const loaded = (traces: RetentionDays | null = 7, grants = ADMIN) =>
	pageUpdate(
		onSettings(grants).model,
		Message.CompletedFetchRetention({ result: Result.succeed(policy(traces)) }),
	).model

const pick = (model: Model, signal: "traces" | "logs", value: string) =>
	pageUpdate(model, Message.ChangedRetentionPeriod({ signal, value })).model

describe("source retention", () => {
	test("opening Settings reads the policy, and shows a skeleton until it answers", () => {
		const step = onSettings()
		expect(names(step.commands)).toContain("FetchSourceRetention")
		scene(
			{ update: pageUpdate, view },
			given(step.model),
			resolveTheme,
			expectView(role("heading", { name: "Retention" })).toExist(),
			expectView(label("Loading retention")).toExist(),
		)
	})

	test("a failed read offers a retry that reads again", () => {
		const failed = pageUpdate(
			onSettings().model,
			Message.CompletedFetchRetention({ result: Result.fail(toLoadFailure(new Error("down"))) }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(failed),
			resolveTheme,
			expectView(text("Couldn't load retention")).toExist(),
		)
		expect(names(pageUpdate(failed, Message.ClickedRetryRetention()).commands)).toEqual([
			"FetchSourceRetention",
		])
	})

	test("rows follow the source's signals: an own period, or the organization's", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(7)),
			resolveTheme,
			expectView(role("combobox", { name: "Traces" })).toHaveValue("7"),
			expectView(role("combobox", { name: "Logs" })).toHaveValue("inherit"),
			expectView(role("option", { name: "Organization (90 days)" })).toExist(),
			expectView(role("option", { name: "Organization (30 days)" })).toExist(),
			expectView(role("combobox", { name: "Metrics" })).not.toExist(),
			expectView(text("Log records and their attributes.")).toExist(),
		)
	})

	test("following the organization again says what that does and when", () => {
		// Traces go from its own 1 week to the organization's 30 days.
		const edited = pick(loaded(7), "traces", "inherit")
		scene(
			{ update: pageUpdate, view },
			given(edited),
			resolveTheme,
			expectView(
				text("Applies to spans received from now on. 30 days of history fills in by Dec 18."),
			).toExist(),
		)
	})

	test("a shorter own period says what is hidden now and when it is gone", () => {
		const edited = pick(loaded(7), "logs", "14")
		scene(
			{ update: pageUpdate, view },
			given(edited),
			resolveTheme,
			expectView(
				text(
					"Logs older than 2 weeks are hidden once you save, and deleted by Feb 9, 2027. Switch back before then to see them again.",
				),
			).toExist(),
		)
	})

	test("save sends only the changed signals, null to follow the organization, and stores the answer", () => {
		const edited = pick(pick(loaded(7), "traces", "inherit"), "logs", "180")
		expect(changedRetentionSignals(edited.retention, edited.sourceId)).toEqual(["traces", "logs"])
		const saving = pageUpdate(edited, Message.SubmittedSettings())
		expect(saving.commands).toEqual([
			expect.objectContaining({
				name: "SaveSourceRetention",
				args: expect.objectContaining({ payload: { traces: null, logs: 180 } }),
			}),
		])
		expect(saving.model.retention?.isSaving).toBe(true)
		const saved = pageUpdate(
			saving.model,
			Message.CompletedSaveRetention({ result: Result.succeed(policy(null)) }),
		)
		expect(saved.outMessage).toMatchObject({ type: "success", title: "Retention saved" })
		expect(saved.model.retention?.isSaving).toBe(false)
		expect(saved.model.retention?.draft?.traces).toBeNull()
	})

	test("one save bar covers the name and retention, and stays pending until both answer", () => {
		const edited = pick(
			pageUpdate(loaded(7), Message.ChangedSettingsName({ value: "Renamed" })).model,
			"traces",
			"30",
		)
		expect(isTabDirty(edited)).toBe(true)
		const saving = pageUpdate(edited, Message.SubmittedSettings())
		expect(names(saving.commands)).toContain("SaveSource")
		expect(names(saving.commands)).toContain("SaveSourceRetention")
		const sourceDone = pageUpdate(
			saving.model,
			Message.CompletedSave({
				result: Result.succeed({
					...source,
					name: "Renamed",
					updated_at: "2026-11-25T12:00:00.000Z",
				}),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(sourceDone),
			resolveTheme,
			expectView(role("combobox", { name: "Traces" })).toBeDisabled(),
		)
		const bothDone = pageUpdate(
			sourceDone,
			Message.CompletedSaveRetention({ result: Result.succeed(policy(30)) }),
		)
		// The source's answer already toasted.
		expect(bothDone.outMessage).toBeUndefined()
		expect(bothDone.model.retention?.isSaving).toBe(false)
		expect(changedRetentionSignals(bothDone.model.retention, bothDone.model.sourceId)).toEqual([])
	})

	test("a failed retention save keeps the edit; discard resets it", () => {
		const edited = pick(loaded(7), "logs", "365")
		const saving = pageUpdate(edited, Message.SubmittedSettings()).model
		const failed = pageUpdate(
			saving,
			Message.CompletedSaveRetention({ result: Result.fail(toLoadFailure(new Error("down"))) }),
		)
		expect(failed.outMessage).toMatchObject({ type: "error", title: "Couldn't save retention" })
		expect(changedRetentionSignals(failed.model.retention, failed.model.sourceId)).toEqual(["logs"])
		const discarded = pageUpdate(failed.model, Message.ClickedDiscardSettings()).model
		expect(isTabDirty(discarded)).toBe(false)
	})

	test("an org on its own ClickHouse gets a note, not periods", () => {
		const own = pageUpdate(
			onSettings().model,
			Message.CompletedFetchRetention({ result: Result.succeed(policy(null, "own_warehouse")) }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(own),
			resolveTheme,
			expectView(text(OWN_WAREHOUSE_NOTE)).toExist(),
			expectView(role("combobox", { name: "Traces" })).not.toExist(),
		)
	})

	test("without Manage retention the selects are disabled and picks do nothing", () => {
		const member = loaded(7, SOURCE_MANAGER)
		expect(pick(member, "logs", "7").retention?.draft).toEqual(member.retention?.draft)
		scene(
			{ update: pageUpdate, view },
			given(member),
			resolveTheme,
			expectView(role("combobox", { name: "Traces" })).toBeDisabled(),
			expectView(role("combobox", { name: "Logs" })).toBeDisabled(),
		)
	})
})
