// Real compiled-binary coverage: no mocked eventing runtime or native storage.
import { deepStrictEqual, match, notStrictEqual, ok, strictEqual } from "node:assert"
import { closeSync, openSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const bundle = resolve(process.argv[2] ?? "dist")
const root = mkdtempSync(join(tmpdir(), "maple-native-projectors-"))
const data = join(root, "data")
const modulePath = join(root, "external projector #1.mjs")
copyFileSync(resolve(import.meta.dir, "fixtures/projector-module.mjs"), modulePath)
const secondModulePath = join(root, "second.mjs")
writeFileSync(secondModulePath, "export default { apiVersion: 1, register() {} }")
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
const healthy = async () => {
	for (let i = 0; i < 200; i++) {
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
	const first = await request("/local/eventing/outbox")
	strictEqual(first.events.length, 1)
	deepStrictEqual(first.events[0].event.data, { label: "external projector", occurrenceId: "delivery-42" })
	await stop()
	await exit(foreground)

	// The parent must forward the path intact, including spaces and the # character.
	detached = true
	strictEqual(await exit(spawn("background", [...args, "--background", ...moduleArgs])), 0)
	await healthy()
	const active = await request("/local/eventing/projections")
	strictEqual(active.length, 1)
	await request("/v1/logs", ingest)
	const restarted = await request("/local/eventing/outbox")
	strictEqual(restarted.events.length, 1)
	strictEqual(restarted.events[0].event.id, first.events[0].event.id)
	await stop()
	detached = false

	const missing = spawn("missing-module", args)
	notStrictEqual(await exit(missing), 0)
	match(readFileSync(join(root, "missing-module.log"), "utf8"), /unregistered projector/)
	console.log(
		"PASS: compiled external projector, saved projection, detached restart, stable event identity and missing-module refusal",
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
