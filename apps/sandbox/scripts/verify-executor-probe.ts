/**
 * Runs the executor probe's real script in the deployed image, twice, and prints every verdict.
 *
 *   bun run --cwd apps/sandbox verify:executor-probe            # both runs
 *   bun run --cwd apps/sandbox verify:executor-probe --isolated # offline: only the first
 *
 * 1. `--network none`, the local stand-in for `enableInternet: false`: every check Docker can
 *    answer must behave as on Cloudflare. Only the gateway is left out: nothing intercepts here.
 * 2. The positive control, on a network with internet and a stand-in gateway answering
 *    `registry.maple.internal`: every egress check MUST catch the leak (so none can pass vacuously),
 *    the gateway must answer, and every `isolated-*` check must still hold, since Execute's
 *    namespace has to block egress even where the container's own network is open.
 *
 * Needs Docker, and internet for the control. `--privileged` because Cloudflare's container root
 * holds every capability (probe v1: CapEff 000001ffffffffff) and a writable cgroup2 root. Exits
 * non-zero when either run has a check that did not behave as expected.
 */
import { Schema } from "effect"
import { execFileSync, spawnSync } from "node:child_process"
import {
	type AssessedCheck,
	EGRESS_CHECK_IDS,
	GATEWAY_HOST,
	GATEWAY_MARKER,
	type RunExpectation,
	assessProbe,
	parseProbe,
	probeScript,
	unexpectedChecks,
} from "../src/executor-probe.ts"

const encodeJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.String))

/**
 * Built for the host's platform, not the deployed amd64: under emulation an address-space limit
 * stops the emulator before the program it limits, so the limit checks would measure the wrong thing.
 */
const IMAGE = "maple-sandbox:executor-probe"
const NETWORK = `maple-executor-probe-${process.pid}`
const GATEWAY = `maple-executor-gateway-${process.pid}`

const docker = (args: ReadonlyArray<string>) =>
	spawnSync("docker", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 })

const runProbe = (network: string): ReadonlyArray<AssessedCheck> =>
	assessProbe(
		parseProbe(
			docker([
				"run",
				"--rm",
				"--network",
				network,
				"--privileged",
				"--entrypoint",
				"bash",
				IMAGE,
				"-c",
				probeScript(),
			]).stdout ?? "",
		),
	)

const report = (title: string, checks: ReadonlyArray<AssessedCheck>, expectation: RunExpectation) => {
	const unexpected = unexpectedChecks(checks, expectation)
	console.log(`\n== ${title}`)
	for (const check of checks) {
		const mark = unexpected.includes(check) ? "!!" : expectation.unanswerable?.has(check.id) ? "--" : "  "
		const output = (check.output ?? "").trim().replaceAll("\n", "\n             ")
		console.log(
			`${mark} ${check.verdict.padEnd(8)}  ${check.id}  (exit ${check.exitCode ?? "-"})\n             ${output}`,
		)
	}
	console.log(
		`${checks.length - unexpected.length}/${checks.length} as expected${unexpected.length > 0 ? `; unexpected: ${unexpected.map((check) => check.id).join(", ")}` : ""}`,
	)
	return unexpected.length
}

/** The control's stand-in for `RegistryGateway`: same answer shape, reached by the same name. */
const GATEWAY_SERVER = `require("node:http").createServer((req, res) => res.end(${encodeJsonString(GATEWAY_MARKER)} + " " + req.method + " " + req.headers.host + req.url)).listen(80)`

const cleanup = () => {
	docker(["rm", "--force", GATEWAY])
	docker(["network", "rm", NETWORK])
}

const startGateway = () => {
	execFileSync("docker", ["network", "create", NETWORK], { stdio: "ignore" })
	process.on("exit", cleanup)
	execFileSync(
		"docker",
		[
			"run",
			"--detach",
			"--rm",
			"--name",
			GATEWAY,
			"--network",
			NETWORK,
			"--network-alias",
			GATEWAY_HOST,
			"--entrypoint",
			"node",
			IMAGE,
			"-e",
			GATEWAY_SERVER,
		],
		{ stdio: "ignore" },
	)
	const ready = `fetch("http://127.0.0.1/").then(() => process.exit(0), () => process.exit(1))`
	for (let attempt = 0; attempt < 50; attempt++) {
		if (docker(["exec", GATEWAY, "node", "-e", ready]).status === 0) return
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)
	}
	console.error("the stand-in gateway did not answer within 10s; see `docker logs` for it")
	process.exit(1)
}

execFileSync("docker", ["build", "--quiet", "--tag", IMAGE, `${import.meta.dirname}/../image`], {
	stdio: ["ignore", "ignore", "inherit"],
})

let unexpected = report("internet off (--network none)", runProbe("none"), {
	unanswerable: new Set(["gateway-http"]),
})

if (!process.argv.includes("--isolated")) {
	startGateway()
	unexpected += report("positive control: internet on, stand-in gateway", runProbe(NETWORK), {
		// Docker networks route no IPv6 unless configured to, so the host decides that one.
		unanswerable: new Set(["egress-http-ipv6"]),
		leaks: new Set([
			"egress-dns",
			"egress-https",
			...EGRESS_CHECK_IDS.filter((id) => id.startsWith("egress-") && id !== "egress-http-ipv6"),
		]),
	})
}

if (unexpected > 0) {
	console.error(
		`\n${unexpected} check(s) did not behave as expected. A control leak check marked !! with "blocked:" means the host has no internet: rerun online, or with --isolated.`,
	)
	process.exit(1)
}
