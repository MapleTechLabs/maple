import {
	ApplyWorldOpsResponse,
	BuildingType,
	type ServiceBuilding,
	serviceBuildingId,
	WorldCell,
	WorldConflictError,
	WorldEntity,
	type WorldEntityId,
	type WorldEntityRecord,
	type WorldOp,
	WorldRotation,
} from "@maple/domain/http"
import { Array as Arr, Option, Order, Schema } from "effect"

// The edit model the factory UI drives. `known` is what the server last confirmed; `local` is
// the optimistic world on screen. Ops are always the diff between them, so they carry the
// latest known revision and edits made while a batch is in flight are never lost.

export const MoveBuilding = Schema.TaggedStruct("MoveBuilding", { nodeId: Schema.String, cell: WorldCell })
/** `cell`: where the building stands now, used when this edit first places it. */
export const SetBuildingType = Schema.TaggedStruct("SetBuildingType", {
	nodeId: Schema.String,
	building: Schema.NullOr(BuildingType),
	cell: WorldCell,
})
export const RotateBuilding = Schema.TaggedStruct("RotateBuilding", {
	nodeId: Schema.String,
	rotation: WorldRotation,
	cell: WorldCell,
})
export const ResetBuilding = Schema.TaggedStruct("ResetBuilding", { nodeId: Schema.String })
export const ResetAll = Schema.TaggedStruct("ResetAll", {})
export const EditCommand = Schema.Union([
	MoveBuilding,
	SetBuildingType,
	RotateBuilding,
	ResetBuilding,
	ResetAll,
])
export type EditCommand = typeof EditCommand.Type

export type Entities = ReadonlyMap<WorldEntityId, WorldEntity>

export interface WorldEdits {
	readonly known: ReadonlyMap<WorldEntityId, WorldEntityRecord>
	readonly local: Entities
	/** Earlier `local` worlds, newest last; `future` holds undone ones, next redo last. */
	readonly past: ReadonlyArray<Entities>
	readonly future: ReadonlyArray<Entities>
}

export interface EditResult {
	readonly state: WorldEdits
	/** What this step changed, against `known`; empty when nothing changed. */
	readonly ops: ReadonlyArray<WorldOp>
}

export const HISTORY_LIMIT = 100

const sameEntity = Schema.toEquivalence(WorldEntity)

/** Start from the stored world (`WorldDocument.entities`). */
export const initialEdits = (records: ReadonlyArray<WorldEntityRecord>): WorldEdits => {
	const known = new Map(Arr.map(records, (record) => [record.id, record] as const))
	return {
		known,
		local: new Map(Arr.map(records, (record) => [record.id, record.entity] as const)),
		past: [],
		future: [],
	}
}

/** The optimistic entities for `resolveWorld`. */
export const optimisticEntities = (state: WorldEdits) =>
	Arr.map([...state.local], ([id, entity]) => ({ id, entity }))

const revisionOf = (state: Pick<WorldEdits, "known">, id: WorldEntityId) =>
	state.known.get(id)?.revision ?? null

/** Put or Remove for every id whose entity differs between `from` and `to`, in id order. */
const diff = (state: Pick<WorldEdits, "known">, from: Entities, to: Entities): ReadonlyArray<WorldOp> => {
	const ids = Arr.sort(Arr.dedupe([...from.keys(), ...to.keys()]), Order.String)
	return Arr.flatMap(ids, (id): ReadonlyArray<WorldOp> => {
		const before = from.get(id),
			after = to.get(id)
		const expectedRevision = revisionOf(state, id)
		if (after === undefined) return before === undefined ? [] : [{ _tag: "Remove", id, expectedRevision }]
		if (before !== undefined && sameEntity(before, after)) return []
		return [{ _tag: "Put", id, entity: after, expectedRevision }]
	})
}

const knownEntities = (state: Pick<WorldEdits, "known">): Entities =>
	new Map(Arr.map([...state.known], ([id, record]) => [id, record.entity] as const))

/** Everything on screen the server has not confirmed: send this, one batch at a time. */
export const outstandingOps = (state: WorldEdits): ReadonlyArray<WorldOp> =>
	diff(state, knownEntities(state), state.local)

const buildingOf = (local: Entities, nodeId: string): ServiceBuilding | undefined => {
	const entity = local.get(serviceBuildingId(nodeId))
	return entity?._tag === "ServiceBuilding" ? entity : undefined
}

/** The node's building with `change` applied, created at `cell` when it has none yet. */
const withBuilding = (
	local: Entities,
	nodeId: string,
	cell: WorldCell,
	change: (building: ServiceBuilding) => ServiceBuilding,
): Entities => {
	const current: ServiceBuilding = buildingOf(local, nodeId) ?? {
		_tag: "ServiceBuilding",
		nodeId,
		cell,
		rotation: 0,
		building: null,
	}
	return new Map(local).set(serviceBuildingId(nodeId), change(current))
}

const without = (local: Entities, ids: ReadonlyArray<WorldEntityId>): Entities => {
	const next = new Map(local)
	Arr.forEach(ids, (id) => next.delete(id))
	return next
}

const commandLocal = (local: Entities, command: EditCommand): Entities => {
	switch (command._tag) {
		case "MoveBuilding":
			return withBuilding(local, command.nodeId, command.cell, (b) => ({ ...b, cell: command.cell }))
		case "SetBuildingType":
			return withBuilding(local, command.nodeId, command.cell, (b) => ({
				...b,
				building: command.building,
			}))
		case "RotateBuilding":
			return withBuilding(local, command.nodeId, command.cell, (b) => ({
				...b,
				rotation: command.rotation,
			}))
		case "ResetBuilding":
			return without(local, [serviceBuildingId(command.nodeId)])
		case "ResetAll":
			return without(
				local,
				Arr.flatMap([...local], ([id, entity]) => (entity._tag === "ServiceBuilding" ? [id] : [])),
			)
	}
}

/** Move `state` to `next`, recording history the way `history` says. */
const transition = (
	state: WorldEdits,
	next: Entities,
	history: Pick<WorldEdits, "past" | "future">,
): EditResult => ({
	state: { ...state, ...history, local: next },
	ops: diff(state, state.local, next),
})

/** Apply one command; a no-op (same world) leaves the state, history included, untouched. */
export const applyEdit = (state: WorldEdits, command: EditCommand): EditResult => {
	const result = transition(state, commandLocal(state.local, command), {
		past: Arr.takeRight([...state.past, state.local], HISTORY_LIMIT),
		future: [],
	})
	return result.ops.length === 0 ? { state, ops: [] } : result
}

export const canUndo = (state: WorldEdits) => state.past.length > 0
export const canRedo = (state: WorldEdits) => state.future.length > 0

export const undo = (state: WorldEdits): EditResult => {
	const previous = Arr.last(state.past)
	if (Option.isNone(previous)) return { state, ops: [] }
	return transition(state, previous.value, {
		past: Arr.dropRight(state.past, 1),
		future: [...state.future, state.local],
	})
}

export const redo = (state: WorldEdits): EditResult => {
	const next = Arr.last(state.future)
	if (Option.isNone(next)) return { state, ops: [] }
	return transition(state, next.value, {
		past: [...state.past, state.local],
		future: Arr.dropRight(state.future, 1),
	})
}

export const Applied = Schema.TaggedStruct("Applied", { response: ApplyWorldOpsResponse })
export const Conflicted = Schema.TaggedStruct("Conflicted", { conflict: WorldConflictError })
/** The server refused the batch for good (a 4xx other than a conflict): retrying cannot help. */
export const Rejected = Schema.TaggedStruct("Rejected", { message: Schema.String })
/** How a sent batch ended: stored, refused because someone else changed those rows, or refused. */
export const BatchOutcome = Schema.Union([Applied, Conflicted, Rejected])
export type BatchOutcome = typeof BatchOutcome.Type

/** Fold a batch's outcome back in. Stored rows become `known` (edits made since stay local
 * and show up in `outstandingOps`); on a conflict the server's current rows win; a rejection
 * drops every unsaved edit. Both clear the history, whose snapshots would undo a teammate. */
export const reconcile = (state: WorldEdits, outcome: BatchOutcome): WorldEdits => {
	const known = new Map(state.known)
	if (outcome._tag === "Rejected") {
		return { ...initialEdits([...state.known.values()]) }
	}
	if (outcome._tag === "Applied") {
		Arr.forEach(outcome.response.put, (record) => known.set(record.id, record))
		Arr.forEach(outcome.response.removed, (id) => known.delete(id))
		return { ...state, known }
	}
	const local = new Map(state.local)
	const current = new Map(Arr.map(outcome.conflict.current, (record) => [record.id, record] as const))
	Arr.forEach(outcome.conflict.ids, (id) => {
		const record = current.get(id)
		if (record === undefined) {
			known.delete(id)
			local.delete(id)
		} else {
			known.set(id, record)
			local.set(id, record.entity)
		}
	})
	return { known, local, past: [], future: [] }
}
