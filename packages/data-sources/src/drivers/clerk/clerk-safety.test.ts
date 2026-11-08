import { describe, expect, it } from "@effect/vitest"
import { Array as Arr, Effect, Option, Tracer } from "effect"
import {
	CATALOG,
	DAY_MS,
	END_MS,
	START_MS,
	SECRET,
	budget,
	connection,
	devConnection,
	request,
	run,
} from "./clerk.test-support"
import { clerkDriver } from "./index"
import { makeFakeClerk, seedClerkUsers } from "./testing"

const crowded = () =>
	makeFakeClerk({ secretKey: SECRET, users: seedClerkUsers(24_000, START_MS - 30 * DAY_MS, END_MS) })
const SIGNUPS_PER_DAY = {
	_tag: "resource",
	resource: "users",
	measure: { fn: "count" },
	groupBy: { time: "created_at" },
} as const
const paramsOf = (fake: ReturnType<typeof crowded>) => Arr.flatMap(fake.calls, (c) => c.params)

describe("Clerk resources an admin hid", () => {
	it.effect("refuses every resource when all of them are hidden, instead of falling back to all", () =>
		Effect.gen(function* () {
			const hiddenAll = { ...CATALOG, entries: [] }
			const error = yield* Effect.flip(
				clerkDriver.prepare(connection, SIGNUPS_PER_DAY, request(), hiddenAll),
			)
			expect(error._tag).toBe("@maple/data-sources/Validation")
			const onlyOrgs = {
				...CATALOG,
				entries: Arr.filter(CATALOG.entries, (e) => e.name === "organizations"),
			}
			const hiddenUsers = yield* Effect.flip(
				clerkDriver.prepare(connection, SIGNUPS_PER_DAY, request(), onlyOrgs),
			)
			expect(hiddenUsers.message).toContain("Resources: `organizations`.")
		}),
	)
})

describe("Clerk call share", () => {
	it.effect("plans a development instance within its 5-call share and refuses instead of hitting it", () =>
		Effect.gen(function* () {
			const fake = crowded()
			const { state, context } = budget(5)
			const error = yield* Effect.flip(run(fake, SIGNUPS_PER_DAY, request(), context, devConnection))
			expect(error._tag).toBe("@maple/data-sources/Limit")
			expect(error.message).toContain("over the budget of 5")
			expect(state.spent).toBe(1)
		}),
	)
})

describe("Clerk parameters", () => {
	it.effect("rounds fractional epoch-ms bounds to integers with the same meaning", () =>
		Effect.gen(function* () {
			const fake = crowded()
			yield* run(fake, {
				_tag: "resource",
				resource: "users",
				measure: { fn: "count" },
				filters: [
					{ field: "created_at", op: "gte", value: 999.5 },
					{ field: "last_active_at", op: "lte", value: 2000.5 },
				],
			})
			expect(paramsOf(fake)).toEqual([
				["created_at_after", "999"],
				["last_active_at_before", "2001"],
			])
		}),
	)

	it.effect("counts only users whose primary email matches, not a secondary address", () =>
		Effect.gen(function* () {
			const users = Arr.map(seedClerkUsers(2, START_MS, END_MS), (user, i) =>
				i === 0
					? { ...user, email: "owner@acme.dev" }
					: { ...user, email: "other@example.com", secondaryEmails: ["owner@acme.dev"] },
			)
			const fake = makeFakeClerk({ secretKey: SECRET, users })
			const query = (op: "eq" | "contains", value: string) =>
				run(fake, {
					_tag: "resource",
					resource: "users",
					measure: { fn: "count" },
					filters: [{ field: "primary_email", op, value }],
				})
			expect((yield* query("eq", "owner@acme.dev")).table.rows).toEqual([{ count: 1 }])
			expect((yield* query("contains", "owner@")).table.rows).toEqual([{ count: 1 }])
			// Clerk still narrows the scan server side.
			expect(paramsOf(fake)).toContainEqual(["email_address", "owner@acme.dev"])
		}),
	)

	it.effect("keeps personal filter values out of the HTTP client span", () =>
		Effect.gen(function* () {
			const spans: Array<Tracer.NativeSpan> = []
			const tracer = Tracer.make({
				span(options) {
					const span = new Tracer.NativeSpan(options)
					spans.push(span)
					return span
				},
			})
			const fake = crowded()
			yield* run(fake, {
				_tag: "resource",
				resource: "users",
				filters: [
					{ field: "primary_email", op: "contains", value: "person7@" },
					{ field: "username", op: "eq", value: "person8" },
				],
				select: ["id"],
			}).pipe(Effect.withTracer(tracer))
			const client = Arr.filter(spans, (s) => s.kind === "client")
			expect(client.length).toBeGreaterThan(0)
			const recorded = JSON.stringify(Arr.map(client, (s) => Arr.fromIterable(s.attributes)))
			expect(recorded).not.toContain("person7")
			expect(recorded).not.toContain("person8")
			const url = Arr.findFirst(client, (span) => span.attributes.has("url.full")).pipe(
				Option.flatMap((span) => Option.fromNullishOr(span.attributes.get("url.full"))),
			)
			expect(Option.getOrElse(url, () => "")).toContain("email_address_query=REDACTED")
			// Clerk shows as the driver's dependency on the service map.
			expect(
				Arr.some(
					client,
					(span) =>
						span.name === "ClerkDriver.get" && span.attributes.get("peer.service") === "clerk",
				),
			).toBe(true)
			// The values still reach Clerk.
			expect(paramsOf(fake)).toContainEqual(["email_address_query", "person7@"])
		}),
	)
})
