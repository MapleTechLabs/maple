/**
 * Runs the executor probe's real script in the deployed image with `--network none`, the local
 * stand-in for `enableInternet: false`, and prints every check's verdict.
 *
 *   bun run --cwd apps/sandbox verify:executor-probe
 *
 * Needs Docker. It proves the script and its expectations, not the platform: the gateway checks
 * fail here because no gateway is intercepting, and only the scheduled run on Cloudflare answers
 * those (`src/executor.ts`). Exits non-zero when a check that Docker can answer fails.
 */
import { execFileSync, spawnSync } from "node:child_process"
import { assessProbe, parseProbe, probeScript } from "../src/executor-probe.ts"

/**
 * Built for the host's platform, not the deployed amd64: under emulation an address-space limit
 * stops the emulator before the program it limits, so the limit checks would measure the wrong thing.
 */
const IMAGE = "maple-sandbox:executor-probe"

/** Checks only the Cloudflare runtime can answer: there is no gateway in Docker. */
const PLATFORM_ONLY = new Set(["gateway-http"])

execFileSync("docker", ["build", "--quiet", "--tag", IMAGE, `${import.meta.dirname}/../image`], {
	stdio: ["ignore", "ignore", "inherit"],
})

const run = spawnSync(
	"docker",
	[
		"run",
		"--rm",
		"--network",
		"none",
		"--cap-add",
		"SYS_ADMIN",
		"--entrypoint",
		"bash",
		IMAGE,
		"-c",
		probeScript(),
	],
	{ encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
)

const checks = assessProbe(parseProbe(run.stdout ?? ""))
const failures = checks.filter(
	(check) => !PLATFORM_ONLY.has(check.id) && (check.verdict === "fail" || check.verdict === "missing"),
)
for (const check of checks) {
	const output = (check.output ?? "").trim().replaceAll("\n", "\n          ")
	console.log(
		`${check.verdict.padEnd(8)}  ${check.id}  (exit ${check.exitCode ?? "-"})\n          ${output}`,
	)
}
console.log(
	`\n${checks.length - failures.length}/${checks.length} as expected${PLATFORM_ONLY.size > 0 ? `, ${[...PLATFORM_ONLY].join(", ")} answered only on Cloudflare` : ""}`,
)
if (failures.length > 0) {
	console.error(`unexpected: ${failures.map((check) => check.id).join(", ")}`)
	process.exit(1)
}
