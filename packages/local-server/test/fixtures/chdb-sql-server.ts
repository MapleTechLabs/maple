// A chDB store with the local schema behind a two-route HTTP server, as its own process. A suite
// that runs under node (vitest) cannot load libchdb, so it spawns this and sends SQL:
//
//   POST /exec    the body is one statement, run for its effect       -> 204
//   POST /query   the body is one SELECT, answered as JSONEachRow     -> 200
//
// A statement the engine rejects answers 400 with the engine's message. The store is at argv[2];
// the port is printed on a `CHDB ` line once the schema is in.
import { Result } from "effect"
import schemaSql from "../../src/schema/local-schema.sql" with { type: "text" }
import { Chdb } from "../../src/chdb"

const [dataDir = ""] = process.argv.slice(2)
const db = Chdb.open({ dataDir, schemaSql })

const run = (sql: string, statement: (sql: string) => string): Response =>
	Result.match(Result.try({ try: () => statement(sql), catch: (cause) => String(cause) }), {
		onFailure: (message) => new Response(message, { status: 400 }),
		onSuccess: (body) => new Response(body, { status: body === "" ? 204 : 200 }),
	})

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: async (request) => {
		const { pathname } = new URL(request.url)
		const sql = await request.text()
		if (pathname === "/query") return run(sql, (text) => db.query(text))
		if (pathname === "/exec")
			return run(sql, (text) => {
				db.exec(text)
				return ""
			})
		return new Response("not found", { status: 404 })
	},
})
process.stdout.write(`CHDB ${JSON.stringify({ port: server.port })}\n`)

const stop = () => {
	void server.stop(true).then(() => {
		db.close()
		process.exit(0)
	})
}
process.once("SIGTERM", stop)
process.once("SIGINT", stop)
