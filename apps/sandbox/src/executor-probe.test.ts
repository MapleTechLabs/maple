import { spawn, spawnSync } from "node:child_process"
import { createSocket } from "node:dgram"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { type Server, type Socket, createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer as createTlsServer } from "node:tls"
import { assert, describe, it } from "@effect/vitest"
import {
	type AssessedCheck,
	BLOCKED,
	LEAKED,
	PROBE_OUTPUT_BYTES,
	PROBE_SENTINEL,
	type ProbeCheck,
	assessProbe,
	parseProbe,
	probeScript,
	rawHttpLeak,
	tlsLeak,
	udpDnsLeak,
	unexpectedChecks,
} from "./executor-probe"

const line = (id: string, exitCode: number, output: string) =>
	`${PROBE_SENTINEL} ${id} ${exitCode} ${Buffer.from(output).toString("base64")}`

const CHECKS: ReadonlyArray<ProbeCheck> = [
	{ id: "egress", question: "blocked?", expect: "fails", command: "exit 7" },
	{ id: "gateway", question: "reached?", expect: "succeeds", contains: ["marker"], command: "echo marker" },
	{ id: "kernel", question: "which?", expect: "observe", command: "uname -s" },
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
			contains: ["started"],
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
			{ id: "kernel", exitCode: 0, output: "Linux" },
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

const runAsync = (command: string, env: Record<string, string> = {}) =>
	new Promise<{ readonly exitCode: number | null; readonly output: string }>((resolve) => {
		const child = spawn("bash", ["-c", command], { env: { ...process.env, ...env } })
		let output = ""
		child.stdout.on("data", (chunk) => (output += chunk))
		child.stderr.on("data", (chunk) => (output += chunk))
		child.on("close", (exitCode) => resolve({ exitCode, output: output.trim() }))
	})

/** The port a server listening on TCP was given. */
const portOf = (server: Server) => {
	const address = server.address()
	assert.isTrue(typeof address === "object" && address !== null, "the server is listening on TCP")
	return typeof address === "object" && address !== null ? address.port : 0
}

/** A local TCP server playing whatever the far end, or the runtime's proxy in front of it, does. */
const tcpServer = async (onConnection: (socket: Socket) => void) => {
	const sockets = new Set<Socket>()
	const server = createServer((socket) => {
		sockets.add(socket)
		onConnection(socket)
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const port = portOf(server)
	const close = () =>
		new Promise<void>((resolve) => {
			for (const socket of sockets) socket.destroy()
			server.close(() => resolve())
		})
	return { port, [Symbol.asyncDispose]: close }
}

const MARKER = "https://far.end/maple-executor-probe"
const httpTo = (port: number) =>
	rawHttpLeak({ host: "127.0.0.1", port, path: "/maple-executor-probe", marker: MARKER, timeoutMs: 400 })

describe("rawHttpLeak against a runtime that may accept every connection", () => {
	it("reports a leak when the far end's own answer comes back", async () => {
		await using server = await tcpServer((socket) =>
			socket.once("data", () => socket.end(`HTTP/1.1 301 Moved\r\nLocation: ${MARKER}\r\n\r\n`)),
		)
		const result = await runAsync(httpTo(server.port))
		assert.strictEqual(result.exitCode, 0)
		assert.isTrue(result.output.startsWith(`${LEAKED} HTTP/1.1 301`))
	})

	it("reports blocked, with why, for each way a proxy can answer instead", async () => {
		await using closes = await tcpServer((socket) => socket.end())
		await using hangs = await tcpServer(() => {})
		await using errorPage = await tcpServer((socket) =>
			socket.once("data", () => socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\negress is disabled")),
		)
		await using refused = await tcpServer(() => {})
		const refusedPort = refused.port
		await refused[Symbol.asyncDispose]()

		const results = await Promise.all(
			[closes.port, hangs.port, errorPage.port, refusedPort].map((port) => runAsync(httpTo(port))),
		)
		assert.deepStrictEqual(
			results.map((result) => [result.exitCode, result.output]),
			[
				[1, `${BLOCKED} connected, closed without answering`],
				[1, `${BLOCKED} connected, no answer before timeout`],
				[1, `${BLOCKED} answered without the marker: HTTP/1.1 502 Bad Gateway egress is disabled`],
				[1, `${BLOCKED} ECONNREFUSED`],
			],
		)
	})
})

const hasOpenssl = spawnSync("openssl", ["version"]).status === 0

describe.skipIf(!hasOpenssl)("tlsLeak", () => {
	/** A certificate for `leak.test`, trusted only where NODE_EXTRA_CA_CERTS names it. */
	const certificate = () => {
		const dir = mkdtempSync(join(tmpdir(), "executor-probe-tls-"))
		spawnSync("openssl", [
			"req",
			"-x509",
			"-newkey",
			"ec",
			"-pkeyopt",
			"ec_paramgen_curve:prime256v1",
			"-nodes",
			"-keyout",
			join(dir, "key.pem"),
			"-out",
			join(dir, "cert.pem"),
			"-days",
			"1",
			"-subj",
			"/CN=leak.test",
			"-addext",
			"subjectAltName=DNS:leak.test",
		])
		return { dir, cert: join(dir, "cert.pem"), key: readFileSync(join(dir, "key.pem")) }
	}

	it("reports a leak only for a handshake against a trusted certificate for the name", async () => {
		const { dir, cert, key } = certificate()
		const server = createTlsServer({ cert: readFileSync(cert), key }, (socket) => socket.end())
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
		const port = portOf(server)
		const check = (servername: string) =>
			tlsLeak({ host: "127.0.0.1", port, servername, timeoutMs: 2000 })

		const trusted = await runAsync(check("leak.test"), { NODE_EXTRA_CA_CERTS: cert })
		// What v1 saw from the runtime's own HTTPS interception: a certificate the container does not trust.
		const untrusted = await runAsync(check("leak.test"))
		const otherName = await runAsync(check("other.test"), { NODE_EXTRA_CA_CERTS: cert })
		server.close()
		rmSync(dir, { recursive: true, force: true })

		assert.deepStrictEqual(
			[trusted, untrusted, otherName].map((result) => result.exitCode),
			[0, 1, 1],
		)
		assert.strictEqual(trusted.output, `${LEAKED} handshake with a trusted certificate for leak.test`)
		assert.isTrue(untrusted.output.startsWith(`${BLOCKED} `))
		assert.strictEqual(otherName.output, `${BLOCKED} ERR_TLS_CERT_ALTNAME_INVALID`)
	})

	it("reports blocked when the connection is accepted and dropped", async () => {
		await using closes = await tcpServer((socket) => socket.end())
		const result = await runAsync(
			tlsLeak({ host: "127.0.0.1", port: closes.port, servername: "leak.test", timeoutMs: 2000 }),
		)
		assert.strictEqual(result.exitCode, 1)
		assert.isTrue(result.output.startsWith(BLOCKED))
	})
})

describe("udpDnsLeak", () => {
	/** A resolver that answers each query with `answers` A records for 1.1.1.1, or never answers. */
	const resolver = async (answers: number | "silent") => {
		const socket = createSocket("udp4")
		socket.on("message", (query, peer) => {
			if (answers === "silent") return
			const header = Buffer.from(query.subarray(0, 12))
			header.writeUInt16BE(answers > 0 ? 0x8180 : 0x8183, 2)
			header.writeUInt16BE(answers, 6)
			const record = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 1, 1, 1, 1])
			const reply = Buffer.concat([
				header,
				query.subarray(12),
				...Array.from({ length: answers }, () => record),
			])
			socket.send(reply, peer.port, peer.address)
		})
		await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve))
		return { port: socket.address().port, close: () => socket.close() }
	}

	it("reports a leak for an answer with records, blocked for no answer or an empty reply", async () => {
		const servers = await Promise.all([resolver(2), resolver("silent"), resolver(0)])
		const results = await Promise.all(
			servers.map((server) =>
				runAsync(
					udpDnsLeak({
						host: "127.0.0.1",
						port: server.port,
						name: "one.one.one.one",
						timeoutMs: 400,
					}),
				),
			),
		)
		for (const server of servers) server.close()
		assert.deepStrictEqual(
			results.map((result) => [result.exitCode, result.output]),
			[
				[0, `${LEAKED} dns answer with 2 records`],
				[1, `${BLOCKED} no answer before timeout`],
				[1, `${BLOCKED} dns reply without records, rcode 3`],
			],
		)
	})
})

describe("unexpectedChecks", () => {
	const check = (id: string, verdict: AssessedCheck["verdict"], exitCode?: number): AssessedCheck => {
		const unanswered: AssessedCheck = { id, question: "", expect: "fails", verdict }
		return exitCode === undefined ? unanswered : { ...unanswered, exitCode }
	}

	it("flags failed and missing checks, but not observed or unanswerable ones", () => {
		const flagged = unexpectedChecks(
			[
				check("a", "pass", 1),
				check("b", "fail", 0),
				check("c", "missing"),
				check("d", "observed", 0),
				check("gw", "fail", 1),
			],
			{ unanswerable: new Set(["gw"]) },
		)
		assert.deepStrictEqual(
			flagged.map((c) => c.id),
			["b", "c"],
		)
	})

	it("in the positive control, flags a leak check unless it caught the leak", () => {
		const flagged = unexpectedChecks(
			[
				check("caught", "fail", 0),
				check("blocked-anyway", "pass", 1),
				// Failed for another reason, such as a missing binary: it saw no leak.
				check("broken", "fail", 127),
				check("silent", "missing"),
			],
			{ leaks: new Set(["caught", "blocked-anyway", "broken", "silent"]) },
		)
		assert.deepStrictEqual(
			flagged.map((c) => c.id),
			["blocked-anyway", "broken", "silent"],
		)
	})
})
