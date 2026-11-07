import {
	ApplyWorldOpsResponse,
	type BuildingType,
	IsoDateTimeString,
	type ServiceBuilding,
	serviceBuildingId,
	type WorldCell,
	WorldConflictError,
	WorldEntityRecord,
} from "@maple/domain/http"
import { Array as Arr } from "effect"
import { describe, expect, test } from "vitest"
import {
	applyEdit,
	canRedo,
	canUndo,
	type EditCommand,
	initialEdits,
	optimisticEntities,
	outstandingOps,
	reconcile,
	redo,
	undo,
	type WorldEdits,
} from "./edits"

const building = (nodeId: string, cell: WorldCell, type: BuildingType | null = null): ServiceBuilding => ({
	_tag: "ServiceBuilding",
	nodeId,
	cell,
	rotation: 0,
	building: type,
})

const record = (entity: ServiceBuilding, revision: number) =>
	new WorldEntityRecord({
		id: serviceBuildingId(entity.nodeId),
		entity,
		revision,
		updatedAt: IsoDateTimeString.make("2026-11-07T00:00:00.000Z"),
		updatedBy: null,
	})

const run = (state: WorldEdits, ...commands: ReadonlyArray<EditCommand>) =>
	Arr.reduce(commands, state, (current, command) => applyEdit(current, command).state)

const STORED = record(building("api", { x: 2, z: 2 }), 4)
const start = () => initialEdits([STORED])

describe("applyEdit", () => {
	test("moving an unplaced node creates its building, expecting no stored row", () => {
		const { state, ops } = applyEdit(start(), {
			_tag: "MoveBuilding",
			nodeId: "pg",
			cell: { x: 9, z: 1 },
		})
		expect(ops).toEqual([
			{
				_tag: "Put",
				id: serviceBuildingId("pg"),
				entity: building("pg", { x: 9, z: 1 }),
				expectedRevision: null,
			},
		])
		expect(optimisticEntities(state)).toContainEqual({
			id: serviceBuildingId("pg"),
			entity: building("pg", { x: 9, z: 1 }),
		})
	})

	test("changing a stored building's type keeps its cell and expects its revision", () => {
		const { ops } = applyEdit(start(), {
			_tag: "SetBuildingType",
			nodeId: "api",
			building: "gateway",
			cell: { x: 99, z: 99 },
		})
		expect(ops).toEqual([
			{
				_tag: "Put",
				id: STORED.id,
				entity: building("api", { x: 2, z: 2 }, "gateway"),
				expectedRevision: 4,
			},
		])
	})

	test("resetting a stored building removes its row at the known revision", () => {
		const { state, ops } = applyEdit(start(), { _tag: "ResetBuilding", nodeId: "api" })
		expect(ops).toEqual([{ _tag: "Remove", id: STORED.id, expectedRevision: 4 }])
		expect(optimisticEntities(state)).toEqual([])
	})

	test("an edit that changes nothing sends nothing and leaves history alone", () => {
		const before = start()
		const result = applyEdit(before, { _tag: "ResetBuilding", nodeId: "never-placed" })
		expect(result.ops).toEqual([])
		expect(result.state).toBe(before)
		expect(canUndo(result.state)).toBe(false)
	})

	test("reset all removes every building", () => {
		const placed = run(start(), { _tag: "MoveBuilding", nodeId: "pg", cell: { x: 0, z: 9 } })
		const { state, ops } = applyEdit(placed, { _tag: "ResetAll" })
		expect(optimisticEntities(state)).toEqual([])
		expect(ops).toEqual([
			{ _tag: "Remove", id: STORED.id, expectedRevision: 4 },
			{ _tag: "Remove", id: serviceBuildingId("pg"), expectedRevision: null },
		])
	})
})

describe("undo and redo", () => {
	const moved = () => run(start(), { _tag: "MoveBuilding", nodeId: "api", cell: { x: 7, z: 7 } })

	test("undo puts the building back and sends the op that does it", () => {
		const { state, ops } = undo(moved())
		expect(ops).toEqual([{ _tag: "Put", id: STORED.id, entity: STORED.entity, expectedRevision: 4 }])
		expect(optimisticEntities(state)).toEqual([{ id: STORED.id, entity: STORED.entity }])
		expect(canRedo(state)).toBe(true)
	})

	test("redo reapplies the undone edit", () => {
		const { state, ops } = redo(undo(moved()).state)
		expect(ops).toEqual([
			{ _tag: "Put", id: STORED.id, entity: building("api", { x: 7, z: 7 }), expectedRevision: 4 },
		])
		expect(canRedo(state)).toBe(false)
		expect(canUndo(state)).toBe(true)
	})

	test("undoing the creation of a building removes it", () => {
		const placed = run(start(), { _tag: "MoveBuilding", nodeId: "pg", cell: { x: 1, z: 1 } })
		expect(undo(placed).ops).toEqual([
			{ _tag: "Remove", id: serviceBuildingId("pg"), expectedRevision: null },
		])
	})

	test("a new edit after an undo drops the redo branch", () => {
		const undone = undo(moved()).state
		const edited = run(undone, {
			_tag: "RotateBuilding",
			nodeId: "api",
			rotation: 180,
			cell: { x: 2, z: 2 },
		})
		expect(canRedo(edited)).toBe(false)
	})

	test("undo and redo with no history do nothing", () => {
		expect(undo(start()).ops).toEqual([])
		expect(redo(start()).ops).toEqual([])
	})
})

describe("outstandingOps and reconcile", () => {
	test("several edits to one building go out as one op", () => {
		const state = run(
			start(),
			{ _tag: "MoveBuilding", nodeId: "api", cell: { x: 5, z: 5 } },
			{ _tag: "MoveBuilding", nodeId: "api", cell: { x: 6, z: 5 } },
		)
		expect(outstandingOps(state)).toEqual([
			{ _tag: "Put", id: STORED.id, entity: building("api", { x: 6, z: 5 }), expectedRevision: 4 },
		])
	})

	test("stored rows become known; an edit made while the batch was in flight stays outstanding", () => {
		const sent = run(start(), { _tag: "MoveBuilding", nodeId: "api", cell: { x: 5, z: 5 } })
		const stored = record(building("api", { x: 5, z: 5 }), 5)
		const later = run(sent, {
			_tag: "SetBuildingType",
			nodeId: "api",
			building: "shed",
			cell: { x: 5, z: 5 },
		})
		const settled = reconcile(later, {
			_tag: "Applied",
			response: new ApplyWorldOpsResponse({ put: [stored], removed: [] }),
		})
		expect(outstandingOps(settled)).toEqual([
			{
				_tag: "Put",
				id: STORED.id,
				entity: building("api", { x: 5, z: 5 }, "shed"),
				expectedRevision: 5,
			},
		])
		expect(
			outstandingOps(
				reconcile(sent, {
					_tag: "Applied",
					response: new ApplyWorldOpsResponse({ put: [stored], removed: [] }),
				}),
			),
		).toEqual([])
	})

	test("a confirmed remove forgets the row", () => {
		const reset = run(start(), { _tag: "ResetBuilding", nodeId: "api" })
		const settled = reconcile(reset, {
			_tag: "Applied",
			response: new ApplyWorldOpsResponse({ put: [], removed: [STORED.id] }),
		})
		expect(outstandingOps(settled)).toEqual([])
		expect(settled.known.size).toBe(0)
	})

	test("on a conflict the server's current rows replace the local ones; other edits stay outstanding", () => {
		const theirs = record(building("api", { x: -3, z: 0 }, "tank"), 6)
		const mine = run(
			start(),
			{ _tag: "MoveBuilding", nodeId: "api", cell: { x: 5, z: 5 } },
			{ _tag: "MoveBuilding", nodeId: "pg", cell: { x: 20, z: 0 } },
		)
		const settled = reconcile(mine, {
			_tag: "Conflicted",
			conflict: new WorldConflictError({ message: "stale", ids: [STORED.id], current: [theirs] }),
		})
		expect(optimisticEntities(settled)).toContainEqual({ id: STORED.id, entity: theirs.entity })
		expect(outstandingOps(settled)).toEqual([
			{
				_tag: "Put",
				id: serviceBuildingId("pg"),
				entity: building("pg", { x: 20, z: 0 }),
				expectedRevision: null,
			},
		])
	})

	test("after a conflict, undo cannot bring back what a teammate replaced", () => {
		const theirs = record(building("api", { x: -3, z: 0 }, "tank"), 6)
		const mine = run(start(), { _tag: "MoveBuilding", nodeId: "api", cell: { x: 5, z: 5 } })
		const settled = reconcile(mine, {
			_tag: "Conflicted",
			conflict: new WorldConflictError({ message: "stale", ids: [STORED.id], current: [theirs] }),
		})
		expect(canUndo(settled)).toBe(false)
		expect(undo(settled).ops).toEqual([])
	})

	test("a rejected batch drops the unsaved edits and returns to what is stored", () => {
		const mine = run(
			start(),
			{ _tag: "MoveBuilding", nodeId: "api", cell: { x: 5, z: 5 } },
			{ _tag: "MoveBuilding", nodeId: "pg", cell: { x: 20, z: 0 } },
		)
		const settled = reconcile(mine, { _tag: "Rejected", message: "too many" })
		expect(outstandingOps(settled)).toEqual([])
		expect(optimisticEntities(settled)).toEqual([{ id: STORED.id, entity: STORED.entity }])
		expect(canUndo(settled)).toBe(false)
	})

	test("a conflict on a row someone deleted drops it locally", () => {
		const mine = run(start(), { _tag: "MoveBuilding", nodeId: "api", cell: { x: 5, z: 5 } })
		const settled = reconcile(mine, {
			_tag: "Conflicted",
			conflict: new WorldConflictError({ message: "gone", ids: [STORED.id], current: [] }),
		})
		expect(optimisticEntities(settled)).toEqual([])
		expect(outstandingOps(settled)).toEqual([])
	})
})
