import { click, Command, expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../contract"
import { outcomeOf, stopSuperseded } from "../../data/lanes"
import { FetchTables, ReadPlatform, RunQuery } from "./command"
import { lanes } from "./lanes"
import { Message } from "./message"
import { type Model, RunState } from "./model"
import { init, update } from "./update"
import { view as pageView, type QueryViewInputs } from "./view"

const env = { apiBase: "", port: "4318", otlpEndpoint: "http://127.0.0.1:4318", isHosted: false }
const contextFor = (search: string): PageContext => ({
	env,
	location: { path: "/query", search },
	rememberedRange: "1h",
	timeFormat: { locale: "en-US", timeZone: "UTC" },
	canGoBack: false,
})
const context = contextFor("sql=SELECT%201")
const inputs: QueryViewInputs = { context }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, inputs)()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) => (commands ?? []).map(({ name }) => name)

const loaded = (): Model => {
	const model = init(context).model
	return pageUpdate(model, Message.SucceededFetchTables({ key: model.tables.key ?? "", tables: [{ name: "traces", totalRows: 12 }], fetchedAtMs: 0 })).model
}

describe("local query console", () => {
	test("entry reads the platform and the tables list", () => {
		expect(names(init(context).commands)).toEqual(expect.arrayContaining([ReadPlatform.name, FetchTables.name]))
	})

	test("Run posts the hash's SQL and shows the rows", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded()),
			expectView(text("Run a query")).toExist(),
			click(role("button", { name: "Run" })),
			Command.resolve(RunQuery, Message.SucceededRunQuery({ id: 0, rows: [{ answer: 1 }], elapsedMs: 4 })),
			expectView(role("columnheader", { name: "answer" })).toExist(),
			expectView(text("4 ms")).toExist(),
		)
	})

	test("a failed run shows the server's refusal; a cancelled run's late answer is dropped", () => {
		const running = pageUpdate(loaded(), Message.ClickedRun()).model
		const failed = pageUpdate(running, Message.FailedRunQuery({ id: 0, title: "Query not allowed", detail: "only SELECT" }))
		expect(failed.model.run).toEqual(RunState.Failed({ id: 0, sql: "SELECT 1", title: "Query not allowed", detail: "only SELECT" }))
		scene({ update: pageUpdate, view }, given(failed.model), expectView(text("only SELECT")).toExist())
		const cancelled = pageUpdate(running, Message.ClickedCancel()).model
		const late = pageUpdate(cancelled, Message.SucceededRunQuery({ id: 0, rows: [], elapsedMs: 1 }))
		expect(late.model.run).toEqual(RunState.Idle())
	})

	test("Cancel or a second run stops the running request, and only while one runs", () => {
		const running = pageUpdate(loaded(), Message.ClickedRun()).model
		const stopsAfter = (before: Model, message: Message) =>
			names(stopSuperseded(lanes(before), lanes(pageUpdate(before, message).model), outcomeOf))
		const interruptRun = `${RunQuery.name}.Interrupt`
		expect(stopsAfter(running, Message.ClickedCancel())).toEqual([interruptRun])
		expect(stopsAfter(running, Message.ClickedRun())).toEqual([interruptRun])
		expect(stopsAfter(pageUpdate(running, Message.ClickedCancel()).model, Message.ClickedCancel())).toEqual([])
	})

	test("an empty editor does not run", () => {
		const empty = update(loaded(), Message.ClickedRun(), contextFor(""))
		expect(empty.commands).toBeUndefined()
	})
})
