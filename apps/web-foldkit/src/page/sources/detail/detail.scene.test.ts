import { OrgId } from "@maple/domain"
import { encodePublicId, PublicIdPrefixes, V2Source } from "@maple/domain/http/v2"
import { Result, Schema } from "effect"
import { expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { ResolveThemeColors, ThemeMessage } from "../../../charts/theme-colors"
import { toLoadFailure } from "../../../data/load-failure"
import { AppRoute } from "../../../route"
import { type PageContext, PageOutMessage } from "../../contract"
import { Message } from "./message"
import type { Model } from "./model"
import { init, routeChanged, update } from "./update"
import { breadcrumbsOf, view as pageView } from "./view"

const context: PageContext = { orgId: Schema.decodeSync(OrgId)("org_parity"), pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const NOW = Date.UTC(2026, 9, 1, 12)
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) => (commands ?? []).map(({ name }) => name)
const resolveTheme = Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} }))

const UUID = "0199a0e1-0000-7000-8000-000000000002"
const PUBLIC_ID = encodePublicId(PublicIdPrefixes.source, UUID)

const source = (fields: Readonly<Record<string, unknown>> = {}) =>
	Schema.decodeUnknownSync(V2Source)({
		id: PUBLIC_ID,
		object: "source",
		name: "Checkout API",
		description: null,
		platform: "nodejs",
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
		health: { status: "healthy", last_data_at: "2026-10-01T11:56:00.000Z", problem: null, resources: null },
		...fields,
	})

const route = (tab?: "setup" | "connection" | "settings", sourceId = PUBLIC_ID) =>
	AppRoute.Source({ sourceId, search: tab === undefined ? {} : { tab } })

const loaded = (row: V2Source, tab?: "setup" | "connection" | "settings"): Model => {
	const entered = init(route(tab), context).model
	return [
		Message.ReadClock({ nowMs: NOW }),
		Message.CompletedFetchList({ key: entered.list.key ?? "", result: Result.succeed([row]) }),
	].reduce((model, message) => pageUpdate(model, message).model, entered)
}

describe("source detail", () => {
	test("an id that does not decode is not found without reading the list", () => {
		const entered = init(route(undefined, "nope"), context)
		expect(names(entered.commands)).toEqual(["ReadSourceClock", "LoadChartRuntime"])
		expect(breadcrumbsOf(entered.model).map((crumb) => crumb.label)).toEqual(["Sources", "Not found"])
		scene({ update: pageUpdate, view }, given(entered.model), resolveTheme, expectView(text("Source not found")).toExist())
	})

	test("the overview reads the usage once the list has the source", () => {
		const entered = init(route(), context).model
		const step = pageUpdate(
			pageUpdate(entered, Message.ReadClock({ nowMs: NOW })).model,
			Message.CompletedFetchList({ key: entered.list.key ?? "", result: Result.succeed([source()]) }),
		)
		expect(names(step.commands)).toEqual(["FetchSourceUsage"])
		expect(breadcrumbsOf(step.model).map((crumb) => crumb.label)).toEqual(["Sources", "Checkout API"])
		scene(
			{ update: pageUpdate, view },
			given(step.model),
			resolveTheme,
			expectView(role("button", { name: "Roll token" })).toExist(),
			expectView(text("Volume, last 24 hours")).toExist(),
			expectView(role("tab", { name: "Setup" })).toExist(),
		)
	})

	test("another tab skips the usage until the overview shows", () => {
		const onSetup = loaded(source(), "setup")
		expect(onSetup.usage.key).toBeNull()
		expect(names(routeChanged(onSetup, route(), context).commands)).toEqual(["FetchSourceUsage"])
	})

	test("a push source the gateway refuses shows Failing and why", () => {
		const refused = source({
			health: {
				status: "failing",
				last_data_at: "2026-10-01T11:56:00.000Z",
				problem: "Rate limited at 200 requests per second",
				resources: null,
			},
		})
		scene(
			{ update: pageUpdate, view },
			given(loaded(refused)),
			resolveTheme,
			expectView(text("Rate limited at 200 requests per second")).toExist(),
			expectView(role("alert")).toExist(),
		)
	})

	test("the default source has no token actions", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(source({ is_default: true, key_prefix: null, name: "Default" }))),
			resolveTheme,
			expectView(role("button", { name: "Roll token" })).not.toExist(),
		)
	})

	test("a pause refreshes the list and toasts; a failure toasts the error", () => {
		const busy: Model["busy"] = "pause"
		const model: Model = { ...loaded(source()), busy }
		const done = pageUpdate(model, Message.CompletedPause({ result: Result.succeed(source({ status: "paused" })) }))
		expect(names(done.commands)).toEqual(["FetchSourceDetailList"])
		expect(done.outMessage).toEqual(
			PageOutMessage.RequestedToast({ type: "success", title: "Source paused. Takes effect within a minute.", description: "" }),
		)
		const failed = pageUpdate(model, Message.CompletedPause({ result: Result.fail(toLoadFailure(new Error("boom"))) }))
		expect(failed.model.busy).toBeNull()
		expect(failed.outMessage?._tag === "RequestedToast" && failed.outMessage.title).toBe("Failed to pause source")
	})

	test("a confirmed roll shows the new token above the tab", () => {
		const confirmed = pageUpdate(loaded(source()), Message.ConfirmedRoll())
		expect(names(confirmed.commands)).toEqual(["RollSourceToken"])
		const rolled = pageUpdate(
			confirmed.model,
			Message.CompletedRoll({ result: Result.succeed({ ...source(), secret: "maple_src_secret" }) }),
		)
		expect(names(rolled.commands)).toContain("FetchSourceDetailList")
		scene(
			{ update: pageUpdate, view },
			given(rolled.model),
			resolveTheme,
			expectView(text(/^Token rolled\./)).toExist(),
		)
	})

	test("a deleted source navigates back to the list with a toast", () => {
		const confirmed = pageUpdate(loaded(source()), Message.ConfirmedDelete())
		const deleted = pageUpdate(confirmed.model, Message.CompletedDelete({ result: Result.succeed(undefined) }))
		expect(deleted.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/sources",
				isReplace: false,
				toast: { type: "success", title: "Source deleted", description: "" },
			}),
		)
	})
})

describe("source detail tabs", () => {
	test("settings saves the rules for a token source and refreshes on success", () => {
		const model = loaded(source(), "settings")
		expect(model.settings?.name).toBe("Checkout API")
		const saving = pageUpdate(model, Message.SubmittedSettings())
		expect(names(saving.commands)).toEqual(["SaveSource"])
		const saved = pageUpdate(saving.model, Message.CompletedSave({ result: Result.succeed(source()) }))
		expect(names(saved.commands)).toEqual(["FetchSourceDetailList"])
		expect(saved.model.settings?.isSaving).toBe(false)
	})

	test("an empty name blocks the save", () => {
		const model = pageUpdate(loaded(source(), "settings"), Message.ChangedSettingsName({ value: "  " })).model
		expect(pageUpdate(model, Message.SubmittedSettings()).commands ?? []).toEqual([])
	})

	test("leaving and reopening settings drops the unsaved edit", () => {
		const edited = pageUpdate(loaded(source(), "settings"), Message.ChangedSettingsName({ value: "Renamed" })).model
		const away = routeChanged(edited, route(), context).model
		expect(away.settings).toBeNull()
		expect(routeChanged(away, route("settings"), context).model.settings?.name).toBe("Checkout API")
	})
})

describe("integration sources", () => {
	const prometheus = (fields: Readonly<Record<string, unknown>> = {}) =>
		source({
			name: "node-exporter",
			platform: "prometheus",
			key_prefix: null,
			integration_id: null,
			health: {
				status: "stale",
				last_data_at: "2026-09-30T12:00:00.000Z",
				problem: "No scrape in 10 minutes",
				resources: null,
			},
			...fields,
		})

	test("a Prometheus source opens its own target and reads that target's checks", () => {
		const target = encodePublicId(PublicIdPrefixes.scrapeTarget, "0199a0e1-0000-7000-8000-0000000000aa")
		const entered = init(route("connection"), context).model
		const step = pageUpdate(
			pageUpdate(entered, Message.ReadClock({ nowMs: NOW })).model,
			Message.CompletedFetchList({
				key: entered.list.key ?? "",
				result: Result.succeed([prometheus({ integration_id: target })]),
			}),
		)
		expect(step.model.connection?.prometheusCard.selectedId).toBe("0199a0e1-0000-7000-8000-0000000000aa")
		expect(names(step.commands)).toContain("FetchScrapeTargetChecks")
	})

	test("the list answer builds the integration and reads its statuses", () => {
		const entered = init(route(), context).model
		const step = pageUpdate(
			pageUpdate(entered, Message.ReadClock({ nowMs: NOW })).model,
			Message.CompletedFetchList({
				key: entered.list.key ?? "",
				result: Result.succeed([prometheus()]),
			}),
		)
		expect(step.model.connection).not.toBeNull()
		expect(names(step.commands)).toEqual(
			expect.arrayContaining(["FetchSourceUsage", "LoadIntegrationsScrapeTargets"]),
		)
	})

	test("Connection replaces Setup, and the overview says when it last synced", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(prometheus())),
			resolveTheme,
			expectView(role("tab", { name: "Connection" })).toExist(),
			expectView(role("tab", { name: "Setup" })).not.toExist(),
			expectView(text("Last sync")).toExist(),
		)
	})

	test("a Setup link opens Connection on an integration source, and the reverse on a push source", () => {
		expect(loaded(prometheus(), "setup").tab).toBe("connection")
		expect(loaded(source(), "connection").tab).toBe("setup")
		expect(loaded(source()).connection).toBeNull()
	})
})
