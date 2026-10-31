// Differential fuzzer: generates rules and records, runs each case through this package's
// engine and the gateway's (the `ingest_rules_oracle` example in apps/ingest), and shrinks the
// first disagreement to a minimal case. Usage:
//   bun run fuzz [--runs 2000] [--seed <seed>] [--replay <token>] [--no-build]
import { execFileSync, spawn } from "node:child_process"
import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isDeepStrictEqual, parseArgs } from "node:util"
import { Arbitrary, Effect, Ref, Schema } from "effect"
import { isJsonObject, member, runCase, type FixtureCase } from "../src/conformance"
import { fuzzCase } from "../src/fuzz-arbitraries"

const { values: args } = parseArgs({
	options: {
		runs: { type: "string", default: "2000" },
		seed: { type: "string" },
		replay: { type: "string" },
		"no-build": { type: "boolean", default: false },
	},
})

const ingest = join(import.meta.dirname, "../../../apps/ingest")
const oraclePath = join(ingest, "target/release/examples/ingest_rules_oracle")
if (!args["no-build"])
	execFileSync(
		"cargo",
		["build", "--locked", "--release", "--example", "ingest_rules_oracle", "--features", "conformance"],
		{
			cwd: ingest,
			stdio: "inherit",
		},
	)

const oracle = spawn(oraclePath, { stdio: ["pipe", "pipe", "inherit"] })

/** Oracle replies split on `\n` only; readline would also split inside strings on U+2028. */
async function* lines(stream: AsyncIterable<string>) {
	let pending = ""
	for await (const chunk of stream) {
		const parts = (pending + chunk).split("\n")
		pending = parts.pop() ?? ""
		yield* parts
	}
}
oracle.stdout.setEncoding("utf8")
const replies = lines(oracle.stdout)

const parseOutcome = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))

/** The gateway engine's outcome; requests run one at a time, so replies stay in order. */
const gateway = (fixture: FixtureCase) =>
	Effect.promise(async (): Promise<Schema.Json> => {
		oracle.stdin.write(`${JSON.stringify(fixture)}\n`)
		const reply = await replies.next()
		return reply.done === true ? { oracleExited: true } : parseOutcome(reply.value)
	})

const clip = (value: Schema.Json | undefined, at = 0) => {
	const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "undefined")
	return text.length <= 160
		? text
		: `…${text.slice(Math.max(0, at - 60), at + 100)}… (${text.length} chars)`
}

/** The first path where the two outcomes differ, with both sides clipped around it. */
const firstDifference = (
	ts: Schema.Json | undefined,
	rust: Schema.Json | undefined,
	path = "$",
): string | null => {
	if (isDeepStrictEqual(ts, rust)) return null
	if (typeof ts === "string" && typeof rust === "string") {
		const at = [...ts].findIndex((char, index) => char !== [...rust][index])
		return `${path} at char ${at}\n  ts:   ${clip(ts, at)}\n  rust: ${clip(rust, at)}`
	}
	if (isJsonObject(ts) && isJsonObject(rust)) {
		const keys = [...new Set([...Object.keys(ts), ...Object.keys(rust)])]
		const nested = keys
			.map((key) => firstDifference(member(ts, key), member(rust, key), `${path}.${key}`))
			.find((difference) => difference !== null)
		if (nested !== undefined) return nested
	}
	return `${path}\n  ts:   ${clip(ts)}\n  rust: ${clip(rust)}`
}

type Exercised = "dropped" | "redacted" | "untouched"

/** What a passing case exercised, so a green run that never redacts anything is visible. */
const exercised = (fixture: FixtureCase, outcome: Schema.Json): Exercised => {
	const input = JSON.stringify(fixture.input)
	const output = JSON.stringify(outcome)
	if (member(outcome, "dropped") === true) return "dropped"
	return output.includes("REDACTED") || output.includes("hash:") || output.length < input.length - 60
		? "redacted"
		: "untouched"
}

const seed = args.seed ?? String(Date.now())
const runs = Number(args.runs)
console.log(`ingest rules differential fuzz: ${runs} cases, seed ${seed}`)

const coverage = await Effect.runPromise(Ref.make({ dropped: 0, redacted: 0, untouched: 0, scanCap: 0 }))
const result = await Effect.runPromise(
	Arbitrary.checkEffect(
		fuzzCase,
		(fixture) =>
			Effect.gen(function* () {
				const remote = yield* gateway(fixture)
				const ts = runCase(fixture)
				const kind = exercised(fixture, ts)
				const nearCap = JSON.stringify(fixture.input).length > 16_000 ? 1 : 0
				yield* Ref.update(coverage, (counts) => ({
					...counts,
					[kind]: counts[kind] + 1,
					scanCap: counts.scanCap + nearCap,
				}))
				return isDeepStrictEqual(remote, ts)
			}),
		{ runs, seed, replay: args.replay },
	),
)
const shrunkRemote = result._tag === "Falsified" ? await Effect.runPromise(gateway(result.shrunkInput)) : null
oracle.stdin.end()

if (result._tag === "Falsified") {
	const shrunk = result.shrunkInput
	const report = { case: shrunk, ts: runCase(shrunk), rust: shrunkRemote, seed, replay: result.replay }
	const path = join(tmpdir(), "ingest-rules-fuzz-failure.json")
	writeFileSync(path, `${JSON.stringify(report, null, "\t")}\n`)
	console.error(`The engines disagree after ${result.runs} cases (${result.shrinks} shrinks).`)
	console.error(firstDifference(report.ts, report.rust))
	console.error(`rules: ${JSON.stringify(shrunk.rules)}`)
	console.error(`Written to ${path}. Rerun with --seed ${seed} or --replay ${result.replay}.`)
	process.exit(1)
}
if (result._tag !== "Passed") {
	console.error(Arbitrary.formatCheckFailure(result))
	process.exit(1)
}
const counts = await Effect.runPromise(Ref.get(coverage))
console.log(`${result.runs} cases agree.`)
console.log(
	`dropped ${counts.dropped}, redacted ${counts.redacted}, untouched ${counts.untouched}; ${counts.scanCap} near the scan cap`,
)
