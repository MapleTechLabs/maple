import { Effect } from "effect"
import type { CompiledQuery } from "../ch/compile"
import { caseFromCompiled, validateSuite, type BenchmarkInput, type Sample, type Suite } from "./model"

/** Compile from the same inputs that will be recorded as experiment identity. */
export const query = <I extends Readonly<Record<string, BenchmarkInput | undefined>>, E>(options: {
	readonly id: string
	readonly inputs: I
	readonly compile: (inputs: I) => Effect.Effect<CompiledQuery<unknown>, E>
	readonly results?: "ordered" | "unordered" | "skip"
}): Effect.Effect<Sample, E> =>
	Effect.suspend(() => options.compile(options.inputs)).pipe(
		Effect.map((compiled) => ({
			...caseFromCompiled(options.id, compiled, options.inputs),
			results: options.results,
		})),
	)

/** A suite module may export this Effect directly; the CLI compiles before timing. */
export const defineSuite = <E>(options: {
	readonly name: string
	readonly dataset: string
	readonly cases: ReadonlyArray<Sample | Effect.Effect<Sample, E>>
}) =>
	Effect.forEach(options.cases, (item) => (Effect.isEffect(item) ? item : Effect.succeed(item))).pipe(
		Effect.map(
			(samples): Suite => ({ version: 1, source: options.name, dataset: options.dataset, samples }),
		),
		Effect.flatMap(validateSuite),
	)
