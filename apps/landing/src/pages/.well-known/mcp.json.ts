/**
 * `/.well-known/mcp.json` — the MCP registry `server.json` for Maple's hosted
 * MCP server, published on the website next to `llms.txt` and `openapi.json`.
 * The API serves the identical document at `api.maple.dev/.well-known/mcp.json`.
 */
import { mapleMcpServerManifest } from "@maple/domain/mcp-manifest"
import type { APIRoute } from "astro"
import { Schema } from "effect"
import { API_ORIGIN } from "../../lib/agent-resources"

const encodePrettyJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown, { space: 2 }))

export const GET: APIRoute = ({ site }) =>
	new Response(
		`${encodePrettyJson(mapleMcpServerManifest({ apiBaseUrl: API_ORIGIN, siteUrl: site?.toString() }))}\n`,
		{ headers: { "Content-Type": "application/json; charset=utf-8" } },
	)
