/**
 * The scenario list, checked without an engine or a model: the world is the same on every run,
 * every question has a real answer, and every golden call names a live tool and its parameters.
 */
import { Schema, Array as Arr, Record as Rec } from "effect"
import { describe, expect, it } from "vitest"
import { inputSchemaOf, mapleToolCatalogFor } from "../../mcp/tools/registry"
import { productScenarios } from "./scenarios"
import { makeWorld, mondayOf, WEEK_MS, WORLD_WEEKS } from "./world"

const NOW = Date.UTC(2026, 10, 22, 13, 30)
const world = makeWorld(NOW)
const scenarios = productScenarios(world)

const catalog = new Map(Arr.map(mapleToolCatalogFor("chat"), (entry) => [entry.name, entry]))
const isProperties = Schema.is(Schema.Record(Schema.String, Schema.Unknown))

describe("the Acme world", () => {
	it("is eight whole weeks ending at the last UTC Monday", () => {
		expect(world.endMs).toBe(Date.UTC(2026, 10, 16))
		expect(world.endMs).toBe(mondayOf(NOW))
		expect(world.endMs - world.startMs).toBe(WORLD_WEEKS * WEEK_MS)
		expect(Arr.every(world.events, (row) => row.atMs >= world.startMs && row.atMs < world.endMs)).toBe(
			true,
		)
	})

	it("is the same people doing the same things whenever it is built", () => {
		const later = makeWorld(NOW + 3 * WEEK_MS)
		const history = (built: typeof world) =>
			Arr.map(built.events, (row) => [row.atMs - built.startMs, row.eventName, row.userId, row.groupId])
		expect(history(later)).toEqual(history(world))
	})

	it("has the shapes the questions turn on", () => {
		const plans = Arr.filter(world.events, (row) => row.eventName === "plan_started")
		const signups = Arr.filter(world.events, (row) => row.eventName === "signup_completed")
		// The billing webhook knows the account and no user; the sign-up knows the user and no account.
		expect(plans.length).toBeGreaterThan(10)
		expect(Arr.every(plans, (row) => row.userId === "" && row.groupId !== "")).toBe(true)
		expect(Arr.every(signups, (row) => row.userId !== "" && row.groupId === "")).toBe(true)
		// More users than accounts, so counting one for the other is a wrong answer.
		expect(world.users.length).toBeGreaterThan(world.accounts.length * 1.5)
		// Sessions only for the weeks `session_replays` would still hold.
		expect(Arr.every(world.sessions, (row) => row.startMs >= world.endMs - 3 * WEEK_MS)).toBe(true)
	})
})

describe("product scenarios", () => {
	it("have unique ids", () => {
		const ids = Arr.map(scenarios, (scenario) => scenario.id)
		expect(ids.length).toBe(new Set(ids).size)
	})

	it.each(Arr.map(scenarios, (scenario) => [scenario.id, scenario] as const))(
		"%s asks for something the world has",
		(_id, scenario) => {
			expect(scenario.facts.length).toBeGreaterThan(0)
			Arr.forEach(scenario.facts, (fact) => {
				// A zero or an empty name would pass on almost any answer.
				if (fact.kind === "answer-number") expect(fact.value, fact.label).toBeGreaterThan(0)
				if (fact.kind === "answer-duration") expect(fact.ms, fact.label).toBeGreaterThan(0)
				if (fact.kind === "answer-mentions") expect(fact.anyOf).not.toContain("")
			})
		},
	)

	it.each(
		Arr.flatMap(scenarios, (scenario) =>
			Arr.map(
				scenario.golden ?? [],
				(call, index) => [`${scenario.id} call ${index + 1}`, call] as const,
			),
		),
	)("%s names a live tool and its parameters", (_id, call) => {
		const entry = catalog.get(call.tool)
		expect(entry, `unknown tool ${call.tool}`).toBeDefined()
		const properties = entry === undefined ? undefined : inputSchemaOf(entry).properties
		const known = isProperties(properties) ? Rec.keys(properties) : []
		Arr.forEach(Rec.keys(call.args), (key) =>
			expect(known, `${call.tool} has no parameter ${key}`).toContain(key),
		)
	})
})
