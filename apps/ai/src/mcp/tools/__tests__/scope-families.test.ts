/**
 * Tools whose data sits outside the families every MCP key must already read ask for that family's
 * scope, as the matching `/v2/<family>` routes do.
 */
import { describe, expect, it } from "vitest"
import { OrgId, RoleName, UserId } from "@maple/domain/http"
import { INVESTIGATION_READ_FAMILIES } from "@maple/domain/http/v2"
import { Context, Effect, Layer, Schema, Array as Arr } from "effect"
import { CurrentMcpTenant } from "../../tenant"
import { executeRegisteredMcpToolUnscoped } from "../registry"

const tenantWith = (scopes: ReadonlyArray<string>) =>
	Layer.succeed(CurrentMcpTenant, {
		orgId: Schema.decodeSync(OrgId)("org_scope_families"),
		userId: Schema.decodeSync(UserId)("user_scope_families"),
		roles: [Schema.decodeSync(RoleName)("org:admin")],
		authMode: "self_hosted",
		scopes,
	})

// A refused call stops at the registry, so none of the tools' services is ever reached.
const withoutUnreachedServices = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E> =>
	Effect.provide(effect, Context.makeUnsafe<R>(new Map()))

const call = (name: string, scopes: ReadonlyArray<string>) =>
	Effect.runPromise(
		executeRegisteredMcpToolUnscoped(name, {}, "mcp").pipe(
			Effect.provide(tenantWith(scopes)),
			Effect.result,
			withoutUnreachedServices,
		),
	)

/** A key that reads and writes every family the MCP server requires, and nothing beyond them. */
const BASELINE = Arr.map(INVESTIGATION_READ_FAMILIES, (family) => `${family}:write`)

const REQUIRED = [
	["list_slos", "slos:read"],
	["create_slo", "slos:write"],
	["list_uptime_monitors", "uptime_monitors:read"],
	["delete_uptime_monitor", "uptime_monitors:write"],
	["list_ingest_rules", "ingest_rules:read"],
	["create_ingest_rule", "ingest_rules:write"],
	["list_data_sources", "data_sources:read"],
	["search_data_sources", "data_sources:read"],
	["describe_data_source", "data_sources:read"],
	["query_data_source", "data_sources:read"],
	["get_status_page", "status_pages:read"],
	["apply_status_page_config", "status_pages:write"],
	["post_status_page_update", "status_page_incidents:write"],
	["create_scrape_target", "scrape_targets:write"],
] as const

describe("MCP tools outside the baseline scope families", () => {
	it("refuse a scoped key that lacks their family, naming the scope to add", async () => {
		const results = await Promise.all(
			Arr.map(REQUIRED, async ([name, scope]) => ({ name, scope, result: await call(name, BASELINE) })),
		)
		Arr.forEach(results, ({ name, scope, result }) => {
			expect(result._tag, name).toBe("Failure")
			if (result._tag === "Failure") {
				expect(result.failure).toMatchObject({
					_tag: "@maple/mcp/errors/McpAuthInvalidError",
					reason: "insufficient_scope",
				})
				expect(result.failure.message).toContain(`\`${scope}\``)
			}
		})
	})

	it("ask for every family a tool reads", async () => {
		const result = await call("get_status_page", [...BASELINE, "status_pages:read"])
		expect(result._tag).toBe("Failure")
		if (result._tag === "Failure") {
			expect(result.failure.message).toContain("`status_page_incidents:read`")
		}
	})

	it("refuse a read scope on a tool that changes data", async () => {
		const result = await call("create_slo", [...BASELINE, "slos:read"])
		expect(result._tag).toBe("Failure")
		if (result._tag === "Failure") expect(result.failure.message).toContain("`slos:write`")
	})
})
