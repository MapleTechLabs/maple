import { Array as Arr, Order } from "effect"
import { isErrorRateUp, isP95Up } from "../derive-deploys"
import type { Operation } from "../model-tabs"

// Which of the service's operations a deploy moved: each one's before against its after.

/** Below this many calls on either side an operation's change is noise. */
const MIN_OPERATION_SPANS = 20

export type Change = "errors-up" | "slower" | "new" | "faster" | "steady"

export type OperationChange = Readonly<{
	spanName: string
	change: Change
	before: Operation | undefined
	after: Operation
}>

const RANK = { "errors-up": 0, slower: 1, new: 2, faster: 3, steady: 4 } as const satisfies Record<
	Change,
	number
>

const changeOf = (before: Operation | undefined, after: Operation): Change => {
	if (before === undefined || before.spanCount < MIN_OPERATION_SPANS) return "new"
	if (isErrorRateUp(before.errorRate, after.errorRate)) return "errors-up"
	if (isP95Up(before.p95DurationMs, after.p95DurationMs)) return "slower"
	// The same rule run backwards: a quarter faster and at least 10ms.
	if (isP95Up(after.p95DurationMs, before.p95DurationMs)) return "faster"
	return "steady"
}

/**
 * The after side's busy operations against the same span name before, worst change first, then
 * busiest. An operation that only ran before is left out: the deploy cannot be judged on it.
 */
export const operationChanges = (
	before: ReadonlyArray<Operation>,
	after: ReadonlyArray<Operation>,
): ReadonlyArray<OperationChange> => {
	const beforeByName = new Map(Arr.map(before, (op) => [op.spanName, op] as const))
	const changes = Arr.map(
		Arr.filter(after, (op) => op.spanCount >= MIN_OPERATION_SPANS),
		(op): OperationChange => {
			const prior = beforeByName.get(op.spanName)
			return { spanName: op.spanName, change: changeOf(prior, op), before: prior, after: op }
		},
	)
	return Arr.sort(
		changes,
		Order.combine(
			Order.mapInput(Order.Number, (change: OperationChange) => RANK[change.change]),
			Order.flip(Order.mapInput(Order.Number, (change: OperationChange) => change.after.spanCount)),
		),
	)
}
