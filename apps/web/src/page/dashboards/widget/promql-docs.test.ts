import { FUNCTIONS, type FunctionSignature } from "@maple/promql"
import { Array as Arr, Order, Record as Rec } from "effect"
import { describe, expect, it } from "vitest"
import { FUNCTION_ENTRIES } from "./promql-docs"

const ARG_NAMES = { vector: "instant-vector", matrix: "range-vector", scalar: "scalar", string: "string" }

/** The engine's own signature in the editor's notation: optional args marked, a repeating last as `...`. */
const formatted = (name: string, signature: FunctionSignature): string => {
	const required =
		signature.optional === -1 ? signature.args.length : signature.args.length - signature.optional
	const args = Arr.map(signature.args, (arg, index) =>
		signature.optional === -1 && index === signature.args.length - 1
			? `${ARG_NAMES[arg]}...`
			: index >= required
				? `${ARG_NAMES[arg]}?`
				: ARG_NAMES[arg],
	)
	return `${name}(${Arr.join(args, ", ")}) → ${ARG_NAMES[signature.returns]}`
}

describe("the editor's function table", () => {
	it("lists every function the engine evaluates, with the engine's signature", () => {
		const engine = Arr.map(Rec.toEntries(FUNCTIONS), ([name, signature]) => formatted(name, signature))
		const editor = Arr.map(FUNCTION_ENTRIES, ([, signature]) => signature)
		expect(Arr.sort(editor, Order.String)).toEqual(Arr.sort(engine, Order.String))
	})
})
