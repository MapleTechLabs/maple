import { describe, expect, it } from "@effect/vitest"
import { Array as Arr, Effect, String as Str } from "effect"
import { clerkDriver } from "./index"
import { DAY_MS, END_MS, START_MS, SECRET, prepare, request, run } from "./clerk.test-support"
import { makeFakeClerk, seedClerkOrganizations, seedClerkUsers } from "./testing"

const USERS = seedClerkUsers(600, START_MS - 30 * DAY_MS, END_MS)
const inWindow = Arr.filter(USERS, (u) => u.createdAt >= START_MS && u.createdAt < END_MS)

describe("Clerk scans", () => {
	it.effect("filters on a field Clerk cannot filter, after the API narrowed by time", () =>
		Effect.gen(function* () {
			const fake = makeFakeClerk({ secretKey: SECRET, users: USERS })
			const { summary, table } = yield* run(fake, {
				_tag: "resource",
				resource: "users",
				filters: [{ field: "email_domain", op: "eq", value: "acme.dev" }],
				select: ["id", "email_domain", "created_at"],
				orderBy: { field: "created_at", dir: "asc" },
				limit: 1000,
			})
			const expected = Arr.filter(inWindow, (u) => Str.endsWith("@acme.dev")(u.email))
			expect(summary).toMatchObject({ strategy: "scan" })
			expect(Arr.map(table.rows, (r) => r.id)).toEqual(Arr.map(expected, (u) => u.id))
			expect(table.rows[0]).toEqual({
				id: expected[0]?.id,
				email_domain: "acme.dev",
				created_at: new Date(expected[0]?.createdAt ?? 0).toISOString(),
			})
			// One total call, then one page of the 300 users in the window.
			expect(Arr.map(fake.calls, (c) => c.path)).toEqual(["/users/count", "/users"])
		}),
	)

	it.effect("groups signups by email domain in Maple", () =>
		Effect.gen(function* () {
			const fake = makeFakeClerk({ secretKey: SECRET, users: USERS })
			const { table } = yield* run(fake, {
				_tag: "resource",
				resource: "users",
				measure: { fn: "count" },
				groupBy: { field: "email_domain" },
			})
			expect(table.rows).toEqual([
				{ email_domain: "acme.dev", count: 100 },
				{ email_domain: "example.com", count: 100 },
				{ email_domain: "gmail.com", count: 100 },
			])
		}),
	)

	it.effect("refuses a scan past the row budget after one total call, with the estimate", () =>
		Effect.gen(function* () {
			const fake = makeFakeClerk({ secretKey: SECRET, users: seedClerkUsers(12_000, START_MS, END_MS) })
			const error = yield* Effect.flip(
				run(fake, {
					_tag: "resource",
					resource: "users",
					measure: { fn: "count" },
					groupBy: { field: "email_domain" },
				}),
			)
			expect(error._tag).toBe("@maple/data-sources/Limit")
			expect(error.message).toContain("~12000 users")
			expect(error.message).toContain("narrow the window")
			expect(Arr.map(fake.calls, (c) => c.path)).toEqual(["/users/count"])
		}),
	)

	it.effect(
		"charts organizations created per day by scanning, since Clerk has no time filter for them",
		() =>
			Effect.gen(function* () {
				const fake = makeFakeClerk({
					secretKey: SECRET,
					users: [],
					organizations: seedClerkOrganizations(60, START_MS - 30 * DAY_MS, END_MS),
				})
				const { summary, table } = yield* run(fake, {
					_tag: "resource",
					resource: "organizations",
					measure: { fn: "count" },
					groupBy: { time: "created_at" },
				})
				expect(summary).toMatchObject({ strategy: "scan" })
				expect(table.rows).toHaveLength(30)
				expect(Arr.every(table.rows, (r) => r.count === 1)).toBe(true)
			}),
	)

	it.effect("finishes a scan when the total is an exact multiple of the page size", () =>
		Effect.gen(function* () {
			const fake = makeFakeClerk({ secretKey: SECRET, users: seedClerkUsers(500, START_MS, END_MS) })
			const byDomain = yield* run(fake, {
				_tag: "resource",
				resource: "users",
				measure: { fn: "count" },
				groupBy: { field: "email_domain" },
			})
			expect(Arr.reduce(byDomain.table.rows, 0, (sum, r) => sum + Number(r.count))).toBe(500)
			const perDay = yield* run(fake, {
				_tag: "resource",
				resource: "users",
				measure: { fn: "count" },
				groupBy: { time: "created_at" },
			})
			expect(Arr.reduce(perDay.table.rows, 0, (sum, r) => sum + Number(r.count))).toBe(500)
		}),
	)

	it.effect("marks a list truncated only when more rows than the limit match", () =>
		Effect.gen(function* () {
			const list = { _tag: "resource", resource: "users", select: ["id"], limit: 100 } as const
			const more = yield* run(
				makeFakeClerk({ secretKey: SECRET, users: seedClerkUsers(101, START_MS, END_MS) }),
				list,
			)
			expect(more.table).toMatchObject({ truncated: true })
			expect(more.table.rows).toHaveLength(100)
			const exact = yield* run(
				makeFakeClerk({ secretKey: SECRET, users: seedClerkUsers(100, START_MS, END_MS) }),
				list,
			)
			expect(exact.table).toMatchObject({ truncated: false })
			expect(exact.table.rows).toHaveLength(100)
		}),
	)

	it.effect("lists exactly a full page of users without calling it truncated", () =>
		Effect.gen(function* () {
			const list = { _tag: "resource", resource: "users", select: ["id"], limit: 500 } as const
			const exact = makeFakeClerk({ secretKey: SECRET, users: seedClerkUsers(500, START_MS, END_MS) })
			const result = yield* run(exact, list)
			expect(result.table).toMatchObject({ truncated: false })
			expect(result.table.rows).toHaveLength(500)
			expect(result.summary.calls).toBe(exact.calls.length)
			const more = yield* run(
				makeFakeClerk({ secretKey: SECRET, users: seedClerkUsers(501, START_MS, END_MS) }),
				list,
			)
			expect(more.table).toMatchObject({ truncated: true })
		}),
	)
})

describe("Clerk validation", () => {
	it.effect("refuses PII fields when the caller may not read them", () =>
		Effect.gen(function* () {
			const query = { _tag: "resource", resource: "users", select: ["id", "primary_email"] } as const
			const error = yield* Effect.flip(prepare(query, request({ redactPii: true })))
			expect(error).toMatchObject({ _tag: "@maple/data-sources/Validation", field: "primary_email" })
			const allowed = yield* prepare(query)
			expect(allowed.summary).toMatchObject({ _tag: "resource", strategy: "scan" })
		}),
	)

	it.effect("suggests the field the caller meant", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(
				prepare({
					_tag: "resource",
					resource: "users",
					measure: { fn: "count" },
					groupBy: { time: "created" },
				}),
			)
			expect(error.message).toContain("`created_at`")
		}),
	)

	it.effect("points SQL at the resource form", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(prepare({ _tag: "sql", sql: "SELECT count(*) FROM users" }))
			expect(error.message).toContain('"_tag": "resource"')
		}),
	)

	it.effect("derives the instance from the key and keeps the stored key on update", () =>
		Effect.gen(function* () {
			const live = yield* clerkDriver.validateConnection(
				{ _tag: "clerk", secretKey: "sk_live_abc123" },
				null,
			)
			expect(live).toEqual({
				config: { _tag: "clerk", instance: "production" },
				secret: "sk_live_abc123",
			})
			const kept = yield* clerkDriver.validateConnection({ _tag: "clerk" }, live.config)
			expect(kept).toEqual({ config: live.config, secret: null })
			const bad = yield* Effect.flip(
				clerkDriver.validateConnection({ _tag: "clerk", secretKey: "pk_test_leak" }, null),
			)
			expect(bad.message).not.toContain("pk_test_leak")
		}),
	)
})
