import { expect as expectView, given, role, scene, selector, text } from "foldkit/scene"
import type { HtmlBuilder } from "foldkit/html"
import { describe, test } from "vitest"
import { signalEmptyState } from "./signal-empty-state"
import type { PresenceState } from "../data/signal-presence"

type Model = Readonly<{ presence: PresenceState; isFiltered: boolean }>
type Message = Readonly<{ _tag: "Widen" }> | Readonly<{ _tag: "Clear" }>

const update = (model: Model) => ({ model })
const view = (withExtras: boolean) => (model: Model, h: HtmlBuilder<Message>) =>
	signalEmptyState<Message>(h, {
		signal: "traces",
		presence: model.presence,
		nowMs: 10 * 60_000,
		timeZone: "UTC",
		isFiltered: model.isFiltered,
		onClearFilters: { _tag: "Clear" },
		onramp: { source: ["Point an SDK here."], content: [h.span([], ["the on-ramp"])] },
		onWidenRange: withExtras ? { _tag: "Widen" } : undefined,
		filteredDescription: withExtras ? "Nothing in the 24 hours window matched." : undefined,
		filteredActions: withExtras ? [h.span([], ["widen instead"])] : undefined,
		guide: withExtras ? h.a([h.Href("/docs")], ["Read the docs"]) : undefined,
	})

const at = (presence: PresenceState, isFiltered = false): Model => ({ presence, isFiltered })

describe("the signal empty state", () => {
	test("never sent: the app's source sentence and on-ramp", () => {
		scene(
			{ update, view: view(false) },
			given(at({ status: "absent", lastSeenMs: null })),
			expectView(text("No traces yet")).toExist(),
			expectView(text(/Point an SDK here\./)).toExist(),
			expectView(text("the on-ramp")).toExist(),
		)
	})

	test("a quiet window offers the widen button and the app's guide only when given", () => {
		const quiet = at({ status: "present", lastSeenMs: 7 * 60_000 })
		scene(
			{ update, view: view(true) },
			given(quiet),
			expectView(text(/Maple last received traces 3m ago/)).toExist(),
			expectView(role("button", { name: "Widen time range" })).toExist(),
			expectView(role("link", { name: "Read the docs" })).toExist(),
		)
		scene(
			{ update, view: view(false) },
			given(quiet),
			expectView(role("button", { name: "Widen time range" })).not.toExist(),
			expectView(role("link", { name: "Read the docs" })).not.toExist(),
		)
	})

	test("filters win over presence, and loading paints no copy", () => {
		scene(
			{ update, view: view(false) },
			given(at({ status: "absent", lastSeenMs: null }, true)),
			expectView(text("No traces match these filters")).toExist(),
			expectView(text("No traces yet")).not.toExist(),
			expectView(text("Everything in this window was excluded by the current filters.")).toExist(),
		)
		scene(
			{ update, view: view(true) },
			given(at({ status: "absent", lastSeenMs: null }, true)),
			expectView(text("Nothing in the 24 hours window matched.")).toExist(),
			expectView(role("button", { name: "Clear filters" })).toExist(),
			expectView(text("widen instead")).toExist(),
		)
		scene(
			{ update, view: view(false) },
			given(at({ status: "loading", lastSeenMs: null })),
			expectView(selector('[data-slot="presence-loading"]')).toExist(),
			expectView(text(/No traces/)).not.toExist(),
		)
	})
})
