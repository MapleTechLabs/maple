import { spawnSync } from "node:child_process"
import { assert, describe, it } from "@effect/vitest"
import {
	PROBE_OUTPUT_BYTES,
	PROBE_SENTINEL,
	type ProbeCheck,
	assessProbe,
	parseProbe,
	probeScript,
} from "./executor-probe"

const line = (id: string, exitCode: number, output: string) =>
	`${PROBE_SENTINEL} ${id} ${exitCode} ${Buffer.from(output).toString("base64")}`

const CHECKS: ReadonlyArray<ProbeCheck> = [
	{ id: "egress", question: "blocked?", expect: "fails", command: "exit 7" },
	{ id: "gateway", question: "reached?", expect: "succeeds", contains: "marker", command: "echo marker" },
	{ id: "kernel", question: "which?", expect: "observe", command: "uname" },
]

describe("parseProbe", () => {
	it("decodes each result line and ignores everything else", () => {
		const stdout = ["noise", line("egress", 7, "refused\nby policy"), "", line("gateway", 0, "")].join(
			"\n",
		)
		assert.deepStrictEqual(parseProbe(stdout), [
			{ id: "egress", exitCode: 7, output: "refused\nby policy" },
			{ id: "gateway", exitCode: 0, output: "" },
		])
	})

	it("keeps the last line for a repeated id and drops a malformed exit code", () => {
		const stdout = [
			line("egress", 0, "first"),
			line("egress", 1, "second"),
			`${PROBE_SENTINEL} gateway x`,
		].join("\n")
		assert.deepStrictEqual(parseProbe(stdout), [{ id: "egress", exitCode: 1, output: "second" }])
	})
})

describe("assessProbe", () => {
	it("passes a check that behaved as expected and fails one that did not", () => {
		const verdicts = assessProbe(
			[
				{ id: "egress", exitCode: 0, output: "connected" },
				{ id: "gateway", exitCode: 0, output: "marker GET /probe" },
				{ id: "kernel", exitCode: 0, output: "Linux" },
			],
			CHECKS,
		).map((check) => [check.id, check.verdict])
		assert.deepStrictEqual(verdicts, [
			["egress", "fail"],
			["gateway", "pass"],
			["kernel", "observed"],
		])
	})

	it("fails a succeeding check whose output lacks the expected text", () => {
		const [, gateway] = assessProbe([{ id: "gateway", exitCode: 0, output: "some other server" }], CHECKS)
		assert.strictEqual(gateway?.verdict, "fail")
	})

	it("fails a failing check that failed for the wrong reason", () => {
		const limit: ProbeCheck = {
			id: "limit",
			question: "",
			expect: "fails",
			contains: "started",
			command: "",
		}
		const verdicts = assessProbe(
			[{ id: "limit", exitCode: 1, output: "cannot execute" }],
			[limit],
		).concat(assessProbe([{ id: "limit", exitCode: 1, output: "started\nout of memory" }], [limit]))
		assert.deepStrictEqual(
			verdicts.map((check) => check.verdict),
			["fail", "pass"],
		)
	})

	it("reports a check with no result as missing", () => {
		assert.deepStrictEqual(
			assessProbe([], CHECKS).map((check) => check.verdict),
			["missing", "missing", "missing"],
		)
	})
})

// The script needs GNU `timeout`, as the container has; CI runs on Linux.
const hasTimeout = spawnSync("timeout", ["--version"]).status === 0

describe.skipIf(!hasTimeout)("probeScript in bash", () => {
	const run = (checks: ReadonlyArray<ProbeCheck>) =>
		spawnSync("bash", ["-c", probeScript(checks)], { encoding: "utf8" }).stdout

	it("reports every check's exit code and output, quotes included", () => {
		const results = parseProbe(
			run(
				CHECKS.concat({
					id: "quoted",
					question: "",
					expect: "observe",
					command: `printf "%s" "it's \\"here\\""; exit 3`,
				}),
			),
		)
		assert.deepStrictEqual(results, [
			{ id: "egress", exitCode: 7, output: "" },
			{ id: "gateway", exitCode: 0, output: "marker" },
			{ id: "kernel", exitCode: 0, output: results[2]?.output ?? "" },
			{ id: "quoted", exitCode: 3, output: `it's "here"` },
		])
	})

	it("cuts a check's output at the bound", () => {
		const [result] = parseProbe(
			run([
				{
					id: "loud",
					question: "",
					expect: "observe",
					command: `head -c ${PROBE_OUTPUT_BYTES * 2} /dev/zero | tr '\\0' a`,
				},
			]),
		)
		assert.strictEqual(result?.output.length, PROBE_OUTPUT_BYTES)
	})
})
