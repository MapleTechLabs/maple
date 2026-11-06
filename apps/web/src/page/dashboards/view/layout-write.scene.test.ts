import { OrgId } from "@maple/domain"
import { DashboardDocument } from "@maple/domain/http"
import { Option, Result, Schema, Array as Arr } from "effect"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../../contract"
import { UpdateWidgetLayouts } from "./command"
import { canvasGridOf, shownLayoutOf } from "./grid"
import { Message } from "./message"
import type { Model } from "./model"
import { init, routeChanged, update } from "./update"

// A drop's write: what the grid draws while it saves, after it fails, and when results arrive late.

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const ROUTE = { dashboardId: "dash_platform", search: {} }

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const run = (model: Model, messages: ReadonlyArray<Message>) =>
	Arr.reduce(messages, model, (current, message) => pageUpdate(current, message).model)
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)

const stat = (id: string, x: number) => ({
	id,
	visualization: "stat",
	dataSource: {
		kind: "route",
		endpoint: "errors_summary",
		transform: { reduceToValue: { field: "totalErrors", aggregate: "first" } },
	},
	display: { title: id, unit: "number" },
	layout: { x, y: 0, w: 3, h: 2 },
})

const documentWith = (name: string, errorRateX: number) =>
	Schema.decodeUnknownSync(DashboardDocument)({
		id: "dash_platform",
		name,
		timeRange: { type: "relative", value: "6h" },
		widgets: [stat("total-errors", 0), stat("error-rate", errorRateX)],
		createdAt: "2026-09-19T12:00:00.000Z",
		updatedAt: "2026-09-28T12:00:00.000Z",
		schemaVersion: 3,
	})

const editing = (): Model =>
	run(routeChanged(init(ROUTE, context).model, { ...ROUTE, search: { mode: "edit" } }, context).model, [
		Message.CompletedReadClock({ nowMs: Date.parse("2026-10-01T12:00:00Z") }),
		Message.UpdatedDashboard({ orgId, maybeDocument: Option.some(documentWith("Board", 3)) }),
		Message.MeasuredGrid({ width: 1200 }),
	])

/** Drags `error-rate` to the far right, which writes its new box. */
const dropped = (model: Model) => {
	const pressed = pageUpdate(
		model,
		Message.PressedGrip({ widgetId: "error-rate", clientX: 400, clientY: 100 }),
	)
	const moved = pageUpdate(
		pressed.model,
		Message.MovedPointer({ clientX: 1100, clientY: 100, gridLeft: 0, gridTop: 0 }),
	)
	return pageUpdate(moved.model, Message.ReleasedPointer())
}

const generationOf = (model: Model) => (model.layoutWrite === null ? -1 : model.layoutWrite.generation)

const shownX = (model: Model, id: string) => {
	const grid = canvasGridOf(model)
	if (grid === null) return undefined
	return Option.getOrUndefined(
		Option.map(
			Arr.findFirst(shownLayoutOf(model, grid), (item) => item.i === id),
			(item) => item.x,
		),
	)
}

describe("a dropped layout's write", () => {
	test("a failed save draws the stored layout again and Retry sends the same write", () => {
		const drop = dropped(editing())
		expect(names(drop.commands)).toEqual([UpdateWidgetLayouts.name])
		expect(shownX(drop.model, "error-rate")).toBeGreaterThan(3)
		const failed = pageUpdate(
			drop.model,
			Message.CompletedLayoutWrite({
				generation: generationOf(drop.model),
				result: Result.fail("Conflict"),
			}),
		).model
		expect(failed.persistenceError).toBe("Conflict")
		expect(shownX(failed, "error-rate")).toBe(3)
		const retried = pageUpdate(failed, Message.ClickedRetryPersistence())
		expect(retried.model.persistenceError).toBeNull()
		expect(names(retried.commands)).toEqual([UpdateWidgetLayouts.name])
		expect(shownX(retried.model, "error-rate")).toBe(shownX(drop.model, "error-rate"))
	})

	test("another write succeeding keeps the failed drop's banner until Retry", () => {
		const drop = dropped(editing())
		const failed = pageUpdate(
			drop.model,
			Message.CompletedLayoutWrite({
				generation: generationOf(drop.model),
				result: Result.fail("Conflict"),
			}),
		).model
		const other = pageUpdate(failed, Message.CompletedWrite({ result: Result.succeed("Synced") })).model
		expect(other.persistenceError).toBe("Conflict")
		expect(names(pageUpdate(other, Message.ClickedRetryPersistence()).commands)).toEqual([
			UpdateWidgetLayouts.name,
		])
	})

	test("coming back online sends the failed write again", () => {
		const drop = dropped(editing())
		const failed = pageUpdate(
			drop.model,
			Message.CompletedLayoutWrite({
				generation: generationOf(drop.model),
				result: Result.fail("Offline"),
			}),
		).model
		expect(names(pageUpdate(failed, Message.CameBackOnline()).commands)).toEqual([
			UpdateWidgetLayouts.name,
		])
	})

	test("an older drop's failure arriving after a newer drop changes nothing", () => {
		const first = dropped(editing()).model
		const firstGeneration = generationOf(first)
		const back = pageUpdate(
			first,
			Message.PressedGrip({ widgetId: "error-rate", clientX: 1100, clientY: 100 }),
		)
		const movedBack = pageUpdate(
			back.model,
			Message.MovedPointer({ clientX: 500, clientY: 100, gridLeft: 0, gridTop: 0 }),
		)
		const second = pageUpdate(movedBack.model, Message.ReleasedPointer()).model
		expect(generationOf(second)).toBeGreaterThan(firstGeneration)
		const late = pageUpdate(
			second,
			Message.CompletedLayoutWrite({ generation: firstGeneration, result: Result.fail("Conflict") }),
		).model
		expect(late.persistenceError).toBeNull()
		expect(late.layoutWrite?._tag).toBe("Saving")
		expect(late.layoutWrite?.changes).toContainEqual(expect.objectContaining({ i: "error-rate", x: 3 }))
		expect(shownX(late, "error-rate")).toBe(shownX(second, "error-rate"))
	})

	test("an unrelated document update keeps drawing the drop until the store holds it", () => {
		const drop = dropped(editing()).model
		const droppedX = shownX(drop, "error-rate")
		const renamed = pageUpdate(
			drop,
			Message.UpdatedDashboard({ orgId, maybeDocument: Option.some(documentWith("Renamed", 3)) }),
		).model
		expect(shownX(renamed, "error-rate")).toBe(droppedX)
		const echoed = pageUpdate(
			renamed,
			Message.UpdatedDashboard({
				orgId,
				maybeDocument: Option.some(documentWith("Renamed", droppedX ?? 0)),
			}),
		).model
		expect(echoed.layoutWrite).toBeNull()
		expect(shownX(echoed, "error-rate")).toBe(droppedX)
	})

	test("a saved drop clears on the next document", () => {
		const drop = dropped(editing()).model
		const saved = pageUpdate(
			drop,
			Message.CompletedLayoutWrite({
				generation: generationOf(drop),
				result: Result.succeed("Synced"),
			}),
		).model
		expect(saved.layoutWrite?._tag).toBe("Saved")
		const next = pageUpdate(
			saved,
			Message.UpdatedDashboard({ orgId, maybeDocument: Option.some(documentWith("Board", 3)) }),
		).model
		expect(next.layoutWrite).toBeNull()
	})
})
