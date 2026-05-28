import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

// Calls Maple's MCP endpoint (apps/api `/mcp`) the same way apps/chat-agent does:
// internal service token + X-Org-Id header. Lets the standalone assistant agent run
// read-only Maple tools (list_services, find_errors, …) without a Clerk session.
//
// In dev, apps/api must be running (default http://localhost:3472). If
// MAPLE_ORG_ID_OVERRIDE is set on the API, it forces that org and ignores X-Org-Id.

const MAPLE_API_URL = process.env.MAPLE_API_URL ?? "http://localhost:3472"

function serviceAuthHeader(): string {
	const token = process.env.INTERNAL_SERVICE_TOKEN ?? ""
	return `Bearer maple_svc_${token}`
}

// One connected MCP client per org (sessions are stateful; reuse the handshake).
const clients = new Map<string, Promise<Client>>()

function connect(orgId: string): Promise<Client> {
	const existing = clients.get(orgId)
	if (existing) return existing

	const promise = (async () => {
		const transport = new StreamableHTTPClientTransport(new URL(`${MAPLE_API_URL}/mcp`), {
			requestInit: {
				headers: {
					Authorization: serviceAuthHeader(),
					"X-Org-Id": orgId,
				},
			},
		})
		const client = new Client({ name: "maple-electric-assistant", version: "0.0.0" })
		await client.connect(transport)
		return client
	})()

	// Drop the cache entry if the connection fails so the next call retries.
	promise.catch(() => clients.delete(orgId))
	clients.set(orgId, promise)
	return promise
}

/** Call a read-only Maple MCP tool and return its text content. */
export async function callMapleMcp(
	orgId: string,
	toolName: string,
	args: Record<string, unknown>,
): Promise<string> {
	const client = await connect(orgId)
	const result = (await client.callTool({ name: toolName, arguments: args })) as {
		content?: Array<{ type: string; text?: string }>
		isError?: boolean
	}
	const text = (result.content ?? [])
		.filter((c) => c.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("\n")
	if (result.isError) throw new Error(text || `MCP tool ${toolName} failed`)
	return text || "(no content)"
}
