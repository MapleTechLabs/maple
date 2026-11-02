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

/**
 * Bumped when the checks change, so the next scheduled run probes again. v2: v1 found a TCP
 * connect to a public IP accepted with internet off, so v2 asks whether any bytes come back, and
 * runs the same egress checks inside the network namespace Execute will use.
 */
export const EXECUTOR_PROBE_VERSION = 2

/** A host only the registry gateway answers, over plain HTTP: the `DirectoryBackup` pattern. */
export const GATEWAY_HOST = "registry.maple.internal"
/** The same, intercepted over HTTPS, to learn whether the container trusts the runtime's certificate. */
export const GATEWAY_TLS_HOST = "registry-tls.maple.internal"
/** What every gateway answer carries, so a check can tell it from anything else that replied. */
export const GATEWAY_MARKER = "maple-executor-gateway"

/** The unprivileged identity the hardening checks drop to. */
const NOBODY = "setpriv --reuid=65534 --regid=65534 --clear-groups"

/** Nobody, with no capabilities and no way to regain them: who Execute runs target code as. */
const NOBODY_WITHOUT_CAPS = `${NOBODY} --inh-caps=-all --bounding-set=-all --no-new-privs`

/**
 * Execute's isolation: a fresh network namespace holding only loopback, entered as nobody without
 * capabilities. Whatever the platform's egress does, nothing but loopback exists in here.
 */
export const isolated = (command: string): string =>
	`unshare --net -- sh -c ${shellQuote(`ip link set lo up && exec ${NOBODY_WITHOUT_CAPS} -- bash -c ${shellQuote(command)}`)}`

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

/**
 * What an egress detector prints. `LEAK`, exit 0: the far end itself answered. `blocked:`, exit 1,
 * with why. A connection the runtime accepts and drops, or a page it answers with on the far end's
 * behalf, is `blocked`: only an answer no proxy could forge counts as a leak.
 */
export const LEAKED = "LEAK"
export const BLOCKED = "blocked:"

/** Shared by the detectors' Node programs: report once, then exit. */
const REPORT = `let reported = false; const report = (leak, why) => { if (reported) return; reported = true; console.log((leak ? ${JSON.stringify(LEAKED)} + " " : ${JSON.stringify(BLOCKED)} + " ") + String(why).replace(/\\s+/g, " ").slice(0, 300)); process.exit(leak ? 0 : 1) };`

const node = (program: string) => `node -e ${shellQuote(program)}`

export interface RawHttpTarget {
	readonly host: string
	readonly port: number
	readonly path: string
	/** Text only the real far end's answer holds, such as its redirect echoing `path`. */
	readonly marker: string
	readonly timeoutMs?: number
}

/** A plain HTTP/1.0 request over a raw socket, so an accepted-then-dropped connection shows as such. */
export const rawHttpLeak = ({ host, port, path, marker, timeoutMs = 8000 }: RawHttpTarget): string => {
	const hostHeader = host.includes(":") ? `[${host}]` : host
	return node(
		`${REPORT} let connected = false; let got = "";
const s = require("node:net").connect({ host: ${JSON.stringify(host)}, port: ${port} });
s.setTimeout(${timeoutMs}, () => report(false, got ? "no marker before timeout: " + got : connected ? "connected, no answer before timeout" : "connect timeout"));
s.on("connect", () => { connected = true; s.write(${JSON.stringify(`GET ${path} HTTP/1.0\r\nHost: ${hostHeader}\r\nUser-Agent: maple-executor-probe\r\n\r\n`)}) });
s.on("data", (chunk) => { got += chunk; if (got.includes(${JSON.stringify(marker)})) report(true, got) });
s.on("close", () => report(false, got ? "answered without the marker: " + got : connected ? "connected, closed without answering" : "closed"));
s.on("error", (e) => report(false, e.code ?? e.message));`,
	)
}

export interface TlsTarget {
	readonly host: string
	readonly port: number
	/** The name the certificate must be valid for: a completed handshake no proxy could forge. */
	readonly servername: string
	readonly timeoutMs?: number
}

/** A TLS handshake that only completes against a certificate the container's CAs trust for `servername`. */
export const tlsLeak = ({ host, port, servername, timeoutMs = 8000 }: TlsTarget): string =>
	node(
		`${REPORT}
const s = require("node:tls").connect({ host: ${JSON.stringify(host)}, port: ${port}, servername: ${JSON.stringify(servername)} });
s.setTimeout(${timeoutMs}, () => report(false, "no handshake before timeout"));
s.on("secureConnect", () => report(true, "handshake with a trusted certificate for " + ${JSON.stringify(servername)}));
s.on("close", () => report(false, "closed before the handshake"));
s.on("error", (e) => report(false, e.code ?? e.message));`,
	)

export interface UdpDnsTarget {
	readonly host: string
	readonly port: number
	readonly name: string
	readonly timeoutMs?: number
}

/** A DNS query sent straight to a resolver's IP, past `/etc/resolv.conf`; an answer with records is a leak. */
export const udpDnsLeak = ({ host, port, name, timeoutMs = 8000 }: UdpDnsTarget): string =>
	node(
		`${REPORT}
const id = 0x4d50;
const labels = ${JSON.stringify(name)}.split(".").map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)]));
const query = Buffer.concat([Buffer.from([id >> 8, id & 255, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0]), ...labels, Buffer.from([0, 0, 1, 0, 1])]);
const s = require("node:dgram").createSocket(${JSON.stringify(host.includes(":") ? "udp6" : "udp4")});
setTimeout(() => report(false, "no answer before timeout"), ${timeoutMs});
s.on("message", (m) => { if (m.readUInt16BE(0) !== id || (m[2] & 128) === 0) return; const answers = m.readUInt16BE(6); report(answers > 0, answers > 0 ? "dns answer with " + answers + " records" : "dns reply without records, rcode " + (m[3] & 15)) });
s.on("error", (e) => report(false, e.code ?? e.message));
s.send(query, ${port}, ${JSON.stringify(host)});`,
	)

/** Cloudflare's public resolver: every protocol answers on a known IP, and its certificate proves who answered. */
const PUBLIC_V4 = "1.1.1.1"
const PUBLIC_V6 = "2606:4700:4700::1111"
const PUBLIC_TLS_NAME = "one.one.one.one"
/** Its plain-HTTP answer redirects to HTTPS echoing the path, so a made-up path marks the real answer. */
const LEAK_PATH = "/maple-executor-probe"

const httpLeakTo = (host: string) =>
	rawHttpLeak({
		host,
		port: 80,
		path: LEAK_PATH,
		marker: `https://${host.includes(":") ? `[${host}]` : host}${LEAK_PATH}`,
	})

/** Every egress detector, run in the container's own namespace and again inside {@link isolated}. */
const EGRESS_DETECTORS: ReadonlyArray<{
	readonly id: string
	readonly question: string
	readonly command: string
}> = [
	{
		id: "http-ip",
		question: "plain HTTP to a public IPv4 address answered?",
		command: httpLeakTo(PUBLIC_V4),
	},
	{
		id: "http-ipv6",
		question: "plain HTTP to a public IPv6 address answered?",
		command: httpLeakTo(PUBLIC_V6),
	},
	{
		id: "tls-ip",
		question: "a TLS handshake with a public IP completed against a trusted certificate?",
		command: tlsLeak({ host: PUBLIC_V4, port: 443, servername: PUBLIC_TLS_NAME }),
	},
	{
		id: "udp-dns",
		question: "a DNS query sent straight to a public resolver answered?",
		command: udpDnsLeak({ host: PUBLIC_V4, port: 53, name: PUBLIC_TLS_NAME }),
	},
]

/** The ids of every egress detector check, in the container's namespace and in the isolated one. */
export const EGRESS_CHECK_IDS: ReadonlyArray<string> = EGRESS_DETECTORS.flatMap((d) => [
	`egress-${d.id}`,
	`isolated-egress-${d.id}`,
])

const CGROUP = "/sys/fs/cgroup"
/**
 * cgroup v2 lets a cgroup hand controllers to children only while it holds no processes, so every
 * process moves to a leaf first. The probe's container is thrown away, so moving them costs nothing.
 * Moving a process while reading `cgroup.procs` skips entries, so the list is read whole, three times.
 */
const CGROUP_SETUP = `mkdir -p ${CGROUP}/maple-init || exit 3; for _ in 1 2 3; do for p in $(cat ${CGROUP}/cgroup.procs); do echo "$p" > ${CGROUP}/maple-init/cgroup.procs 2>/dev/null; done; done; echo "+memory +pids" > ${CGROUP}/cgroup.subtree_control || exit 3`
/** Creates the cgroup `name` with `limits` (file, value) and runs `command` in it; each check gets its own. */
const inCgroup = (name: string, limits: ReadonlyArray<readonly [string, string]>, command: string) =>
	[
		CGROUP_SETUP,
		`mkdir -p ${CGROUP}/${name} || exit 3`,
		...limits.map(([file, value]) => `echo ${value} > ${CGROUP}/${name}/${file} || exit 3`),
		`sh -c ${shellQuote(`echo $$ > ${CGROUP}/${name}/cgroup.procs && exec ${command}`)}`,
	].join("; ")

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
		id: "resolv-conf",
		question: "Which resolver does the container's DNS go to?",
		expect: "observe",
		command: "cat /etc/resolv.conf",
	},
	{
		id: "egress-dns",
		question: "Is public DNS unreachable?",
		expect: "fails",
		// getent exits 2 for a name that did not resolve; on Cloudflare (v1) the lookup hangs instead.
		contains: ["not found", "timed out"],
		command:
			"timeout 8 getent hosts registry.npmjs.org; rc=$?; [ $rc -eq 2 ] && echo 'not found'; [ $rc -eq 124 ] && echo 'lookup timed out'; exit $rc",
	},
	{
		id: "egress-tcp-connect",
		question:
			"Is a raw TCP connect to a public IP accepted? (v1: yes; the detectors below ask whether bytes flow)",
		expect: "observe",
		command:
			"timeout 8 bash -c 'exec 3<>/dev/tcp/1.1.1.1/443'; rc=$?; [ $rc -eq 0 ] && echo 'connect accepted'; [ $rc -eq 124 ] && echo 'connect timed out'; exit $rc",
	},
	...EGRESS_DETECTORS.map((detector): ProbeCheck => ({
		id: `egress-${detector.id}`,
		question: `With internet off, is ${detector.question.replace(/\?$/, "")} refused?`,
		expect: "fails",
		contains: [BLOCKED],
		command: detector.command,
	})),
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
		expect: "succeeds",
		command: "unshare -n true",
	},
	{
		id: "isolated-identity",
		question: "Inside Execute's isolation, is the process nobody with no capabilities?",
		expect: "succeeds",
		contains: ["65534 CapEff:\t0000000000000000"],
		command: isolated(`echo "$(id -u) $(grep CapEff /proc/self/status)"`),
	},
	{
		id: "isolated-loopback",
		question: "Inside Execute's isolation, does loopback work?",
		expect: "succeeds",
		contains: ["loopback-ok"],
		command: isolated(LOOPBACK),
	},
	{
		id: "isolated-egress-tcp-connect",
		question: "Inside Execute's isolation, is a TCP connect to a public IP unreachable?",
		expect: "fails",
		contains: ["unreachable"],
		command: isolated("timeout 8 bash -c 'exec 3<>/dev/tcp/1.1.1.1/443'"),
	},
	...EGRESS_DETECTORS.map((detector): ProbeCheck => ({
		id: `isolated-egress-${detector.id}`,
		question: `Inside Execute's isolation, is ${detector.question.replace(/\?$/, "")} refused?`,
		expect: "fails",
		contains: [BLOCKED],
		command: isolated(detector.command),
	})),
	{
		id: "isolated-gateway",
		question: "Inside Execute's isolation, is the registry gateway out of reach too?",
		expect: "fails",
		contains: [BLOCKED],
		command: isolated(
			rawHttpLeak({ host: GATEWAY_HOST, port: 80, path: "/probe", marker: GATEWAY_MARKER }),
		),
	},
	{
		id: "isolated-no-escape",
		question: "Inside Execute's isolation, is entering the container's own network namespace refused?",
		expect: "fails",
		contains: ["Operation not permitted", "Permission denied"],
		command: isolated("nsenter --net=/proc/1/ns/net true"),
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
	{
		id: "scratch-bounded",
		question: "Does nobody's size-bounded tmpfs scratch stop a write past its size?",
		expect: "fails",
		contains: ["No space left on device"],
		command: `d=$(mktemp -d) && mount -t tmpfs -o size=8m,mode=0700,uid=65534,gid=65534 tmpfs "$d" || exit 3; ${NOBODY_WITHOUT_CAPS} -- sh -c 'head -c 16777216 /dev/zero > "$1/fill"' sh "$d"; rc=$?; umount "$d"; rmdir "$d"; exit $rc`,
	},
	{
		id: "cgroup-memory",
		question: "Does a cgroup memory limit kill a process that allocates past it?",
		expect: "fails",
		contains: ["oom killed"],
		// No swap limit: a write to memory.swap.max fails where the kernel has no swap accounting.
		command: `${inCgroup("maple-memory", [["memory.max", "64M"]], node("const held = []; for (;;) held.push(Buffer.alloc(8 << 20, 1))"))}; rc=$?; n=$(awk '$1 == "oom_kill" { print $2 }' ${CGROUP}/maple-memory/memory.events); [ "\${n:-0}" -gt 0 ] && echo "oom killed $n"; exit $rc`,
	},
	{
		id: "cgroup-pids",
		question: "Does a cgroup pids limit stop a fork loop, whatever the uid?",
		expect: "fails",
		contains: ["Cannot fork"],
		command: inCgroup(
			"maple-pids",
			[["pids.max", "8"]],
			`sh -c 'n=0; for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do sleep 3 & n=$((n+1)); done; echo started=$n'`,
		),
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

/** What one local run of the probe expects beyond each check's own expectation. */
export interface RunExpectation {
	/** Checks this run cannot answer, such as the gateway where nothing intercepts. */
	readonly unanswerable?: ReadonlySet<string>
	/**
	 * Checks that must catch a leak: the positive control, run where the network really is open, so
	 * an egress check that cannot see a leak fails the run instead of passing everywhere.
	 */
	readonly leaks?: ReadonlySet<string>
}

/**
 * The checks a run did not answer as expected. A leak counts only when the check exited 0, as each
 * egress check does only when the far end answered; failing for another reason proves nothing.
 */
export const unexpectedChecks = (
	checks: ReadonlyArray<AssessedCheck>,
	{ unanswerable = new Set(), leaks = new Set() }: RunExpectation = {},
): ReadonlyArray<AssessedCheck> =>
	checks.filter((check) => {
		if (unanswerable.has(check.id)) return false
		if (leaks.has(check.id)) return !(check.verdict === "fail" && check.exitCode === 0)
		return check.verdict === "fail" || check.verdict === "missing"
	})
