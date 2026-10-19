import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

// `serve.ts` reads Bun's `import.meta.dir` at load, so the call runs in a Bun child.
const serveModule = fileURLToPath(new URL("./serve.ts", import.meta.url))
const resolveInBun = (pathname: string) => {
	const script = `
import { resolveStatic } from ${JSON.stringify(serveModule)}
const build = { name: "test", authMode: "self_hosted", dir: "/nonexistent", indexHtml: "<head></head>",
	stamp: { target: "foldkit", portBase: 0, ref: null, authMode: "self_hosted" } }
process.stdout.write(JSON.stringify(resolveStatic(build, ${JSON.stringify(pathname)})))
`
	const child = spawnSync("bun", ["-e", script], { encoding: "utf8", timeout: 30_000 })
	return { stdout: child.stdout, stderr: child.stderr }
}

describe("resolveStatic", () => {
	it("answers a malformed percent escape as a client route", () => {
		const { stdout, stderr } = resolveInBun("/traces/%E0%A4%A")
		expect(stderr).toBe("")
		expect(JSON.parse(stdout)).toEqual({ kind: "html", body: "<head></head>" })
	})
})
