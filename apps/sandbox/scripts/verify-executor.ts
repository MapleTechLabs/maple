/**
 * Runs a whole executor session in the deployed image: prepare a fixture repository through the
 * gateway, then one escape attempt per control the security-audit skill requires before target code
 * may run, then artifact promotion. Prints every check and exits non-zero when one misbehaves.
 *
 *   bun run --cwd apps/sandbox verify:executor
 *
 * The executor container sits on an internal Docker network (no internet: the stand-in for
 * `enableInternet: false`) where only `registry.maple.internal` answers: a second container running
 * the real `gatewayFetch` (`executor-gateway-stand-in.ts`), with `git http-backend` standing in for
 * GitHub and the real npm registry behind it. `--privileged` because Cloudflare's container root
 * holds every capability and a writable cgroup2 root (probe v2). Needs Docker and internet.
 */
import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { EXECUTOR_LIMITS, ExecutorPromotion } from "@maple/domain/executor"
import { Schema } from "effect"
import { GATEWAY_HOST } from "../src/executor-probe.ts"
import {
	CHECKOUT_DIR,
	agentScratch,
	parsePrepareStatus,
	parseRunOutput,
	prepareRunner,
	prepareStatusScript,
	promoteScript,
	runScript,
} from "../src/executor-scripts.ts"

/** Native, not the deployed amd64: under emulation the limits would stop the emulator instead. */
const IMAGE = "maple-sandbox:executor"
const RUN = `maple-executor-${process.pid}`
const NETWORK = `${RUN}-internal`
const GATEWAY = `${RUN}-gateway`
const EXECUTOR = `${RUN}-executor`
const REPO_ROOT = resolve(import.meta.dirname, "../../..")

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const sh = (command: string, cwd?: string) => execFileSync("bash", ["-c", command], { cwd, encoding: "utf8" })
const docker = (args: ReadonlyArray<string>) =>
	spawnSync("docker", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** A root shell in the executor, the way the Durable Object's `exec()` runs its scripts. */
const exec = (script: string) => docker(["exec", EXECUTOR, "bash", "-c", script])

const cleanup = () => {
	docker(["rm", "--force", GATEWAY, EXECUTOR])
	docker(["network", "rm", NETWORK])
}

/** The fixture: an npm project whose own install script must never run, and a bun project beside it. */
const fixture = (): { readonly dir: string; readonly sha: string } => {
	const root = mkdtempSync(join(tmpdir(), "maple-executor-fixture-"))
	const work = join(root, "work")
	mkdirSync(join(work, "tools"), { recursive: true })
	writeFileSync(
		join(work, "package.json"),
		encodeJson({
			name: "fixture",
			version: "1.0.0",
			private: true,
			scripts: {
				preinstall: "touch /tmp/PWNED-BY-PREPARE",
				postinstall: "touch /tmp/PWNED-BY-PREPARE",
			},
			dependencies: { ms: "2.1.3" },
		}),
	)
	writeFileSync(
		join(work, "tools/package.json"),
		encodeJson({ name: "tools", private: true, dependencies: { "left-pad": "1.3.0" } }),
	)
	sh("npm install --package-lock-only --ignore-scripts --no-audit --no-fund >/dev/null", work)
	sh("bun install --lockfile-only >/dev/null 2>&1", join(work, "tools"))
	sh(
		"git init -q . && git add -A && git -c user.email=f@f -c user.name=f commit -qm fixture && git rev-parse HEAD",
		work,
	)
	sh(`git clone -q --bare ${work} ${join(root, "fixture.git")}`)
	sh(`git -C ${join(root, "fixture.git")} config uploadpack.allowAnySHA1InWant true`)
	return { dir: root, sha: sh("git rev-parse HEAD", work).trim() }
}

const start = (fixtureDir: string) => {
	execFileSync("docker", ["network", "create", "--internal", NETWORK], { stdio: "ignore" })
	process.on("exit", cleanup)
	// The gateway reaches the internet on the default bridge and serves the internal network.
	execFileSync(
		"docker",
		[
			"run",
			"--detach",
			"--name",
			GATEWAY,
			"--volume",
			`${REPO_ROOT}:${REPO_ROOT}:ro`,
			"--volume",
			`${fixtureDir}:/fixture:ro`,
			"--entrypoint",
			"bun",
			IMAGE,
			`${REPO_ROOT}/apps/sandbox/scripts/executor-gateway-stand-in.ts`,
			"/fixture",
		],
		{ stdio: "ignore" },
	)
	execFileSync("docker", ["network", "connect", "--alias", GATEWAY_HOST, NETWORK, GATEWAY], {
		stdio: "ignore",
	})
	execFileSync(
		"docker",
		["run", "--detach", "--name", EXECUTOR, "--network", NETWORK, "--privileged", IMAGE],
		{ stdio: "ignore" },
	)
	for (let attempt = 0; attempt < 50; attempt++) {
		if (docker(["logs", GATEWAY]).stdout.includes("stand-in gateway ready")) return
		sleep(200)
	}
	console.error(`the stand-in gateway did not start:\n${docker(["logs", GATEWAY]).stderr}`)
	process.exit(1)
}

interface Ran {
	readonly exitCode: number
	readonly stdout: string
	readonly stderr: string
	readonly ms: number
	readonly state: string
}

let calls = 0
const runAs = (
	agentId: string,
	command: string,
	timeoutMs = 30_000,
	cwd: "checkout" | "scratch" = "checkout",
): Ran => {
	const started = Date.now()
	const answer = exec(runScript({ agentId, callId: `call-${++calls}`, command, cwd, timeoutMs }))
	const parsed = parseRunOutput(answer.stdout)
	return {
		exitCode: parsed?.trailer.exitCode ?? -1,
		stdout: parsed?.body ?? answer.stdout,
		stderr: answer.stderr,
		ms: Date.now() - started,
		state: parsed?.trailer.state ?? "no trailer",
	}
}

const results: Array<{
	readonly name: string
	readonly failure: string | undefined
	readonly detail: string
}> = []
const check = (name: string, failure: string | undefined, detail = "") => {
	results.push({ name, failure, detail })
	console.log(
		`${failure === undefined ? "  ok" : "!! FAIL"}  ${name}${failure === undefined ? "" : `: ${failure}`}`,
	)
	if (detail !== "") console.log(`        ${detail.trim().replaceAll("\n", "\n        ").slice(0, 600)}`)
}

const output = (ran: Ran) => `${ran.stdout}\n${ran.stderr}`.trim()

/** The command must fail, and for the right reason. */
const refused = (name: string, ran: Ran, because: RegExp) =>
	check(
		name,
		ran.state !== "started"
			? `did not start (${ran.state})`
			: ran.exitCode === 0
				? "succeeded"
				: because.test(output(ran))
					? undefined
					: `failed for another reason (exit ${ran.exitCode})`,
		`exit ${ran.exitCode}: ${output(ran)}`,
	)

execFileSync("docker", ["build", "--quiet", "--tag", IMAGE, `${import.meta.dirname}/../image`], {
	stdio: ["ignore", "ignore", "inherit"],
})
const { dir, sha } = fixture()
start(dir)

console.log("\n== prepare")
check(
	"status before prepare",
	parsePrepareStatus(exec(prepareStatusScript()).stdout)._tag === "claimed" ? undefined : "not claimed",
)
const prepared = exec(prepareRunner(sha))
const status = parsePrepareStatus(exec(prepareStatusScript()).stdout)
check(
	"prepare finished",
	status._tag === "ready" && status.sha === sha ? undefined : `status ${status._tag}`,
	status._tag === "failed" ? status.log : prepared.stderr,
)
const installs = status._tag === "ready" ? status.installs : []
for (const [dirName, manager] of [
	[".", "npm"],
	["tools", "bun"],
] as const) {
	const install = installs.find((entry) => entry.dir === dirName)
	check(
		`${manager} install in ${dirName}`,
		install?.outcome === "installed" && install.manager === manager ? undefined : encodeJson(install),
		install?.detail,
	)
}
check(
	"no install script ran during prepare",
	exec("ls /tmp/PWNED-BY-PREPARE 2>/dev/null").status === 0 ? "an install script ran" : undefined,
)
check(
	"the checkout is root-owned and not writable by others",
	exec(`find ${CHECKOUT_DIR} \\( ! -uid 0 -o -perm /022 \\) -print -quit`).stdout.trim() === ""
		? undefined
		: "found a writable or foreign-owned file",
)
check(
	"repeated status stays ready",
	parsePrepareStatus(exec(prepareStatusScript()).stdout)._tag === "ready" ? undefined : "not ready",
)

console.log("\n== execute: the target runs")
const poc = runAs(
	"hunter-a",
	`node -e 'console.log(require("ms")("2 days"))' && cd tools && node -e 'console.log(require("left-pad")("7", 3, "0"))'`,
)
check(
	"installed dependencies load",
	poc.exitCode === 0 && output(poc) === "172800000\n007" ? undefined : `exit ${poc.exitCode}`,
	output(poc),
)
// bash itself adds PWD, SHLVL and _; everything else must be the allowlist, exactly.
const ALLOWED_ENV =
	"CI GIT_CONFIG_GLOBAL HOME LANG PATH TMPDIR XDG_CACHE_HOME npm_config_cache npm_config_update_notifier"
const identity = runAs(
	"hunter-a",
	`id -u; grep CapEff /proc/self/status; env | cut -d= -f1 | grep -vxE 'PWD|SHLVL|_' | LC_ALL=C sort | tr '\\n' ' '`,
)
const [uid = "", caps = "", names = ""] = identity.stdout.split("\n")
check(
	"its own uid, no capabilities, only allowlisted environment",
	/^3\d{4}$/u.test(uid) && caps === "CapEff:\t0000000000000000" && names.trim() === ALLOWED_ENV
		? undefined
		: "unexpected identity",
	identity.stdout,
)
const scratchWrite = runAs(
	"hunter-a",
	`echo note > "$HOME/../note" && mkdir -p "$TMPDIR/x" && cat "$HOME/../note"`,
)
check(
	"its scratch and TMPDIR are writable",
	scratchWrite.exitCode === 0 ? undefined : `exit ${scratchWrite.exitCode}`,
	output(scratchWrite),
)
const loopback = runAs(
	"hunter-a",
	`node -e 'const s = require("node:http").createServer((_, r) => r.end("loopback-ok")).listen(0, "127.0.0.1", async () => { console.log(await (await fetch("http://127.0.0.1:" + s.address().port)).text()); s.close() })'`,
)
check(
	"loopback works",
	output(loopback) === "loopback-ok" ? undefined : `exit ${loopback.exitCode}`,
	output(loopback),
)

console.log("\n== execute: escape attempts")
refused(
	"write the checkout",
	runAs("hunter-a", `touch ${CHECKOUT_DIR}/pwned`),
	/Read-only file system|Permission denied/u,
)
refused(
	"modify an installed dependency",
	runAs("hunter-a", `echo 'module.exports = 1' > ${CHECKOUT_DIR}/node_modules/ms/index.js`),
	/Read-only file system|Permission denied/u,
)
// Directories bound to the scratch's `.tmp` (mountinfo root `/.tmp`) are the scratch itself.
const writable = runAs(
	"hunter-a",
	`bound=$(awk '$4 == "/.tmp" { print $5 }' /proc/self/mountinfo | paste -sd'|' -); find / \\( -path /proc -o -path /sys -o -path /dev \\) -prune -o ! -type l -writable -print 2>/dev/null | grep -Ev "^(\${bound}|${agentScratch("hunter-a")})(/|$)"; true`,
)
check(
	"nothing writable outside its scratch",
	writable.stdout.trim() === "" ? undefined : "writable paths found",
	writable.stdout,
)
refused(
	"reach the gateway",
	runAs(
		"hunter-a",
		`node -e 'fetch("http://${GATEWAY_HOST}/npm/ms").then((r) => console.log(r.status), (e) => { console.error(String(e.cause ?? e)); process.exit(1) })'`,
	),
	/EAI_AGAIN|ENOTFOUND|ENETUNREACH|fetch failed/u,
)
refused(
	"reach the internet by IP",
	runAs("hunter-a", "timeout 5 bash -c 'exec 3<>/dev/tcp/1.1.1.1/80'"),
	/Network is unreachable/u,
)
runAs("hunter-b", `echo other-agent-secret > "$HOME/../secret"`)
refused(
	"read another agent's scratch",
	runAs("hunter-a", `cat ${agentScratch("hunter-b")}/secret`),
	/Permission denied/u,
)
refused(
	"enter the container's network namespace",
	runAs("hunter-a", "nsenter -t 1 -n true"),
	/Permission denied|Operation not permitted|No such process/u,
)
const procs = runAs("hunter-a", "ls /proc | grep -cE '^[0-9]+$'")
check(
	"sees only its own processes",
	Number(procs.stdout.trim()) <= 5 ? undefined : `${procs.stdout.trim()} processes visible`,
	procs.stdout,
)

console.log("\n== execute: limits")
refused(
	"memory past the limit",
	runAs("hunter-a", `node -e 'const held = []; for (;;) held.push(Buffer.alloc(8 << 20, 1))'`, 60_000),
	/Killed|out of memory|allocation failed|ERR_OUT_OF_RANGE|137/u,
)
refused(
	"a fork loop",
	runAs("hunter-a", `for i in $(seq ${EXECUTOR_LIMITS.processes + 50}); do sleep 10 & done; wait`, 60_000),
	/fork|Resource temporarily unavailable/u,
)
refused(
	"a file past the size limit",
	runAs("hunter-a", `head -c ${EXECUTOR_LIMITS.fileSizeBytes + 1024 * 1024} /dev/zero > "$HOME/../big"`),
	/File size limit exceeded|^$/u,
)
const slow = runAs("hunter-a", "sleep 60", 3000)
check(
	"the wall clock stops a slow command",
	(slow.exitCode === 124 || slow.exitCode === 137) && slow.ms < 20_000
		? undefined
		: `exit ${slow.exitCode} after ${slow.ms}ms`,
)
runAs("hunter-a", "nohup sleep 300 > /dev/null 2>&1 & echo detached")
check(
	"nothing it starts outlives the command",
	exec("pgrep -f 'sleep 300'").stdout.trim() === "" ? undefined : "a detached process survived",
)

console.log("\n== promotion")
runAs(
	"hunter-a",
	`s=${agentScratch("hunter-a")}; mkdir -p "$s/poc" && echo 'cross-tenant row: tenant-b' > "$s/poc/out.txt" && ln -s /etc/shadow "$s/poc/link" && echo x > "$s/poc/a" && ln "$s/poc/a" "$s/poc/hard"`,
)
const promotion = exec(
	promoteScript(
		"hunter-a",
		["poc/out.txt", "poc/link", "poc/hard"].map(
			(path) => new ExecutorPromotion({ path, maxBytes: 4096 }),
		),
	),
)
check(
	"promotes the regular file and refuses the symlink and the hard link",
	promotion.stdout.includes('"path": "poc/out.txt", "bytes": 27') &&
		promotion.stdout.includes('"poc/link"') &&
		promotion.stdout.includes('"poc/hard"') &&
		/"promoted": \[\{[^\]]*\}\]/u.test(promotion.stdout)
		? undefined
		: "unexpected promotion",
	promotion.stdout || promotion.stderr,
)
refused(
	"read its own promoted artifacts",
	runAs("hunter-a", "cat /audit/agents/hunter-a/artifacts/poc/out.txt"),
	/Permission denied/u,
)

const failed = results.filter((result) => result.failure !== undefined)
console.log(`\n${results.length - failed.length}/${results.length} checks as expected`)
if (failed.length > 0) {
	console.error(`failed: ${failed.map((result) => result.name).join(", ")}`)
	process.exit(1)
}
