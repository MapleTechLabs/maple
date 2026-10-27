/**
 * The execution sandbox's platform probe: what an `Executor` container started with
 * `enableInternet: false` can and cannot do on Cloudflare's runtime. Every answer the execution
 * environment's design depends on (no egress, the registry gateway, resource limits, privilege
 * drop) is one check here, so the design is settled by a run on the real platform, not docs.
 *
 * Pure: the checks, the shell program that runs them, and the reading of its output. The
 * Durable Object that starts the container lives in `executor.ts`.
 */
import { shellQuote } from "@maple/domain/sandbox"

/** Bumped when the checks change, so the next scheduled run probes again. */
export const EXECUTOR_PROBE_VERSION = 1

/** A host only the registry gateway answers, over plain HTTP: the `DirectoryBackup` pattern. */
export const GATEWAY_HOST = "registry.maple.internal"
/** The same, intercepted over HTTPS, to learn whether the container trusts the runtime's certificate. */
export const GATEWAY_TLS_HOST = "registry-tls.maple.internal"
/** What every gateway answer carries, so a check can tell it from anything else that replied. */
export const GATEWAY_MARKER = "maple-executor-gateway"

/** The unprivileged identity the hardening checks drop to. */
const NOBODY = "setpriv --reuid=65534 --regid=65534 --clear-groups"

/**
 * `succeeds`: exit 0. `fails`: any other exit. With `contains`, the output must also hold one of
 * those texts, so a failure for the wrong reason (a missing binary, a timeout) does not pass.
 * `observe`: recorded for a human to read; it gates nothing.
 */
export type ProbeExpectation = "succeeds" | "fails" | "observe"

export interface ProbeCheck {
	readonly id: string
	readonly question: string
	readonly expect: ProbeExpectation
	readonly contains?: ReadonlyArray<string>
	readonly command: string
}

/** A Node one-liner that prints a response's status and body, or the fetch error, and exits non-zero on error. */
const nodeFetch = (url: string) =>
	`node -e ${shellQuote(
		`fetch(${JSON.stringify(url)}, { signal: AbortSignal.timeout(8000) }).then(async (r) => console.log(r.status, (await r.text()).slice(0, 300))).catch((e) => { console.error(String(e.cause ?? e)); process.exit(1) })`,
	)}`

const LOOPBACK = `node -e ${shellQuote(
	`const s = require("node:http").createServer((_, res) => res.end("loopback-ok")).listen(0, "127.0.0.1", async () => { const r = await fetch("http://127.0.0.1:" + s.address().port); console.log(await r.text()); s.close() })`,
)}`

export const PROBE_CHECKS: ReadonlyArray<ProbeCheck> = [
	{ id: "kernel", question: "What kernel runs the container?", expect: "observe", command: "uname -srm" },
	{
		id: "resources",
		question: "How many CPUs, how much memory and disk does the instance have?",
		expect: "observe",
		command: "nproc; head -3 /proc/meminfo; df -h / /tmp",
	},
	{
		id: "capabilities",
		question: "Which capabilities does root hold?",
		expect: "observe",
		command: "grep -E '^Cap(Eff|Bnd)' /proc/self/status",
	},
	{
		id: "egress-dns",
		question: "Is public DNS unreachable?",
		expect: "fails",
		contains: ["not found"],
		// getent exits 2 for a name that did not resolve, and prints nothing.
		command: "getent hosts registry.npmjs.org; rc=$?; [ $rc -eq 2 ] && echo 'not found'; exit $rc",
	},
	{
		id: "egress-tcp",
		question: "Is a raw TCP connection to a public IP refused?",
		expect: "fails",
		contains: ["unreachable", "refused", "timed out"],
		command:
			"timeout 8 bash -c 'exec 3<>/dev/tcp/1.1.1.1/443'; rc=$?; [ $rc -eq 124 ] && echo 'connect timed out'; exit $rc",
	},
	{
		id: "egress-https",
		question: "Is a public HTTPS registry unreachable?",
		expect: "fails",
		contains: ["EAI_AGAIN", "ENOTFOUND", "ECONNREFUSED", "ENETUNREACH", "ETIMEDOUT", "TimeoutError"],
		command: nodeFetch("https://registry.npmjs.org/-/ping"),
	},
	{
		id: "loopback",
		question: "Does loopback still work?",
		expect: "succeeds",
		contains: ["loopback-ok"],
		command: LOOPBACK,
	},
	{
		id: "gateway-dns",
		question: "Does the gateway host resolve inside the container?",
		expect: "observe",
		command: `getent hosts ${GATEWAY_HOST}`,
	},
	{
		id: "gateway-http",
		question: "Does an intercepted plain-HTTP host reach the gateway Worker with internet off?",
		expect: "succeeds",
		contains: [GATEWAY_MARKER],
		command: nodeFetch(`http://${GATEWAY_HOST}/probe`),
	},
	{
		id: "gateway-https",
		question: "Does an intercepted HTTPS host reach the gateway, and is its certificate trusted?",
		expect: "observe",
		command: nodeFetch(`https://${GATEWAY_TLS_HOST}/probe`),
	},
	{
		id: "ca-environment",
		question: "Does the runtime hand the container a CA for HTTPS interception?",
		expect: "observe",
		command: "env | grep -iE 'cert|_ca|proxy' | sed 's/=.*/=<set>/'; ls -la /etc/ssl/certs | tail -3",
	},
	{
		id: "unshare-net",
		question: "Can root open a network namespace (CAP_SYS_ADMIN)?",
		expect: "observe",
		command: "unshare -n true",
	},
	{
		id: "privilege-drop",
		question: "Can root drop to an unprivileged uid?",
		expect: "succeeds",
		contains: ["65534"],
		command: `${NOBODY} id -u`,
	},
	{
		id: "prlimit",
		question: "Is prlimit available?",
		expect: "succeeds",
		command: "prlimit --version",
	},
	{
		id: "limit-address-space",
		question: "Does an address-space limit stop a large allocation in a process that started?",
		expect: "fails",
		contains: ["cannot allocate"],
		command: `prlimit --as=134217728 -- bash -c 'echo started; x=$(head -c 300000000 /dev/zero | tr "\\0" a); echo "allocated \${#x}"'`,
	},
	{
		id: "limit-file-size",
		question: "Does a file-size limit stop a large write?",
		expect: "fails",
		// SIGXFSZ kills `dd`, or, where an ignored signal is inherited, the write fails with EFBIG.
		contains: ["File size limit exceeded", "File too large"],
		command:
			'f=$(mktemp); prlimit --fsize=1048576 -- dd if=/dev/zero of="$f" bs=1M count=4 2>&1; rc=$?; rm -f "$f"; exit $rc',
	},
	{
		id: "limit-processes",
		question: "Does a process limit stop an unprivileged fork loop?",
		expect: "fails",
		contains: ["Cannot fork"],
		// `sh` (dash) gives up on a failed fork at once; bash retries for longer than a check may run.
		command: `${NOBODY} prlimit --nproc=8 -- sh -c 'n=0; for i in $(seq 1 20); do sleep 3 & n=$((n+1)); done; echo started=$n'`,
	},
	{
		id: "cgroup",
		question: "Which cgroup controls exist, and are they writable?",
		expect: "observe",
		command:
			"cat /proc/self/cgroup; stat -f -c %T /sys/fs/cgroup; cat /sys/fs/cgroup/cgroup.controllers 2>&1; [ -w /sys/fs/cgroup ] && echo writable || echo read-only",
	},
	{
		id: "mount-tmpfs",
		question: "Can root mount a size-bounded tmpfs for a per-agent scratch?",
		expect: "observe",
		command:
			'd=$(mktemp -d) && mount -t tmpfs -o size=8m tmpfs "$d" && df -h "$d" | tail -1; umount "$d" 2>/dev/null; rmdir "$d"',
	},
	{
		id: "mount-readonly-bind",
		question: "Can root bind-mount a tree read-only?",
		expect: "observe",
		command:
			's=$(mktemp -d) && d=$(mktemp -d) && mount --bind "$s" "$d" && mount -o remount,bind,ro "$d" && (touch "$d/x" 2>&1 && echo writable || echo read-only); umount "$d" 2>/dev/null; rmdir "$s" "$d"',
	},
]

/** The line each check's result is printed on: `<sentinel> <id> <exit> <base64 output>`. */
export const PROBE_SENTINEL = "MAPLE_EXECUTOR_PROBE"

/** Output kept per check: enough to read, small enough for one log line per probe. */
export const PROBE_OUTPUT_BYTES = 1500

/** Seconds one check may run before `timeout` kills it, as a hung connect would. */
const CHECK_SECONDS = 20

/** One shell program that runs every check in turn, each in its own bounded `bash -c`. */
export const probeScript = (checks: ReadonlyArray<ProbeCheck> = PROBE_CHECKS): string =>
	checks
		.map(
			(check) =>
				`out=$(timeout --kill-after=2 ${CHECK_SECONDS} bash -c ${shellQuote(check.command)} 2>&1); rc=$?; printf '${PROBE_SENTINEL} %s %s %s\\n' ${shellQuote(check.id)} "$rc" "$(printf %s "$out" | head -c ${PROBE_OUTPUT_BYTES} | base64 | tr -d "\\n")"`,
		)
		.join("\n")

export interface ProbeResult {
	readonly id: string
	readonly exitCode: number
	readonly output: string
}

/** Every well-formed result line in `stdout`; the last line for an id wins. */
export const parseProbe = (stdout: string): ReadonlyArray<ProbeResult> => {
	const results = new Map<string, ProbeResult>()
	for (const line of stdout.split("\n")) {
		const [sentinel, id, exit, encoded = ""] = line.trim().split(" ")
		if (sentinel !== PROBE_SENTINEL || id === undefined || exit === undefined) continue
		const exitCode = Number(exit)
		if (!Number.isInteger(exitCode)) continue
		results.set(id, { id, exitCode, output: Buffer.from(encoded, "base64").toString("utf8") })
	}
	return [...results.values()]
}

/** `missing`: the check printed no result, so the script died before it. */
export type ProbeVerdict = "pass" | "fail" | "observed" | "missing"

export interface AssessedCheck {
	readonly id: string
	readonly question: string
	readonly expect: ProbeExpectation
	readonly verdict: ProbeVerdict
	readonly exitCode?: number
	readonly output?: string
}

const verdictOf = (check: ProbeCheck, result: ProbeResult): ProbeVerdict => {
	if (check.expect === "observe") return "observed"
	const exitAsExpected = (result.exitCode === 0) === (check.expect === "succeeds")
	const outputAsExpected =
		check.contains === undefined || check.contains.some((text) => result.output.includes(text))
	return exitAsExpected && outputAsExpected ? "pass" : "fail"
}

/** Each check against what it expected. */
export const assessProbe = (
	results: ReadonlyArray<ProbeResult>,
	checks: ReadonlyArray<ProbeCheck> = PROBE_CHECKS,
): ReadonlyArray<AssessedCheck> =>
	checks.map((check) => {
		const result = results.find((r) => r.id === check.id)
		const base = { id: check.id, question: check.question, expect: check.expect }
		return result === undefined
			? { ...base, verdict: "missing" }
			: { ...base, verdict: verdictOf(check, result), exitCode: result.exitCode, output: result.output }
	})
