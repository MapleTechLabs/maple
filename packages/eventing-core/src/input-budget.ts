import {
	MAX_PREDICATE_DEPTH,
	MAX_PREDICATE_NODES,
	MAX_IN_VALUES,
	MAX_DECIMAL_INT64_LENGTH,
	MAX_STRING_LITERAL_CHARACTERS,
} from "./limits"
const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)
const literalIssue = (value: unknown): string | undefined => {
	if (!record(value) || typeof value.value !== "string") return
	if (value.type === "string" && Array.from(value.value).length > MAX_STRING_LITERAL_CHARACTERS)
		return `selector string exceeds ${MAX_STRING_LITERAL_CHARACTERS} Unicode code points`
	if (
		(value.type === "int64" || value.type === "duration") &&
		value.value.length > MAX_DECIMAL_INT64_LENGTH
	)
		return `${value.type} literal exceeds ${MAX_DECIMAL_INT64_LENGTH} characters`
}
/** Iterative pre-decode inspection never traverses more than the accepted budget. */
export const predicateInputBudgetIssue = (candidate: unknown): string | undefined => {
	const stack = [{ value: candidate, depth: 1 }]
	const seen = new Set<object>()
	let nodes = 0
	while (stack.length > 0) {
		const current = stack.pop()
		if (current === undefined) break
		if (current.depth > MAX_PREDICATE_DEPTH) return `predicate depth exceeds ${MAX_PREDICATE_DEPTH}`
		if (++nodes > MAX_PREDICATE_NODES) return `predicate exceeds ${MAX_PREDICATE_NODES} nodes`
		if (!record(current.value)) continue
		if (seen.has(current.value)) return "predicate must be acyclic JSON"
		seen.add(current.value)
		const node = current.value
		if (node.op === "all" || node.op === "any") {
			if (!Array.isArray(node.clauses)) continue
			if (node.clauses.length > MAX_PREDICATE_NODES)
				return `predicate clause list exceeds ${MAX_PREDICATE_NODES} entries`
			for (const value of node.clauses) stack.push({ value, depth: current.depth + 1 })
		} else if (node.op === "not") stack.push({ value: node.clause, depth: current.depth + 1 })
		else if (node.op === "in") {
			if (!Array.isArray(node.values)) continue
			if (node.values.length > MAX_IN_VALUES) return `in exceeds ${MAX_IN_VALUES} values`
			for (const value of node.values) {
				const issue = literalIssue(value)
				if (issue) return issue
			}
		} else {
			const issue = literalIssue(node.value)
			if (issue) return issue
		}
	}
}
