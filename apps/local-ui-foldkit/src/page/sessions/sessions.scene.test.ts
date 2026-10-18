import { Option } from "effect"
import { AsyncData } from "foldkit"
import { expect as expectView, given, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { type PageContext, PageOutMessage } from "../contract"
import type { PageViewInputs } from "../kit/inputs"
import { FetchFacets, FetchSessions, ReadClock } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { init, locationChanged, update } from "./update"
import { view as pageView } from "./view"

const NOW = Date.UTC(2026, 9, 1, 12, 0, 30)
const env = { apiBase: "", port: "4318", otlpEndpoint: "http://127.0.0.1:4318", isHosted: false }
const contextAt = (search: string): PageContext => ({
	env,
	location: { path: "/sessions", search },
	rememberedRange: "1h",
	timeFormat: { locale: "en-US", timeZone: "UTC" },
	canGoBack: false,
})
const context = contextAt("")
const inputs: PageViewInputs = {
	context,
	presenceOf: () => Option.none(),
	presenceNowMs: NOW,
	hasNewDataSince: () => false,
}
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, inputs)()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) => (commands ?? []).map(({ name }) => name)

const clocked = () => pageUpdate(init(context).model, Message.CompletedReadClock({ nowMs: NOW }))

describe("local sessions list", () => {
	test("entry reads the clock, then asks for the list and its facets in the minute's window", () => {
		expect(names(init(context).commands)).toContain(ReadClock.name)
		const loaded = clocked()
		expect(names(loaded.commands)).toEqual([FetchSessions.name, FetchFacets.name])
		expect(Option.getOrNull(loaded.model.maybeAnchorMs)).toBe(Date.UTC(2026, 9, 1, 12, 0, 0))
	})

	test("a list answer for superseded filters is dropped", () => {
		const first = clocked().model
		const second = locationChanged(first, contextAt("browser=Chrome")).model
		expect(second.sessions.key).not.toBe(first.sessions.key)
		const late = update(
			second,
			Message.SucceededFetchSessions({ key: first.sessions.key ?? "", data: { pages: [[]], hasNextPage: false }, fetchedAtMs: NOW }),
			contextAt("browser=Chrome"),
		)
		expect(late.model.sessions).toEqual(second.sessions)
	})

	test("an empty list asks for the signal presence and states the fact while it is unknown", () => {
		const model = clocked().model
		const empty = pageUpdate(
			model,
			Message.SucceededFetchSessions({ key: model.sessions.key ?? "", data: { pages: [[]], hasNextPage: false }, fetchedAtMs: NOW }),
		)
		expect(empty.outMessage).toEqual(PageOutMessage.RequestedSignalPresence())
		expect(AsyncData.isSuccess(empty.model.sessions.data)).toBe(true)
		scene({ update: pageUpdate, view }, given(empty.model), expectView(text("No sessions found")).toExist())
	})
})
