import { LOGS_TABLE_BENCH_ROWS } from "../../lab/bench/logs-table-bench-fixture"
import type { HtmlBuilder } from "foldkit/html"
import {
	all,
	Command,
	click,
	expect,
	expectAll,
	expectOutMessage,
	given,
	hover,
	Mount,
	role,
	scene,
	selector,
	Subscription,
	text,
	within,
} from "foldkit/scene"
import { Duration } from "effect"
import { Lazy } from "foldkit/test"
import { describe, test } from "vitest"
import { PlaceChipCard } from "./chip-card"
import { logTimeFormat, toLogRowView } from "./log-row-view"
import {
	CHIP_CLOSE_DELAY,
	CHIP_OPEN_DELAY,
	init,
	type Model,
	OutMessage,
	update,
	WaitChipDelay,
} from "./logs-stream"
import { Message } from "./logs-stream-message"
import { view, type ViewInputs } from "./logs-stream-view"
import { ScrollStreamToIndex, VirtualizeLogStream } from "./virtualize"

const STREAM_ID = "test-stream"
const ROWS = LOGS_TABLE_BENCH_ROWS.slice(0, 60).map((log) => toLogRowView(log, [], logTimeFormat("UTC")))
const INPUTS: ViewInputs = {
	wrap: false,
	density: "compact",
	pinnedColumns: [],
	searchText: undefined,
	timeZone: "UTC",
	isWaiting: false,
	footerText: "60 logs",
	canFilter: true,
}
const ROW_HEIGHT = 37

const sceneUpdate = (model: Model, message: Message) => update(model, message)
const sceneView = (model: Model, h: HtmlBuilder<Message>) => view(model, INPUTS, h)
const program = { update: sceneUpdate, view: sceneView }

/** The window the virtualizer reports for rows `from..to` at 37px each. */
const windowOf = (from: number, to: number) =>
	Message.ChangedVirtualWindow({
		rows: Array.from({ length: to - from + 1 }, (_, i) => ({
			index: from + i,
			start: (from + i) * ROW_HEIGHT,
		})),
		totalSize: ROWS.length * ROW_HEIGHT,
	})

const withWindow = (from: number, to: number): Model =>
	update(init(STREAM_ID, ROWS), windowOf(from, to)).model

const log = role("log")
const rows = all.role("listitem")
const rowOf = (index: number) => selector(`[data-index="${index}"]`)
const chip0 = role("button", { name: /^Copy attribute\.0=.*-0-0$/ })
// Scene has no pointer-leave step and resolves a Mount once; later Mount and leave events are fed as emitted Messages.
const leave = Subscription.emit(Message.LeftChip({ index: 0, key: "attribute.0" }))
const ackVirtualizer = Mount.resolve(
	VirtualizeLogStream,
	Message.ChangedScrolledAway({ isScrolledAway: false }),
)

describe("logs stream: virtual window", () => {
	test("renders nothing until the virtualizer reports, then exactly its window at its offsets", () => {
		scene(
			program,
			given(init(STREAM_ID, ROWS)),
			expectAll(rows).toHaveCount(0),
			Mount.resolve(VirtualizeLogStream, windowOf(0, 24)),
			expectAll(rows).toHaveCount(25),
			expect(log).toHaveStyle("height", `${ROWS.length * ROW_HEIGHT}px`),
			expect(rowOf(3)).toHaveStyle("transform", `translateY(${3 * ROW_HEIGHT}px)`),
			expect(within(rowOf(0), text("Synthetic wide log row 0:", { exact: false }))).toExist(),
		)
	})

	test("scrolling swaps the window: rows that left unmount, rows that entered mount at their start", () => {
		scene(
			program,
			given(withWindow(0, 24)),
			Mount.resolve(VirtualizeLogStream, windowOf(30, 59)),
			expectAll(rows).toHaveCount(30),
			expect(rowOf(0)).not.toExist(),
			expect(rowOf(59)).toHaveStyle("transform", `translateY(${59 * ROW_HEIGHT}px)`),
		)
	})

	test("scrolling away from the newest rows is reported once, as inspecting", () => {
		scene(
			program,
			given(withWindow(0, 24)),
			Mount.resolve(VirtualizeLogStream, Message.ChangedScrolledAway({ isScrolledAway: true })),
			expectOutMessage(OutMessage.ChangedInspecting({ isInspecting: true, isScrolledAway: true })),
		)
	})
})

describe("logs stream: keyboard selection", () => {
	test("j/k move the focused row, keep it in view, Enter opens it and Escape clears it", () => {
		scene(
			program,
			given(withWindow(0, 24)),
			ackVirtualizer,
			Subscription.emit(Message.PressedNavigationKey({ key: "Next" })),
			Command.expectExact(ScrollStreamToIndex({ streamId: STREAM_ID, index: 0 })),
			Command.resolve(ScrollStreamToIndex, Message.CompletedScroll()),
			Subscription.emit(Message.PressedNavigationKey({ key: "Next" })),
			Command.resolve(ScrollStreamToIndex, Message.CompletedScroll()),
			expect(within(rowOf(1), role("listitem"))).toHaveAttr("data-focused", "true"),
			expect(within(rowOf(0), role("listitem"))).not.toHaveAttr("data-focused"),
			Subscription.emit(Message.PressedNavigationKey({ key: "Previous" })),
			Command.resolve(ScrollStreamToIndex, Message.CompletedScroll()),
			expect(within(rowOf(0), role("listitem"))).toHaveAttr("data-focused", "true"),
			Subscription.emit(Message.PressedNavigationKey({ key: "Open" })),
			expectOutMessage(OutMessage.OpenedLog({ index: 0 })),
			Subscription.emit(Message.PressedNavigationKey({ key: "Clear" })),
			expect(within(rowOf(0), role("listitem"))).not.toHaveAttr("data-focused"),
		)
	})

	test("→ expands the focused row, the chevron toggles it back, and expansion counts as inspecting", () => {
		scene(
			program,
			given(withWindow(0, 24)),
			ackVirtualizer,
			Subscription.emit(Message.PressedNavigationKey({ key: "Next" })),
			Command.resolve(ScrollStreamToIndex, Message.CompletedScroll()),
			Subscription.emit(Message.PressedNavigationKey({ key: "Expand" })),
			expectOutMessage(OutMessage.ChangedInspecting({ isInspecting: true, isScrolledAway: false })),
			expect(within(rowOf(0), role("button", { name: "Collapse log" }))).toHaveAttr(
				"aria-expanded",
				"true",
			),
			click(within(rowOf(0), role("button", { name: "Collapse log" }))),
			expect(within(rowOf(0), role("button", { name: "Expand log" }))).toHaveAttr(
				"aria-expanded",
				"false",
			),
		)
	})

	test("clicking a row opens it without expanding it", () => {
		scene(
			program,
			given(withWindow(0, 24)),
			ackVirtualizer,
			click(within(rowOf(2), role("listitem"))),
			expectOutMessage(OutMessage.OpenedLog({ index: 2 })),
			expect(within(rowOf(2), role("button", { name: "Expand log" }))).toExist(),
		)
	})

	test("a row links to its trace; a row without one offers no trace link", () => {
		const untraced = LOGS_TABLE_BENCH_ROWS.slice(0, 2).map((log, i) =>
			toLogRowView(i === 1 ? { ...log, traceId: undefined } : log, [], logTimeFormat("UTC")),
		)
		scene(
			program,
			given(update(init(STREAM_ID, untraced), windowOf(0, 1)).model),
			ackVirtualizer,
			expect(within(rowOf(0), role("link", { name: "Open trace" }))).toHaveAttr(
				"href",
				`/traces/${untraced[0]?.traceId}`,
			),
			expect(within(rowOf(1), role("link", { name: "Open trace" }))).toBeAbsent(),
			expect(within(rowOf(1), role("button", { name: "Open details" }))).toExist(),
		)
	})
})

describe("logs stream: attribute card", () => {
	test("resting on a chip opens its card after the delay; leaving closes it after the grace period", () => {
		scene(
			program,
			given(withWindow(0, 24)),
			ackVirtualizer,
			hover(chip0),
			Command.expectExact(WaitChipDelay({ generation: 1, millis: Duration.toMillis(CHIP_OPEN_DELAY) })),
			expect(text("Attribute", { exact: true })).not.toExist(),
			Command.resolve(WaitChipDelay, Message.ElapsedChipDelay({ generation: 1 })),
			expect(text("Attribute", { exact: true })).toExist(),
			expect(role("button", { name: /^Filter in attribute\.0 = / })).toExist(),
			Mount.resolve(PlaceChipCard, Message.PlacedChipCard()),
			leave,
			Command.expectExact(
				WaitChipDelay({ generation: 2, millis: Duration.toMillis(CHIP_CLOSE_DELAY) }),
			),
			Command.resolve(WaitChipDelay, Message.ElapsedChipDelay({ generation: 2 })),
			expect(text("Attribute", { exact: true })).not.toExist(),
			Mount.expectEnded(PlaceChipCard),
		)
	})

	test("an open card closes when its row scrolls out of the window", () => {
		scene(
			program,
			given(withWindow(0, 24)),
			ackVirtualizer,
			hover(chip0),
			Command.resolve(WaitChipDelay, Message.ElapsedChipDelay({ generation: 1 })),
			Mount.resolve(PlaceChipCard, Message.PlacedChipCard()),
			Subscription.emit(windowOf(30, 59)),
			expect(text("Attribute", { exact: true })).not.toExist(),
			Mount.expectEnded(PlaceChipCard),
		)
	})
})

describe("logs stream: expanded row", () => {
	const expand = () => click(within(rowOf(0), role("button", { name: "Expand log" })))
	const group = role("button", { name: /^attribute ?10$/ })

	test("expanding shows the body and its attribute groups; a group over eight rows starts closed", () => {
		scene(
			program,
			given(withWindow(0, 24)),
			ackVirtualizer,
			expand(),
			expect(within(rowOf(0), text("Log Attributes"))).toExist(),
			expect(group).toHaveAttr("aria-expanded", "false"),
			expect(role("button", { name: "Copy attribute.0" })).not.toExist(),
			click(group),
			expect(group).toHaveAttr("aria-expanded", "true"),
			expect(role("button", { name: "Copy attribute.0" })).toExist(),
		)
	})

	test("Details opens the row's log", () => {
		scene(
			program,
			given(withWindow(0, 24)),
			ackVirtualizer,
			expand(),
			click(role("button", { name: "Details" })),
			expectOutMessage(OutMessage.OpenedLog({ index: 0 })),
		)
	})

	test("a filter from an attribute row becomes the stream's attribute filter", () => {
		scene(
			program,
			given(withWindow(0, 24)),
			ackVirtualizer,
			expand(),
			click(role("button", { name: "Exclude cloud.region = eu-central-1" })),
			expectOutMessage(
				OutMessage.ChoseAttributeFilter({
					source: "resource",
					key: "cloud.region",
					value: "eu-central-1",
					negated: true,
				}),
			),
		)
	})
})

describe("logs stream lazy rows", () => {
	test("an unchanged window reuses every row", () => {
		Lazy.expectAllReused({ view: sceneView, model: withWindow(0, 19) })
	})
})
