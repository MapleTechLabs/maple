import type * as Policy from "@maple/domain/policy"
import { encodePublicId, PublicIdPrefixes, V2RetentionPolicy } from "@maple/domain/http/v2"
import { Array as Arr, Result, Schema } from "effect"
import { expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import type { RetentionDays } from "@maple/domain/retention"
import { describe, expect, test } from "vitest"
import { Message } from "./model"
import { changedSignals, init, update } from "./update"
import { view } from "./view"

const DEFAULTS = { traces: 30, logs: 30, metrics: 90, sessions: 30, events: 365, profiles: 14 }
const NOTHING_SET = { traces: null, logs: null, metrics: null, sessions: null, events: null, profiles: null }
const SOURCE_UUID = "4f0d7c2e-8a51-4b6e-9c1d-2a7e5b3f9d10"
const SOURCE_ID = encodePublicId(PublicIdPrefixes.source, SOURCE_UUID)

const policy = (logs: RetentionDays | null = null) =>
	Schema.decodeSync(V2RetentionPolicy)({
		object: "retention_policy",
		storage: "managed",
		periods: [3, 7, 14, 30, 60, 90, 180, 365, 730],
		defaults: DEFAULTS,
		organization: { set: { ...NOTHING_SET, logs }, days: { ...DEFAULTS, logs: logs ?? 30 } },
		read_horizon_days: { ...DEFAULTS, logs: 180 },
		sources: [
			{
				source_id: SOURCE_ID,
				set: { ...NOTHING_SET, logs: 180 },
				days: { ...DEFAULTS, logs: 180 },
			},
		],
	})

const ADMIN: ReadonlyArray<Policy.Permission> = ["telemetry:read", "sources:manage", "retention:manage"]
const MEMBER: ReadonlyArray<Policy.Permission> = ["telemetry:read"]

const loaded = (grants = ADMIN, logs: RetentionDays | null = null) =>
	update(init(grants).model, Message.CompletedFetchPolicy({ result: Result.succeed(policy(logs)) })).model

// 2026-11-25 12:00 UTC.
const NOW = Date.UTC(2026, 10, 25, 12)
const inputs = { timeZone: "UTC", canOpenDataPlatform: false }

/** A period picked, with the clock read that picking it asks for. */
const pick = (model: ReturnType<typeof loaded>, signal: "traces" | "logs", value: string) =>
	update(update(model, Message.ChangedPeriod({ signal, value })).model, Message.ReadClock({ nowMs: NOW }))
		.model

/** An org that keeps logs for `logs` days with no source of its own: reads reach exactly that. */
const withoutSources = (logs: RetentionDays) =>
	Schema.decodeSync(V2RetentionPolicy)({
		...Schema.encodeSync(V2RetentionPolicy)(policy(logs)),
		read_horizon_days: { ...DEFAULTS, logs },
		sources: [],
	})

const loadedWith = (stored: V2RetentionPolicy, grants = ADMIN) =>
	update(init(grants).model, Message.CompletedFetchPolicy({ result: Result.succeed(stored) })).model

const withNames = (model: ReturnType<typeof loaded>) =>
	update(
		model,
		Message.CompletedFetchSources({
			result: Result.succeed([{ id: SOURCE_UUID, name: "checkout-api" }]),
		}),
	).model

describe("retention tab", () => {
	test("entry reads the policy and the source names", () => {
		const names = Arr.map(init(ADMIN).commands ?? [], (command) => command.name)
		expect(names).toContain("FetchRetention")
		expect(names).toContain("FetchRetentionSourceNames")
	})

	test("a shorter period hides older data when nothing keeps it longer", () => {
		const edited = pick(loaded(), "traces", "7")
		scene(
			{ update, view: withViewInputs(view, inputs)() },
			given(edited),
			expectView(
				text(
					"Spans older than 7 days are hidden once you save. Switch back to see them again while they are still stored.",
				),
			).toExist(),
			expectView(text("1 unsaved change")).toExist(),
		)
	})

	test("a shorter period hides nothing while a source keeps longer", () => {
		const edited = pick(loaded(), "logs", "7")
		scene(
			{ update, view: withViewInputs(view, inputs)() },
			given(edited),
			expectView(
				text(
					"Logs arriving from a minute after you save are kept for 7 days. Logs already stored keep the period they arrived under. 1 source keeps its own period and is not affected.",
				),
			).toExist(),
		)
	})

	test("a longer period applies from now on and names the day the full history is there", () => {
		const edited = pick(loaded(), "traces", "90")
		scene(
			{ update, view: withViewInputs(view, inputs)() },
			given(edited),
			expectView(
				text(
					"Applies to spans arriving from a minute after you save. 90 days of history is there by Feb 23, 2027.",
				),
			).toExist(),
		)
	})

	test("before the clock is read, a longer period names no date", () => {
		const edited = update(loaded(), Message.ChangedPeriod({ signal: "traces", value: "90" })).model
		expect(
			Arr.map(
				update(loaded(), Message.ChangedPeriod({ signal: "traces", value: "90" })).commands ?? [],
				(command) => command.name,
			),
		).toEqual(["ReadRetentionClock"])
		scene(
			{ update, view: withViewInputs(view, inputs)() },
			given(edited),
			expectView(text("Applies to spans arriving from a minute after you save.")).toExist(),
		)
	})

	test("an explicit 90 days back to the default hides logs older than the default", () => {
		const edited = pick(loadedWith(withoutSources(90)), "logs", "30")
		scene(
			{ update, view: withViewInputs(view, inputs)() },
			given(edited),
			expectView(
				text(
					"Logs older than 30 days are hidden once you save. Switch back to see them again while they are still stored.",
				),
			).toExist(),
		)
	})

	test("a longer period says which sources keep their own and are not affected", () => {
		const edited = pick(loaded(), "logs", "90")
		scene(
			{ update, view: withViewInputs(view, inputs)() },
			given(edited),
			expectView(
				text(
					"Applies to logs arriving from a minute after you save. 90 days of history is there by Feb 23, 2027. 1 source keeps its own period and is not affected.",
				),
			).toExist(),
		)
	})

	test("a longer period promises no history when every source keeps its own", () => {
		const edited = pick(withNames(loaded()), "logs", "90")
		scene(
			{ update, view: withViewInputs(view, inputs)() },
			given(edited),
			expectView(
				text(
					"Every source keeps its own period for logs, so none is affected now. A source that follows the organization later keeps 90 days.",
				),
			).toExist(),
		)
	})

	test("several signals changed in one save each say what they do", () => {
		const edited = pick(pick(loadedWith(withoutSources(90)), "logs", "30"), "traces", "7")
		scene(
			{ update, view: withViewInputs(view, inputs)() },
			given(edited),
			expectView(
				text(
					"Logs older than 30 days are hidden once you save. Switch back to see them again while they are still stored.",
				),
			).toExist(),
			expectView(
				text(
					"Spans older than 7 days are hidden once you save. Switch back to see them again while they are still stored.",
				),
			).toExist(),
			expectView(text("2 unsaved changes")).toExist(),
		)
	})

	test("save sends only what changed, and picking the default clears the override", () => {
		const edited = update(
			update(loaded(ADMIN, 90), Message.ChangedPeriod({ signal: "logs", value: "30" })).model,
			Message.ChangedPeriod({ signal: "traces", value: "7" }),
		).model
		const saving = update(edited, Message.ClickedSave())
		expect(saving.commands?.[0]).toMatchObject({
			name: "SaveRetention",
			args: { payload: { logs: null, traces: 7 } },
		})
		const saved = update(
			saving.model,
			Message.CompletedSave({ result: Result.succeed(policy(null)) }),
		).model
		expect(saved.isSaving).toBe(false)
		expect(changedSignals(saved)).toEqual([])
	})

	test("discard goes back to what is stored", () => {
		const edited = update(loaded(), Message.ChangedPeriod({ signal: "logs", value: "365" })).model
		expect(changedSignals(edited)).toEqual(["logs"])
		expect(changedSignals(update(edited, Message.ClickedDiscard()).model)).toEqual([])
	})

	test("without Manage retention the periods are read only and saving does nothing", () => {
		const member = loaded(MEMBER)
		expect(update(member, Message.ChangedPeriod({ signal: "logs", value: "7" })).model.draft).toEqual(
			member.draft,
		)
		expect(update(member, Message.ClickedSave()).commands ?? []).toEqual([])
		scene(
			{ update, view: withViewInputs(view, inputs)() },
			given(member),
			expectView(role("combobox", { name: "Logs" })).toBeDisabled(),
			expectView(
				text("Only people with Manage retention can change these periods. Admin has it."),
			).toExist(),
		)
	})

	test("a source with its own period is listed with its signals", () => {
		const named = update(
			loaded(),
			Message.CompletedFetchSources({
				result: Result.succeed([{ id: SOURCE_UUID, name: "checkout-api" }]),
			}),
		).model
		scene(
			{ update, view: withViewInputs(view, inputs)() },
			given(named),
			expectView(role("link", { name: "checkout-api" })).toExist(),
			expectView(text("Logs 180 days")).toExist(),
			expectView(
				text(
					"A source can keep a signal shorter or longer than the organization, from its Settings tab. Reads reach as far back as the longest of them.",
				),
			).toExist(),
		)
		// Without Manage sources the name is not a link to a tab the viewer cannot open.
		const retentionOnly = { ...named, grants: ["telemetry:read", "retention:manage"] as const }
		scene(
			{ update, view: withViewInputs(view, inputs)() },
			given(retentionOnly),
			expectView(role("link", { name: "checkout-api" })).not.toExist(),
			expectView(text("checkout-api")).toExist(),
			expectView(
				text(
					"A source can keep a signal shorter or longer than the organization. Reads reach as far back as the longest of them.",
				),
			).toExist(),
		)
	})

	test("session replays and product events show their period with no picker", () => {
		scene(
			{ update, view: withViewInputs(view, inputs)() },
			given(loaded()),
			expectView(role("combobox", { name: "Traces" })).toExist(),
			expectView(role("combobox", { name: "Session replays" })).not.toExist(),
			expectView(role("combobox", { name: "Product events" })).not.toExist(),
			expectView(text("365 days")).toExist(),
		)
	})

	test("an org on its own ClickHouse is told its cluster keeps the retention, with no pickers", () => {
		const own = update(
			init(ADMIN).model,
			Message.CompletedFetchPolicy({
				result: Result.succeed({ ...policy(), storage: "own_warehouse" }),
			}),
		).model
		scene(
			{ update, view: withViewInputs(view, inputs)() },
			given(own),
			expectView(text("Your ClickHouse keeps its own retention")).toExist(),
			expectView(role("combobox", { name: "Logs" })).not.toExist(),
			expectView(text("Sources with their own period")).not.toExist(),
			expectView(role("link", { name: "Data platform" })).not.toExist(),
		)
		scene(
			{ update, view: withViewInputs(view, { ...inputs, canOpenDataPlatform: true })() },
			given(own),
			expectView(role("link", { name: "Data platform" })).toExist(),
		)
	})

	test("on its own ClickHouse a member sees no note about who can change the periods", () => {
		const own = loadedWith({ ...policy(), storage: "own_warehouse" }, MEMBER)
		scene(
			{ update, view: withViewInputs(view, inputs)() },
			given(own),
			expectView(
				text("Only people with Manage retention can change these periods. Admin has it."),
			).not.toExist(),
			expectView(
				text("How long each signal is kept is set in your organization's own ClickHouse, not here."),
			).toExist(),
		)
	})
})
