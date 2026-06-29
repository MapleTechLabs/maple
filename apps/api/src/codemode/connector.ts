/**
 * `MapleConnector` — the Cloudflare Code Mode connector that exposes Maple's MCP
 * tools to the sandbox as a typed `maple.*` API.
 *
 * Code Mode ([@cloudflare/codemode]) gives the model ONE `code` tool plus
 * `codemode.search()/describe()` for progressive discovery; the tools it can call
 * come from a `CodemodeConnector`. We extend the base connector directly (not the
 * `McpConnector` subclass) so we don't pull in the optional `@modelcontextprotocol/sdk`
 * peer — the tool list, schemas, and approval flags come from the pure
 * {@link buildMapleCodeModeCatalog} instead, and execution is delegated to an
 * injected {@link MapleToolDispatch}.
 *
 * Workers-only: `CodemodeConnector` extends `WorkerEntrypoint` (imports
 * `cloudflare:workers`), so this module must never be pulled into Node/test code —
 * the pure catalog it reads from is the testable half.
 */
import { CodemodeConnector, type ConnectorTool, type ConnectorTools } from "@cloudflare/codemode"
import { buildMapleCodeModeCatalog } from "./catalog"
import type { MapleToolDispatch } from "./dispatch"

export class MapleConnector extends CodemodeConnector {
	readonly #dispatch: MapleToolDispatch

	constructor(ctx: DurableObjectState | ExecutionContext, env: unknown, dispatch: MapleToolDispatch) {
		super(ctx, env)
		this.#dispatch = dispatch
	}

	name(): string {
		return "maple"
	}

	protected instructions(): string | undefined {
		return (
			"Maple observability tools for the current organization. Read tools return " +
			"human-readable text followed by a `Structured content:` JSON block — parse the " +
			"JSON to filter and correlate across calls. Tools that mutate state pause for user " +
			"approval before running."
		)
	}

	protected tools(): ConnectorTools {
		const tools: Record<string, ConnectorTool> = {}
		for (const descriptor of buildMapleCodeModeCatalog()) {
			tools[descriptor.name] = {
				description: descriptor.description,
				// `inputSchema` is JSONSchema7; our catalog produces a compatible JSON Schema object.
				inputSchema: descriptor.inputSchema as ConnectorTool["inputSchema"],
				requiresApproval: descriptor.requiresApproval,
				execute: (args) => this.#dispatch(descriptor.name, args),
			}
		}
		return tools
	}
}
