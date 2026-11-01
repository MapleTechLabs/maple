// Real compiled-binary coverage: no mocked eventing runtime or native storage.
import { deepStrictEqual, match, notStrictEqual, ok, strictEqual } from "node:assert"
import {
	closeSync,
	openSync,
	copyFileSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
	existsSync,
	lstatSync,
	readdirSync,
	readlinkSync,
} from "node:fs"
import { createHash } from "node:crypto"
import { serverPidPath, storeMarkerPath, storeOpenMarkerPath } from "@maple/local-server/store-version"
import { tmpdir } from "node:os"
import { Schema } from "effect"
import { join, resolve } from "node:path"

const bundle = resolve(process.argv[2] ?? "dist")
const root = mkdtempSync(join(tmpdir(), "maple-native-projectors-"))
const data = join(root, "data")
const modulePath = join(root, "external projector #1.mjs")
copyFileSync(resolve(import.meta.dir, "fixtures/projector-module.mjs"), modulePath)
const secondModulePath = join(root, "second.mjs")
const registrations = join(root, "registrations.txt")
writeFileSync(
	secondModulePath,
	`import { strictEqual } from "node:assert";
import { readFileSync, appendFileSync } from "node:fs";
export default { apiVersion: 1, register() {
 strictEqual(readFileSync(${JSON.stringify(serverPidPath(data))}, "utf8"), String(process.pid));
 appendFileSync(${JSON.stringify(registrations)}, String(process.pid) + "\\n");
} }`,
)
const storeDigest = (path: string): string => {
	const info = lstatSync(path)
	if (info.isSymbolicLink()) return `link:${readlinkSync(path)}`
	if (info.isDirectory())
		return createHash("sha256")
			.update(
				JSON.stringify(
					readdirSync(path)
						.sort()
						.map((name) => [name, storeDigest(join(path, name))]),
				),
			)
			.digest("hex")
	return createHash("sha256").update(readFileSync(path)).digest("hex")
}
const moduleArgs = ["--projector-module", modulePath, "--projector-module", secondModulePath]
const port = Number(process.argv[3] ?? 45239)
const url = `http://127.0.0.1:${port}`
const env = { ...process.env, MAPLE_TELEMETRY: "off" }
const args = [
	"start",
	"--host",
	"127.0.0.1",
	"--port",
	String(port),
	"--data-dir",
	data,
	"--offline",
	"--checkpoint-interval",
	"off",
	"--on-dirty-store",
	"fail",
]
const children: ReturnType<typeof Bun.spawn>[] = []
const spawn = (name: string, command: string[]) => {
	const log = openSync(join(root, `${name}.log`), "w")
	const child = Bun.spawn([join(bundle, "maple"), ...command], {
		env,
		stdout: log,
		stderr: log,
	})
	closeSync(log)
	children.push(child)
	return child
}
const exit = async (child: ReturnType<typeof spawn>) => {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		const code = await Promise.race([
			child.exited,
			new Promise<null>((resolve) => {
				timer = setTimeout(() => resolve(null), 30_000)
			}),
		])
		if (code === null) child.kill("SIGKILL")
		ok(code !== null, "child did not exit in 30s")
		return code
	} finally {
		clearTimeout(timer)
	}
}
// CI boots six native probes on one runner at once, so a cold chDB start can take well over 20s.
const healthy = async () => {
	const deadline = Date.now() + 60_000
	while (Date.now() < deadline) {
		const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) }).catch(() => null)
		if (response?.ok) return
		await Bun.sleep(100)
	}
	ok(false, `server did not become healthy; inspect ${root}`)
}
const request = async (path: string, body?: unknown) => {
	const response = await fetch(`${url}${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: {
			"content-type": "application/json",
			"x-maple-maintenance-token": readFileSync(`${data}.maintenance-token`, "utf8").trim(),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(10_000),
	})
	ok(response.ok, `${path}: HTTP ${response.status}: ${await response.clone().text()}`)
	return response.json()
}
const outbox = Schema.decodeUnknownSync(
	Schema.Struct({
		events: Schema.Array(
			Schema.Struct({ event: Schema.Struct({ id: Schema.String, data: Schema.Unknown }) }),
		),
	}),
)
const projections = Schema.decodeUnknownSync(Schema.Array(Schema.Unknown))
const projection = {
	id: "example-projection",
	revision: 1,
	enabled: true,
	tenantId: "local",
	sourceKind: "otel.log",
	selector: { op: "exists", field: { namespace: "signal", key: "event.name", type: "string" } },
	projector: { id: "example.record.observed", version: 1, config: {} },
	activeFrom: "2000-01-01T00:00:00Z",
}
const time = String(BigInt(Date.now()) * 1_000_000n)
const ingest = {
	resourceLogs: [
		{
			scopeLogs: [
				{
					logRecords: [
						{
							timeUnixNano: time,
							observedTimeUnixNano: time,
							eventName: "example.record.observed",
							body: { stringValue: "native external projector" },
							attributes: [{ key: "event.id", value: { stringValue: "delivery-42" } }],
						},
					],
				},
			],
		},
	],
}
const stop = async () => strictEqual(await exit(spawn("stop", ["stop", "--data-dir", data])), 0)
let detached = false
try {
	const foreground = spawn("foreground", [...args, ...moduleArgs])
	await healthy()
	await request("/local/eventing/projections", projection)
	await request("/v1/logs", ingest)
	const first = outbox(await request("/local/eventing/outbox"))
	strictEqual(first.events.length, 1)
	deepStrictEqual(first.events[0].event.data, { label: "external projector", occurrenceId: "delivery-42" })
	await stop()
	await exit(foreground)

	// A module error must not consume --reset or --on-dirty-store=wipe.
	// Compare the populated native and control stores, not just a dummy marker.
	const invalidModule = join(root, "invalid.mjs")
	const malformed = [
		"export default { apiVersion: 2, register() {} }",
		'throw new Error("import failure")',
		'export default { apiVersion: 1, register(add) { add({ id: "broken" }) } }',
	]
	for (const background of [false, true]) {
		for (const [index, source] of malformed.entries()) {
			writeFileSync(invalidModule, source)
			const before = storeDigest(data)
			const marker = readFileSync(storeMarkerPath(data), "utf8")
			const name = `invalid-reset-${background}-${index}`
			notStrictEqual(
				await exit(
					spawn(name, [
						...args,
						"--reset",
						...(background ? ["--background"] : []),
						"--projector-module",
						invalidModule,
					]),
				),
				0,
			)
			match(readFileSync(join(root, `${name}.log`), "utf8"), /projector module/)
			strictEqual(storeDigest(data), before, `${name} changed the live store`)
			strictEqual(readFileSync(storeMarkerPath(data), "utf8"), marker)
			strictEqual(existsSync(serverPidPath(data)), false)
		}
		writeFileSync(storeOpenMarkerPath(data), "simulated unclean shutdown\n")
		const before = storeDigest(data)
		const wipeArgs = args.map((value) => (value === "fail" ? "wipe" : value))
		notStrictEqual(
			await exit(
				spawn(`invalid-wipe-${background}`, [
					...wipeArgs,
					...(background ? ["--background"] : []),
					"--projector-module",
					invalidModule,
				]),
			),
			0,
		)
		strictEqual(storeDigest(data), before, "invalid module changed the dirty store")
		strictEqual(readFileSync(storeOpenMarkerPath(data), "utf8"), "simulated unclean shutdown\n")
		rmSync(storeOpenMarkerPath(data))
	}

	// The parent must forward the path intact, including spaces and the # character.
	detached = true
	strictEqual(await exit(spawn("background", [...args, "--background", ...moduleArgs])), 0)
	await healthy()
	const active = projections(await request("/local/eventing/projections"))
	strictEqual(active.length, 1)
	await request("/v1/logs", ingest)
	const restarted = outbox(await request("/local/eventing/outbox"))
	strictEqual(restarted.events.length, 1)
	strictEqual(restarted.events[0].event.id, first.events[0].event.id)
	await stop()
	detached = false

	// Exactly one registration per serving process, always under its PID claim.
	const owners = readFileSync(registrations, "utf8").trim().split("\n")
	strictEqual(owners.length, 2)
	strictEqual(new Set(owners).size, 2)

	const missing = spawn("missing-module", args)
	notStrictEqual(await exit(missing), 0)
	match(readFileSync(join(root, "missing-module.log"), "utf8"), /unregistered projector/)
	// A valid detached reset still reaches the child and clears the live state.
	detached = true
	strictEqual(await exit(spawn("valid-reset", [...args, "--background", "--reset", ...moduleArgs])), 0)
	await healthy()
	deepStrictEqual(await request("/local/eventing/projections"), [])
	strictEqual(outbox(await request("/local/eventing/outbox")).events.length, 0)
	await stop()
	detached = false
	console.log(
		"PASS: compiled external projector, saved projection, detached restart, stable event identity, missing-module refusal and reset/wipe preservation",
	)
} finally {
	if (detached) await stop()
	for (const child of children) {
		if (child.exitCode === null) {
			child.kill("SIGTERM")
			await exit(child)
		}
	}
	if (process.env.KEEP_ROOT === "1") console.log(`preserved native test root: ${root}`)
	else rmSync(root, { recursive: true, force: true })
}
