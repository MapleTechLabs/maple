import * as Cva from "class-variance-authority"
import { cx, variants } from "@maple/ui/lib/variants"
import { describe, expect, it, vi } from "vitest"

type Definition = { readonly base: string; readonly config: Parameters<typeof variants>[1] }

const definitions = vi.hoisted((): Array<Definition> => [])

// Records every real kit definition, then hands it to the real cva unchanged.
vi.mock("class-variance-authority", async (importActual) => {
	const actual = await importActual<typeof Cva>()
	return {
		...actual,
		cva: (base: string, config: Parameters<typeof variants>[1]) => {
			definitions.push({ base, config })
			return actual.cva(base, config)
		},
	}
})

const modules = import.meta.glob("./*.styles.ts", { eager: true })

const choicesFor = (table: Readonly<Record<string, string>>): ReadonlyArray<unknown> => [
	undefined,
	null,
	...Object.keys(table).map((key) => (key === "true" ? true : key === "false" ? false : key)),
]

const combinations = (config: Definition["config"]): ReadonlyArray<Record<string, unknown>> =>
	Object.entries(config?.variants ?? {}).reduce<ReadonlyArray<Record<string, unknown>>>(
		(acc, [name, table]) =>
			acc.flatMap((options) => choicesFor(table).map((value) => ({ ...options, [name]: value }))),
		[{}],
	)

describe("variants() matches class-variance-authority on the kit's definitions", () => {
	it("captured every *.styles.ts definition", () => {
		expect(Object.keys(modules).length).toBeGreaterThan(10)
		expect(definitions.length).toBeGreaterThanOrEqual(17)
	})

	it("emits identical class strings for every combination", () => {
		const checked = definitions.reduce((count, { base, config }) => {
			const reference = Cva.cva(base, config)
			const ours = variants(base, config)
			const cases = combinations(config).flatMap((options) => [
				options,
				{ ...options, className: "extra-class" },
				{ ...options, className: ["a", false, ["b", null]] },
			])
			cases.forEach((options) => expect(ours(options)).toBe(reference(options)))
			expect(ours()).toBe(reference())
			return count + cases.length
		}, 0)
		expect(checked).toBeGreaterThan(1000)
	})

	it("cx joins like clsx", () => {
		const inputs = [
			["a", "b"],
			["a", undefined, null, false, "", 0, "b"],
			[["a", ["b", [false, "c"]]], "d"],
			[1, "x", NaN],
			[" a ", "  b"],
			[[], [[]], ""],
		] as const
		inputs.forEach((args) => expect(cx(...args)).toBe(Cva.cx(...args)))
	})
})
