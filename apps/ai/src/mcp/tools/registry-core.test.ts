import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, Schema } from "effect"
import { executeRegisteredTool, type MapleToolDefinition, type McpToolLookup } from "./registry-core"

const definition = (name: string, next: ReadonlyArray<string>): MapleToolDefinition => ({
	name,
	title: name,
	description: name,
	schema: Schema.Struct({}),
	parseOptions: {},
	outputSchema: Schema.Unknown,
	hints: { readOnly: true },
	aliases: {},
	valueAliases: {},
	audience: "public",
	phrases: [name],
	run: () =>
		Effect.succeed({
			doc: {
				title: `Ran ${name}`,
				blocks: [],
				next: next.map((tool) => ({ tool, args: {}, why: `then ${tool}` })),
			},
			structured: undefined,
		}),
})

// `echo` suggests a loadable tool and one whose module fails to import.
const lookup: McpToolLookup = {
	find: (name) =>
		name === "echo"
			? Effect.succeed(definition("echo", ["healthy", "broken"]))
			: name === "healthy"
				? Effect.succeed(definition("healthy", []))
				: name === "broken"
					? Effect.die(new Error("import failed"))
					: Effect.undefined,
	namesFor: () => ["echo", "healthy", "broken"],
}

// The registry's requirements name every tool's services; these tools reach none of them.
const withoutUnreachedServices = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E> =>
	Effect.provide(effect, Context.makeUnsafe<R>(new Map()))

describe("executeRegisteredTool", () => {
	it.effect("keeps the result and drops a suggested call whose tool fails to load", () =>
		Effect.gen(function* () {
			const result = yield* executeRegisteredTool(lookup, "echo", {}, "mcp").pipe(
				withoutUnreachedServices,
			)
			const text = result.content.map((block) => block.text).join("\n")
			expect(text).toContain("Ran echo")
			expect(text).toContain("healthy")
			expect(text).not.toContain("broken")
		}),
	)

	it.effect("refuses a newly registered read tool where nobody is named, until it is listed", () =>
		Effect.gen(function* () {
			// `echo` is public and read-only, which is everything a new tool declares about itself.
			const refused = yield* executeRegisteredTool(lookup, "echo", {}, "bot_anonymous").pipe(
				withoutUnreachedServices,
				Effect.flip,
			)
			expect(refused._tag).toBe("@maple/mcp/ToolNotFoundError")

			// The same registration runs for a named asker and on the public transport.
			const results = yield* Effect.forEach(["bot", "mcp"] as const, (surface) =>
				executeRegisteredTool(lookup, "echo", {}, surface).pipe(withoutUnreachedServices),
			)
			expect(results.map((result) => result.content[0]?.text.includes("Ran echo"))).toEqual([
				true,
				true,
			])
		}),
	)

	it.effect("drops a suggested call to a tool the surface does not list", () =>
		Effect.gen(function* () {
			// `list_services` is listed for an unnamed asker; the tools it points at are not.
			const listed: McpToolLookup = {
				find: (name) =>
					name === "list_services"
						? Effect.succeed(definition("list_services", ["healthy"]))
						: lookup.find(name),
				namesFor: lookup.namesFor,
			}
			const text = (surface: "bot" | "bot_anonymous") =>
				executeRegisteredTool(listed, "list_services", {}, surface).pipe(
					withoutUnreachedServices,
					Effect.map((result) => result.content.map((block) => block.text).join("\n")),
				)
			expect(yield* text("bot")).toContain("healthy")
			expect(yield* text("bot_anonymous")).not.toContain("healthy")
		}),
	)
})
