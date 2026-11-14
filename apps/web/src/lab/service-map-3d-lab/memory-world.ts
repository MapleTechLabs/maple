import {
	ApplyWorldOpsResponse,
	IsoDateTimeString,
	WorldConflictError,
	WorldEntityRecord,
	type WorldOp,
} from "@maple/domain/http"
import { Array as Arr, Result, Schema } from "effect"
import { Applied, type BatchOutcome, Conflicted } from "../../page/service-map/factory/edits"

// The lab's stand-in for `/internal/service-map/world`: the same revision rules over an array.

const decodeIso = Schema.decodeUnknownSync(IsoDateTimeString)

export interface MemoryApply {
	readonly records: ReadonlyArray<WorldEntityRecord>
	readonly outcome: BatchOutcome
}

export const applyInMemory = (
	records: ReadonlyArray<WorldEntityRecord>,
	ops: ReadonlyArray<WorldOp>,
	nowMs: number,
): MemoryApply => {
	const byId = new Map(Arr.map(records, (record) => [record.id, record] as const))
	const conflicts = Arr.filter(
		ops,
		(op) => op.expectedRevision !== null && byId.get(op.id)?.revision !== op.expectedRevision,
	)
	if (conflicts.length > 0) {
		const ids = Arr.map(conflicts, (op) => op.id)
		const conflict = new WorldConflictError({
			message: "Changed since read.",
			ids,
			current: Arr.flatMap(ids, (id) => Arr.fromNullishOr(byId.get(id))),
		})
		return { records, outcome: Conflicted.make({ conflict }) }
	}
	const updatedAt = decodeIso(new Date(nowMs).toISOString())
	const put = Arr.filterMap(ops, (op) =>
		op._tag === "Put"
			? Result.succeed(
					new WorldEntityRecord({
						id: op.id,
						entity: op.entity,
						revision: (byId.get(op.id)?.revision ?? 0) + 1,
						updatedAt,
						updatedBy: null,
					}),
				)
			: Result.failVoid,
	)
	const removed = Arr.filterMap(ops, (op) =>
		op._tag === "Remove" ? Result.succeed(op.id) : Result.failVoid,
	)
	Arr.forEach(removed, (id) => byId.delete(id))
	Arr.forEach(put, (record) => byId.set(record.id, record))
	return {
		records: [...byId.values()],
		outcome: Applied.make({ response: new ApplyWorldOpsResponse({ put, removed }) }),
	}
}
