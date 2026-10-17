import { spawn, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"
import { DATASET_HEADER } from "../contract.ts"

/**
 * The backend needs `bun:ffi` for chDB, so suites run it as a Bun child process on random
 * ports, the way a developer does, and talk to it over HTTP.
 */
export const spawnBackend = async () => {
	const base = 20_000 + Math.floor(Math.random() * 20_000)
	const main = fileURLToPath(new URL("./main.ts", import.meta.url))
	const child: ChildProcess = spawn("bun", ["run", main], { env: { ...process.env, PARITY_PORT_BASE: String(base) } })
	await new Promise<void>((resolve, reject) => {
		const output: Array<string> = []
		child.stdout?.on("data", (chunk: Buffer) => {
			output.push(chunk.toString())
			if (output.join("").includes("ready")) resolve()
		})
		child.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()))
		child.on("exit", (code) => reject(new Error(`backend exited with ${code}: ${output.join("")}`)))
	})
	const api = `http://localhost:${base}`
	const tokens = new Map<string, string>()
	const tokenFor = async (dataset: string) => {
		const known = tokens.get(dataset)
		if (known !== undefined) return known
		const response = await fetch(`${api}/api/auth/login`, {
			method: "POST",
			headers: { "content-type": "application/json", [DATASET_HEADER]: dataset },
			body: JSON.stringify({ password: "parity" }),
		})
		const body: { readonly token: string } = await response.json()
		tokens.set(dataset, body.token)
		return body.token
	}
	/** One request as `dataset`; a body makes it a JSON POST. */
	const request = async (dataset: string, path: string, body?: unknown) => {
		const response = await fetch(`${api}${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${await tokenFor(dataset)}`,
				[DATASET_HEADER]: dataset,
			},
			...(body === undefined ? undefined : { body: JSON.stringify(body) }),
		})
		return { status: response.status, text: await response.text() }
	}
	return { request, stop: () => child.kill("SIGTERM") }
}
