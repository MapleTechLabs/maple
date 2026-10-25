import { OrgId } from "@maple/domain"
import { Option, Result, Schema } from "effect"
import { AsyncData } from "foldkit"
import { expect as expectView, given, label, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { LinkedCursorMessage, MountLinkedCursor } from "../../charts/linked-cursor"
import { ResolveThemeColors, ThemeMessage } from "../../charts/theme-colors"
import { toLoadFailure } from "../../data/load-failure"
import { PageOutMessage, type PageContext } from "../contract"
import { Message } from "./message"
import type { FacetsHint, HealthSnapshot, Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"
import { healthData } from "./view-health"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const NOW = Date.parse("2026-10-01T12:00:00Z")
const COLD_HINT: FacetsHint = { environment: null, preset: "24h", seen: false }

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()

const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const snapshotRow = (serviceName: string): HealthSnapshot => ({
	serviceName,
	environment: "production",
	errorRate: 0.01,
	p95LatencyMs: 20,
	throughput: 1,
})

/** Entered with the clock read and a cold hint: facets, anomalies and usage in flight. */
const entered = (hint = COLD_HINT) =>
	pageUpdate(init({ search: {} }, context).model, Message.CompletedReadEntry({ nowMs: NOW, hint }))

const withFacets = (model: Model, environments: ReadonlyArray<string>) =>
	pageUpdate(
		model,
		Message.CompletedFetchFacets({
			key: model.facets.key ?? "",
			result: Result.succeed({ environments, services: ["checkout"] }),
		}),
	)

/** Everything the health sections block on has loaded, with `rows` in the snapshot. */
const loaded = (rows: ReadonlyArray<HealthSnapshot>): Model => {
	const facets = withFacets(entered().model, ["production"]).model
	const steps: ReadonlyArray<Message> = [
		Message.CompletedFetchSnapshot({ key: facets.snapshot.key ?? "", result: Result.succeed(rows) }),
		Message.CompletedFetchAnomalies({ key: facets.anomalies.key ?? "", result: Result.succeed([]) }),
		Message.UpdatedIncidents({
			orgId,
			incidents: [{ status: "open", groupKey: null, severity: "critical" }],
		}),
		Message.UpdatedRules({ orgId, enabled: [true, false] }),
	]
	return steps.reduce((model, message) => pageUpdate(model, message).model, facets)
}

type Presence = "present" | "absent"

/** The page-init presence read answered: `traces` and `logs` as given. */
const withPresence = (model: Model, traces: Presence, logs: Presence = traces): Model =>
	pageUpdate(
		model,
		Message.CompletedLoadSignalPresence({
			result: Result.succeed({
				traces: { status: traces, lastSeenMs: null },
				logs: { status: logs, lastSeenMs: null },
			}),
		}),
	).model

const themeResolved = () =>
	Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} }))
const cursorMounted = () => Mount.resolve(MountLinkedCursor, LinkedCursorMessage.CompletedMountLinkedCursor())

describe("overview", () => {
	test("entry reads the clock and hint; downstream queries wait for facets", () => {
		expect(names(init({ search: {} }, context).commands)).toEqual(
			expect.arrayContaining(["ReadOverviewEntry", "LoadOverviewSignalPresence"]),
		)
		const { commands } = entered()
		expect(names(commands)).toEqual(
			expect.arrayContaining([
				"FetchOverviewFacets",
				"FetchOverviewAnomalyCounts",
				"FetchOverviewServiceUsage",
			]),
		)
		expect(names(commands)).not.toContain("FetchOverviewTimeSeries")
	})

	test("facets with production fetch health, series and logs for it, and store the hint", () => {
		const answered = withFacets(entered().model, ["production", "staging"])
		expect(names(answered.commands)).toEqual(
			expect.arrayContaining([
				"FetchServiceHealthSnapshot",
				"FetchOverviewTimeSeries",
				"FetchOverviewLogVolume",
				"SaveOverviewFacetsHint",
			]),
		)
		expect(answered.model.overviewSeries.key).toContain("production")
		expect(answered.model.hint).toEqual({ environment: "production", preset: "24h", seen: true })
	})

	test("a seen hint fetches downstream alongside facets, filtered by the hinted environment", () => {
		const { commands, model } = entered({ environment: "staging", preset: "24h", seen: true })
		expect(names(commands)).toContain("FetchOverviewTimeSeries")
		expect(model.snapshot.key).toContain("staging")
	})

	test("a failed series is not asked again until retried", () => {
		const model = withFacets(entered().model, []).model
		const failed = pageUpdate(
			model,
			Message.CompletedFetchOverviewSeries({
				key: model.overviewSeries.key ?? "",
				result: Result.fail(toLoadFailure("boom")),
			}),
		)
		expect(names(failed.commands)).not.toContain("FetchOverviewTimeSeries")
		expect(AsyncData.isFailure(failed.model.overviewSeries.data)).toBe(true)
		const retried = pageUpdate(failed.model, Message.ClickedRetry({ target: "Overview" }))
		expect(names(retried.commands)).toEqual(["FetchOverviewTimeSeries"])
	})

	test("the page strip's retry asks a failed card's read again, not just the facets", () => {
		const model = withFacets(entered().model, []).model
		const failed = pageUpdate(
			model,
			Message.CompletedFetchOverviewSeries({
				key: model.overviewSeries.key ?? "",
				result: Result.fail(toLoadFailure("boom")),
			}),
		)
		const retried = pageUpdate(failed.model, Message.ClickedRetryPage())
		expect(names(retried.commands)).toContain("FetchOverviewTimeSeries")
	})

	test("the page strip's retry asks a failed health snapshot again", () => {
		const model = withFacets(entered().model, []).model
		const failed = pageUpdate(
			model,
			Message.CompletedFetchSnapshot({ key: model.snapshot.key ?? "", result: Result.fail(toLoadFailure("boom")) }),
		)
		const retried = pageUpdate(failed.model, Message.ClickedRetryPage())
		expect(names(retried.commands)).toContain("FetchServiceHealthSnapshot")
	})

	test("a second card's retry while the first is in flight requests nothing", () => {
		const model = withFacets(entered().model, []).model
		const failed = pageUpdate(
			model,
			Message.CompletedFetchOverviewSeries({
				key: model.overviewSeries.key ?? "",
				result: Result.fail(toLoadFailure("boom")),
			}),
		).model
		const first = pageUpdate(failed, Message.ClickedRetry({ target: "Overview" }))
		const second = pageUpdate(first.model, Message.ClickedRetry({ target: "Overview" }))
		expect(names(second.commands)).toEqual([])
		expect(second.model).toEqual(first.model)
	})

	test("an answer for a superseded environment is dropped", () => {
		const first = withFacets(entered().model, ["production"]).model
		const second = pageUpdate(first, Message.CompletedResolveClock({ nowMs: NOW + 60 * 60 * 1000 })).model
		const late = pageUpdate(
			second,
			Message.CompletedFetchSnapshot({
				key: first.snapshot.key ?? "",
				result: Result.succeed([snapshotRow("stale")]),
			}),
		)
		expect(late.model.snapshot).toEqual(second.snapshot)
	})

	test("incidents read for another org are dropped", () => {
		const other = pageUpdate(
			entered().model,
			Message.UpdatedIncidents({ orgId: "org_other", incidents: [] }),
		)
		expect(AsyncData.isLoading(other.model.incidents)).toBe(true)
	})

	test("health counts once the snapshot lands, even when the alert sync and anomaly read failed", () => {
		const facets = withFacets(entered().model, ["production"]).model
		const steps: ReadonlyArray<Message> = [
			Message.CompletedFetchSnapshot({
				key: facets.snapshot.key ?? "",
				result: Result.succeed([snapshotRow("checkout")]),
			}),
			Message.CompletedFetchAnomalies({
				key: facets.anomalies.key ?? "",
				result: Result.fail(toLoadFailure("boom")),
			}),
		]
		const waiting = steps.reduce((model, message) => pageUpdate(model, message).model, facets)
		expect(AsyncData.isLoading(healthData(waiting))).toBe(true)
		const failed = pageUpdate(waiting, Message.FailedLoadIncidents({ orgId })).model
		expect(AsyncData.getData(healthData(failed))).toEqual(
			Option.some([[snapshotRow("checkout")], [], []]),
		)
	})

	test("without live alerts the banner stays out instead of claiming all clear", () => {
		const facets = withFacets(entered().model, ["production"]).model
		const answered = pageUpdate(
			facets,
			Message.CompletedFetchSnapshot({
				key: facets.snapshot.key ?? "",
				result: Result.succeed([snapshotRow("checkout")]),
			}),
		).model
		const failed = pageUpdate(answered, Message.FailedLoadIncidents({ orgId })).model
		scene(
			{ update: pageUpdate, view },
			given(failed),
			Mount.resolveAll(
				[ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} })],
				[MountLinkedCursor, LinkedCursorMessage.CompletedMountLinkedCursor()],
			),
			expectView(text("All clear")).toBeAbsent(),
		)
	})

	test("picking an environment writes it to the URL; All environments leaves it", () => {
		const model = loaded([snapshotRow("checkout")])
		const picked = pageUpdate(
			model,
			Message.GotEnvironmentSelectMessage({
				message: { _tag: "SelectedItem", index: 1, value: "production" },
			}),
		)
		expect(picked.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/?environment=production", isReplace: false }),
		)
		const all = pageUpdate(
			model,
			Message.GotEnvironmentSelectMessage({
				message: { _tag: "SelectedItem", index: 0, value: "__all__" },
			}),
		)
		expect(all.outMessage).toEqual(PageOutMessage.RequestedNavigation({ url: "/", isReplace: false }))
	})

	test("the banner counts the firing incident and the rail counts services by health", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded([snapshotRow("checkout"), snapshotRow("cart")])),
			themeResolved(),
			cursorMounted(),
			expectView(text("Firing now")).toExist(),
			expectView(text("1 critical")).toExist(),
			expectView(role("link", { name: "View healthy services" })).toExist(),
			expectView(role("link", { name: /checkout/ })).toExist(),
		)
	})

	test("a card handed no rows says so instead of drawing bare axes", () => {
		const start = withPresence(loaded([snapshotRow("checkout")]), "present")
		const empty = pageUpdate(
			start,
			Message.CompletedFetchLogSeries({ key: start.logSeries.key ?? "", result: Result.succeed([]) }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(empty),
			themeResolved(),
			cursorMounted(),
			expectView(text("No data in this window")).toExist(),
			expectView(text("Try a wider time range")).toExist(),
		)
	})

	test("zero-filled series of a signal never received show the setup copy, not flat lines", () => {
		const start = withPresence(loaded([snapshotRow("checkout")]), "present", "absent")
		const zeros = pageUpdate(
			start,
			Message.CompletedFetchLogSeries({
				key: start.logSeries.key ?? "",
				result: Result.succeed([{ bucket: "2026-10-01 11:00:00", count: 0 }]),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(zeros),
			themeResolved(),
			cursorMounted(),
			expectView(text("No logs yet")).toExist(),
		)
	})

	test("when presence could not be read, an empty card gives no wider-range hint", () => {
		const loadedModel = loaded([snapshotRow("checkout")])
		const failed = pageUpdate(
			loadedModel,
			Message.CompletedLoadSignalPresence({ result: Result.fail(toLoadFailure("boom")) }),
		).model
		const empty = pageUpdate(
			failed,
			Message.CompletedFetchLogSeries({ key: failed.logSeries.key ?? "", result: Result.succeed([]) }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(empty),
			themeResolved(),
			cursorMounted(),
			expectView(text("No data in this window")).toExist(),
			expectView(text("Try a wider time range")).not.toExist(),
		)
	})

	test("a new workspace shows a skeleton, never the quiet-window copy, until its setup state", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded([])),
			themeResolved(),
			cursorMounted(),
			expectView(text("No services found")).not.toExist(),
			expectView(text("No data in this window")).not.toExist(),
			expectView(label("Loading")).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(withPresence(loaded([]), "absent")),
			themeResolved(),
			cursorMounted(),
			expectView(text("No services yet")).toExist(),
			expectView(text("No services found")).not.toExist(),
		)
	})

	test("an absent signal shows the setup state before the warehouse answers", () => {
		const waiting = withPresence(entered().model, "absent")
		expect(AsyncData.isLoading(healthData(waiting))).toBe(true)
		scene(
			{ update: pageUpdate, view },
			given(waiting),
			themeResolved(),
			cursorMounted(),
			expectView(text("No services yet")).toExist(),
		)
	})

	test("empty charts of a workspace that never sent the signal say so, not 'try a wider range'", () => {
		const start = withPresence(loaded([snapshotRow("checkout")]), "present", "absent")
		const empty = pageUpdate(
			start,
			Message.CompletedFetchLogSeries({ key: start.logSeries.key ?? "", result: Result.succeed([]) }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(empty),
			themeResolved(),
			cursorMounted(),
			expectView(text("No logs yet")).toExist(),
			expectView(text("No data in this window")).not.toExist(),
		)
	})

	test("a failed presence read falls back to the neutral empty copy", () => {
		const failed = pageUpdate(
			loaded([]),
			Message.CompletedLoadSignalPresence({ result: Result.fail(toLoadFailure("boom")) }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(failed),
			themeResolved(),
			cursorMounted(),
			expectView(text("No services found")).toExist(),
		)
	})

	test("Reload re-reads the clock and spins for the reload", () => {
		const reloaded = pageUpdate(loaded([]), Message.ClickedReload())
		expect(names(reloaded.commands)).toEqual(
			expect.arrayContaining(["ResolveOverviewClock", "CompleteOverviewReloadSpin"]),
		)
		const settled = pageUpdate(
			reloaded.model,
			Message.CompletedReloadSpin({ version: reloaded.model.refreshVersion }),
		)
		expect(settled.model.isReloading).toBe(false)
	})
})
