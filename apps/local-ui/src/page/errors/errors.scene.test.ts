import { DateTime, Option } from "effect"
import { expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../contract"
import { PageOutMessage } from "../contract"
import type { ErrorTypeRow } from "./fetch"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const NOW = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-01T12:00:00Z"))
const env = { apiBase: "", port: "4318", otlpEndpoint: "http://localhost:4318", isHosted: false }
const contextAt = (search: string): PageContext => ({
	env,
	location: { path: "/errors", search },
	rememberedRange: "1h",
	timeFormat: { locale: "en-US", timeZone: "UTC" },
	canGoBack: false,
})
const context = contextAt("")
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const inputs = {
	context,
	presenceOf: () => Option.none(),
	presenceNowMs: 0,
	clockMs: 0,
	hasNewDataSince: () => false,
}
const view = withViewInputs(pageView, inputs)()

const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const row = (fingerprintHash: string, errorLabel: string): ErrorTypeRow => ({
	fingerprintHash,
	errorLabel,
	sampleMessage: "timed out acquiring a connection",
	count: 8,
	affectedServicesCount: 1,
	serviceNames: ["payment-svc"],
	lastSeen: DateTime.makeUnsafe(NOW - 60_000),
})

const entered = () => pageUpdate(init(context).model, Message.CompletedReadClock({ nowMs: NOW }))

const loaded = (rows: ReadonlyArray<ErrorTypeRow>): Model => {
	const model = entered().model
	return pageUpdate(
		model,
		Message.SucceededFetchByType({ key: model.byType.key ?? "", rows, fetchedAtMs: NOW }),
	).model
}

describe("local errors", () => {
	test("entry reads the clock, then asks for the summary, the types and the facets, and the presence", () => {
		expect(names(init(context).commands)).toContain("ReadErrorsClock")
		const step = entered()
		expect(names(step.commands)).toEqual(
			expect.arrayContaining([
				"FetchLocalErrorsSummary",
				"FetchLocalErrorsByType",
				"FetchLocalErrorsFacets",
			]),
		)
		expect(step.outMessage).toEqual(PageOutMessage.RequestedSignalPresence())
	})

	test("an answer for a superseded filter is dropped", () => {
		const first = entered().model
		const filtered = update(
			first,
			Message.CompletedReadClock({ nowMs: NOW }),
			contextAt("service=checkout-api"),
		).model
		const dropped = pageUpdate(
			filtered,
			Message.SucceededFetchByType({
				key: first.byType.key ?? "",
				rows: [row("a", "Stale")],
				fetchedAtMs: NOW,
			}),
		)
		expect(dropped.model.byType).toEqual(filtered.byType)
	})

	test("no errors and no telemetry shows the unknown-presence empty state", () => {
		scene({ update: pageUpdate, view }, given(loaded([])), expectView(text("No errors found")).toExist())
	})

	test("a card opens to its traces, asked for once", () => {
		const model = loaded([row("fp1", "ConnectionTimeout")])
		const opened = pageUpdate(model, Message.ClickedErrorType({ fingerprintHash: "fp1" }))
		expect(names(opened.commands)).toEqual(["FetchLocalErrorTraces"])
		const key = opened.model.cards.fp1?.traces.key ?? ""
		const answered = pageUpdate(
			opened.model,
			Message.SucceededFetchTraces({ fingerprintHash: "fp1", key, traces: [], fetchedAtMs: 0 }),
		)
		scene(
			{ update: pageUpdate, view },
			given(answered.model),
			expectView(role("button", { name: /ConnectionTimeout/ })).toHaveAttr("aria-expanded", "true"),
			expectView(text("No traces found for this error in the selected range.")).toExist(),
		)
		const closed = pageUpdate(answered.model, Message.ClickedErrorType({ fingerprintHash: "fp1" }))
		const reopened = pageUpdate(closed.model, Message.ClickedErrorType({ fingerprintHash: "fp1" }))
		expect(names(reopened.commands)).toEqual([])
	})

	test("last seen reads the root's newer clock, as legacy reads the time at each render", () => {
		const later = withViewInputs(pageView, { ...inputs, clockMs: NOW + 20 * 60_000 })()
		scene(
			{ update: pageUpdate, view: later },
			given(loaded([row("fp1", "ConnectionTimeout")])),
			expectView(text("21m ago")).toExist(),
		)
	})
})
