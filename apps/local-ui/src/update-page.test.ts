import { Option } from "effect"
import { AsyncData } from "foldkit"
import { toParentMessage } from "foldkit/test"
import { fromString } from "foldkit/url"
import { describe, expect, test } from "vitest"
import { FetchSignalPresence, LoadExternal, ProbeServer, WaitBeforeProbe } from "./command"
import { init } from "./main"
import type { Model } from "./model"
import { FetchLogs, FetchServices, FetchSeverities } from "./page/logs/command"
import { Message as LogsMessage } from "./page/logs/message"
import { LogsBinding, TracesBinding } from "./page/registry"
import { Message as TracesMessage } from "./page/traces/message"
import { update } from "./update"
import { Message } from "./message"
import { ProbeOutcome } from "./server/state"

const flags = {
	env: { apiBase: "", port: "4318", otlpEndpoint: "http://127.0.0.1:4318", isHosted: false },
	rememberedRange: "1h",
	isSidebarOpen: true,
	isMobile: false,
	theme: "dark" as const,
	timeFormat: { locale: "en-US", timeZone: "UTC" },
	hasSavedResults: false,
}
const url = Option.getOrThrow(fromString("http://localhost/#/traces"))
const NOW = Date.parse("2026-10-01T12:00:30Z")

/** Settled: the first probe answered and a fresh presence read is on hand. */
const settled = (): Model => ({
	...init(flags, url).model,
	probe: { isInFlight: false, version: 1 },
	presence: AsyncData.Success({ data: { rows: [], nowMs: 1_000 } }),
})
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) => (commands ?? []).map(({ name }) => name)
const rootNames = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	names(commands).filter((name) => name === ProbeServer.name || name === FetchSignalPresence.name)
const argsOf = (commands: ReadonlyArray<{ readonly name: string; readonly args?: unknown }> | undefined) =>
	(commands ?? []).filter(({ name }) => name === FetchSignalPresence.name).map(({ args }) => args)

/** /traces with its clock read: the list and facets in flight under the current minute. */
const loadingTraces = (model: Model): Model =>
	update(model, toParentMessage(TracesBinding, TracesMessage.CompletedReadClock({ nowMs: NOW }))).model
const tracesKey = (model: Model): string => (model.page._tag === "TracesPage" ? (model.page.traces.key ?? "") : "")
/** The list answered empty: the page renders `SignalEmptyState` and asks for the presence. */
const answerEmpty = (model: Model) =>
	update(
		model,
		toParentMessage(
			TracesBinding,
			TracesMessage.SucceededFetchTraces({
				key: tracesKey(model),
				data: { pages: [[]], hasNextPage: false },
				fetchedAtMs: NOW,
			}),
		),
	)

describe("refresh in place", () => {
	test("re-probes the server, and the next empty state reads the presence again", () => {
		const loading = loadingTraces(settled())
		const refreshed = update(loading, toParentMessage(TracesBinding, TracesMessage.CompletedReadRefreshClock({ nowMs: NOW })))
		expect(rootNames(refreshed.commands)).toEqual([ProbeServer.name])
		const requested = answerEmpty(refreshed.model)
		expect(rootNames(requested.commands)).toEqual([FetchSignalPresence.name])
		expect(argsOf(requested.commands)).toEqual([{ apiBase: "", lastReadAtMs: null }])
	})

	test("without a refresh, a fresh presence read is offered for reuse", () => {
		const requested = answerEmpty(loadingTraces(settled()))
		expect(argsOf(requested.commands)).toEqual([{ apiBase: "", lastReadAtMs: 1_000 }])
	})
})

describe("superseded requests", () => {
	const urlOf = (hash: string) => Option.getOrThrow(fromString(`http://localhost/${hash}`))
	/** /logs with its list and both facets in flight. */
	const loadingLogs = (): Model => {
		const opened = update(settled(), Message.ChangedUrl({ url: urlOf("#/logs") })).model
		return update(opened, toParentMessage(LogsBinding, LogsMessage.CompletedReadClock({ nowMs: NOW }))).model
	}
	const logStops = [FetchLogs, FetchServices, FetchSeverities].map(({ name }) => `${name}.Interrupt`)
	const stops = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
		names(commands).filter((name) => name.endsWith(".Interrupt"))

	test("a new search stops the list and facet requests it supersedes", () => {
		const searched = update(loadingLogs(), Message.ChangedUrl({ url: urlOf("#/logs?q=timeout") }))
		expect(stops(searched.commands)).toEqual(logStops)
	})

	test("leaving the page stops what it still has in flight", () => {
		const left = update(loadingLogs(), Message.ChangedUrl({ url: urlOf("#/traces") }))
		expect(stops(left.commands)).toEqual(logStops)
	})

	test("an answer that lands stops nothing", () => {
		const model = loadingLogs()
		const key = model.page._tag === "LogsPage" ? (model.page.logs.key ?? "") : ""
		const answer = LogsMessage.SucceededFetchLogs({ key, data: { pages: [[]], hasNextPage: false }, fetchedAtMs: NOW })
		expect(stops(update(model, toParentMessage(LogsBinding, answer)).commands)).toEqual([])
	})
})

describe("signed-out self-hosted server", () => {
	const rejected = (model: Model, status: number) =>
		update(model, Message.CompletedProbeServer({ outcome: ProbeOutcome.Rejected({ status, detail: "" }), checkedAtMs: 1 }))

	test("a 401 probe sends the bundled UI to the sign-in page", () => {
		const signedOut = rejected(settled(), 401)
		expect(names(signedOut.commands)).toEqual([LoadExternal.name])
		expect((signedOut.commands ?? []).map(({ args }) => args)).toEqual([{ href: "/login" }])
	})

	test("the hosted UI and other rejections keep probing", () => {
		const hosted = { ...settled(), env: { ...flags.env, isHosted: true } }
		expect(names(rejected(hosted, 401).commands)).toEqual([WaitBeforeProbe.name])
		expect(names(rejected(settled(), 403).commands)).toEqual([WaitBeforeProbe.name])
	})
})
