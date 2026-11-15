import { afterEach, assert, describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Layer, Order, Schema } from "effect"
import { OrgId, SavedViewId, UserId } from "@maple/domain/http"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "@maple/backend/testing/test-pglite"
import { SAVED_VIEWS_PER_OWNER_LIMIT, type SavedViewCaller, SavedViewsService } from "./SavedViewsService"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeSync(OrgId)("org_views")
const OTHER_ORG = Schema.decodeSync(OrgId)("org_elsewhere")
const decodeUser = Schema.decodeSync(UserId)

const caller = (orgId: OrgId, user: string, role: string): SavedViewCaller => ({
	orgId,
	userId: decodeUser(user),
	roles: [role],
})

const ANA = caller(ORG, "user_ana", "org:member")
const BEN = caller(ORG, "user_ben", "org:member")
const ADMIN = caller(ORG, "user_admin", "org:admin")
const ANALYST = caller(ORG, "user_analyst", "org:analyst")
// The same user id in another org: only the org tells the two apart.
const ANA_ELSEWHERE = caller(OTHER_ORG, "user_ana", "org:admin")

const provide = <A, E>(effect: Effect.Effect<A, E, SavedViewsService>) =>
	effect.pipe(Effect.provide(SavedViewsService.layer.pipe(Layer.provide(createTestDb(trackedDbs).layer))))

const errorState = { search: { severities: ["ERROR"], timePreset: "1h" } }

const names = (views: ReadonlyArray<{ readonly name: string }>) => Arr.map(views, (view) => view.name)

describe("SavedViewsService", () => {
	it.effect("stores the search params as given and keeps a new view private", () =>
		provide(
			Effect.gen(function* () {
				const views = yield* SavedViewsService
				const state = {
					search: {
						services: ["checkout", "cart"],
						whereClause: 'service.name = "checkout"',
						startTime: "2026-11-01 10:00:00",
						endTime: "2026-11-01 11:00:00",
						attributeFilters: [{ key: "http.route", op: "=", value: "/pay" }],
					},
				}
				const created = yield* views.create(ANA, { surface: "logs", name: "Checkout", state })
				assert.strictEqual(created.visibility, "private")
				assert.strictEqual(created.isOwner, true)
				assert.strictEqual(created.canDelete, true)

				const listed = yield* views.list(ANA, "logs")
				assert.deepStrictEqual(
					Arr.map(listed, (view) => view.state),
					[state],
				)
			}),
		),
	)

	it.effect(
		"lists the caller's own views first, then shared ones, and never a private one of someone else",
		() =>
			provide(
				Effect.gen(function* () {
					const views = yield* SavedViewsService
					yield* views.create(BEN, {
						surface: "logs",
						name: "Api errors",
						state: errorState,
						visibility: "org",
					})
					yield* views.create(BEN, { surface: "logs", name: "Ben private", state: errorState })
					yield* views.create(ANA, { surface: "logs", name: "zebra", state: errorState })
					yield* views.create(ANA, { surface: "logs", name: "Alpha", state: errorState })
					yield* views.create(ANA, { surface: "traces", name: "Slow traces", state: errorState })

					const listed = yield* views.list(ANA, "logs")
					assert.deepStrictEqual(names(listed), ["Alpha", "zebra", "Api errors"])
					assert.deepStrictEqual(
						Arr.map(listed, (view) => view.isOwner),
						[true, true, false],
					)
					assert.deepStrictEqual(names(yield* views.list(ANA, "traces")), ["Slow traces"])
					assert.deepStrictEqual(names(yield* views.list(ANA, "metrics")), [])
				}),
			),
	)

	it.effect("never lists or changes a view from another org", () =>
		provide(
			Effect.gen(function* () {
				const views = yield* SavedViewsService
				const shared = yield* views.create(ANA, {
					surface: "logs",
					name: "Shared here",
					state: errorState,
					visibility: "org",
				})

				assert.deepStrictEqual(yield* views.list(ANA_ELSEWHERE, "logs"), [])
				const renamed = yield* Effect.flip(
					views.update(ANA_ELSEWHERE, shared.id, { name: "Taken over" }),
				)
				assert.strictEqual(renamed._tag, "@maple/http/saved-views/SavedViewNotFoundError")
				const removed = yield* Effect.flip(views.remove(ANA_ELSEWHERE, shared.id))
				assert.strictEqual(removed._tag, "@maple/http/saved-views/SavedViewNotFoundError")

				assert.deepStrictEqual(names(yield* views.list(ANA, "logs")), ["Shared here"])
			}),
		),
	)

	it.effect("lets only the owner rename, update or unshare a view", () =>
		provide(
			Effect.gen(function* () {
				const views = yield* SavedViewsService
				const shared = yield* views.create(ANA, {
					surface: "traces",
					name: "Slow checkout",
					state: errorState,
					visibility: "org",
				})
				const hidden = yield* views.create(ANA, {
					surface: "traces",
					name: "Scratch",
					state: errorState,
				})

				// A shared view is visible to Ben and the admin, so the refusal says who may change it.
				const byMember = yield* Effect.flip(views.update(BEN, shared.id, { name: "Mine now" }))
				assert.strictEqual(byMember._tag, "@maple/http/saved-views/SavedViewForbiddenError")
				const byAdmin = yield* Effect.flip(views.update(ADMIN, shared.id, { visibility: "private" }))
				assert.strictEqual(byAdmin._tag, "@maple/http/saved-views/SavedViewForbiddenError")
				// A private one answers as missing: its existence is not Ben's to learn.
				const onPrivate = yield* Effect.flip(views.update(BEN, hidden.id, { name: "Found it" }))
				assert.strictEqual(onPrivate._tag, "@maple/http/saved-views/SavedViewNotFoundError")

				const nextState = { search: { hasError: true, timePreset: "24h" } }
				const updated = yield* views.update(ANA, shared.id, {
					name: "Failing checkout",
					state: nextState,
				})
				assert.strictEqual(updated.name, "Failing checkout")
				assert.deepStrictEqual(updated.state, nextState)
				assert.strictEqual(updated.visibility, "org")
			}),
		),
	)

	it.effect("shows a view to the org once shared and hides it again when made private", () =>
		provide(
			Effect.gen(function* () {
				const views = yield* SavedViewsService
				const view = yield* views.create(ANA, {
					surface: "metrics",
					name: "Latency",
					state: errorState,
				})
				assert.deepStrictEqual(yield* views.list(BEN, "metrics"), [])

				yield* views.update(ANA, view.id, { visibility: "org" })
				assert.deepStrictEqual(names(yield* views.list(BEN, "metrics")), ["Latency"])

				yield* views.update(ANA, view.id, { visibility: "private" })
				assert.deepStrictEqual(yield* views.list(BEN, "metrics"), [])
			}),
		),
	)

	it.effect("lets the owner delete any of their views and an org admin a shared one", () =>
		provide(
			Effect.gen(function* () {
				const views = yield* SavedViewsService
				const shared = yield* views.create(ANA, {
					surface: "logs",
					name: "Shared",
					state: errorState,
					visibility: "org",
				})
				const alsoShared = yield* views.create(ANA, {
					surface: "logs",
					name: "Shared too",
					state: errorState,
					visibility: "org",
				})
				const hidden = yield* views.create(ANA, {
					surface: "logs",
					name: "Private",
					state: errorState,
				})

				const byMember = yield* Effect.flip(views.remove(BEN, shared.id))
				assert.strictEqual(byMember._tag, "@maple/http/saved-views/SavedViewForbiddenError")
				const adminOnPrivate = yield* Effect.flip(views.remove(ADMIN, hidden.id))
				assert.strictEqual(adminOnPrivate._tag, "@maple/http/saved-views/SavedViewNotFoundError")

				assert.deepStrictEqual(
					Arr.map(yield* views.list(ADMIN, "logs"), (view) => [view.name, view.canDelete]),
					[
						["Shared", true],
						["Shared too", true],
					],
				)
				assert.deepStrictEqual(
					Arr.map(yield* views.list(BEN, "logs"), (view) => view.canDelete),
					[false, false],
				)

				yield* views.remove(ADMIN, shared.id)
				yield* views.remove(ANA, alsoShared.id)
				yield* views.remove(ANA, hidden.id)
				assert.deepStrictEqual(yield* views.list(ANA, "logs"), [])
			}),
		),
	)

	it.effect("lets an analyst keep and change their own views", () =>
		provide(
			Effect.gen(function* () {
				const views = yield* SavedViewsService
				const view = yield* views.create(ANALYST, {
					surface: "logs",
					name: "Signups",
					state: errorState,
				})
				const shared = yield* views.update(ANALYST, view.id, { visibility: "org" })
				assert.strictEqual(shared.visibility, "org")
				yield* views.remove(ANALYST, view.id)
				assert.deepStrictEqual(yield* views.list(ANALYST, "logs"), [])
			}),
		),
	)

	it.effect("refuses a second view of the same name for one owner in one explorer", () =>
		provide(
			Effect.gen(function* () {
				const views = yield* SavedViewsService
				yield* views.create(ANA, { surface: "logs", name: "Errors", state: errorState })
				const other = yield* views.create(ANA, {
					surface: "logs",
					name: "Warnings",
					state: errorState,
				})

				const duplicate = yield* Effect.flip(
					views.create(ANA, { surface: "logs", name: "Errors", state: errorState }),
				)
				assert.strictEqual(duplicate._tag, "@maple/http/saved-views/SavedViewNameTakenError")
				const renamed = yield* Effect.flip(views.update(ANA, other.id, { name: "Errors" }))
				assert.strictEqual(renamed._tag, "@maple/http/saved-views/SavedViewNameTakenError")

				// The name is the owner's per explorer: another explorer and another person may use it.
				yield* views.create(ANA, { surface: "traces", name: "Errors", state: errorState })
				yield* views.create(BEN, { surface: "logs", name: "Errors", state: errorState })
				assert.deepStrictEqual(names(yield* views.list(ANA, "logs")), ["Errors", "Warnings"])
			}),
		),
	)

	it.effect("stops one person at the per-explorer limit and leaves the other explorers open", () =>
		provide(
			Effect.gen(function* () {
				const views = yield* SavedViewsService
				yield* Effect.forEach(Arr.range(1, SAVED_VIEWS_PER_OWNER_LIMIT), (index) =>
					views.create(ANA, { surface: "logs", name: `View ${index}`, state: errorState }),
				)
				const over = yield* Effect.flip(
					views.create(ANA, { surface: "logs", name: "One too many", state: errorState }),
				)
				assert.strictEqual(over._tag, "@maple/http/saved-views/SavedViewLimitError")

				yield* views.create(ANA, { surface: "traces", name: "Still fine", state: errorState })
				yield* views.create(BEN, { surface: "logs", name: "Ben is fine", state: errorState })
			}),
		),
	)

	it.effect("lists the caller's own shared view once, beside another member's shared view", () =>
		provide(
			Effect.gen(function* () {
				const views = yield* SavedViewsService
				const mine = yield* views.create(ANA, { surface: "logs", name: "Mine", state: errorState })
				yield* views.update(ANA, mine.id, { visibility: "org" })
				yield* views.create(ANA, { surface: "logs", name: "Mine, private", state: errorState })
				const theirs = yield* views.create(BEN, {
					surface: "logs",
					name: "Theirs",
					state: errorState,
				})
				yield* views.update(BEN, theirs.id, { visibility: "org" })
				yield* views.create(BEN, { surface: "logs", name: "Theirs, private", state: errorState })

				const listed = yield* views.list(ANA, "logs")
				assert.deepStrictEqual(Arr.sort(names(listed), Order.String), [
					"Mine",
					"Mine, private",
					"Theirs",
				])
			}),
		),
	)

	it.effect("holds the per-explorer limit when many saves arrive at once", () =>
		provide(
			Effect.gen(function* () {
				const views = yield* SavedViewsService
				const outcomes = yield* Effect.forEach(
					Arr.range(1, SAVED_VIEWS_PER_OWNER_LIMIT + 20),
					(index) =>
						Effect.result(
							views.create(ANA, { surface: "logs", name: `View ${index}`, state: errorState }),
						),
					{ concurrency: "unbounded" },
				)
				const saved = Arr.filter(outcomes, (outcome) => outcome._tag === "Success")
				assert.strictEqual(saved.length, SAVED_VIEWS_PER_OWNER_LIMIT)
				assert.strictEqual((yield* views.list(ANA, "logs")).length, SAVED_VIEWS_PER_OWNER_LIMIT)
			}),
		),
	)

	it.effect("leaves a view untouched by an update that changes nothing", () =>
		provide(
			Effect.gen(function* () {
				const views = yield* SavedViewsService
				const saved = yield* views.create(ANA, { surface: "logs", name: "Errors", state: errorState })
				const same = yield* views.update(ANA, saved.id, {})
				assert.strictEqual(same.updatedAt, saved.updatedAt)
				assert.strictEqual(same.name, "Errors")
			}),
		),
	)

	it.effect(
		"lists the readable views beside one whose stored state no longer decodes, and lets it be deleted",
		() => {
			const db = createTestDb(trackedDbs)
			return Effect.gen(function* () {
				const views = yield* SavedViewsService
				const mine = yield* views.create(ANA, { surface: "logs", name: "Mine", state: errorState })
				// A shared row written before the schema's limits: its state is not one the schema accepts.
				yield* Effect.promise(() =>
					executeSql(
						db,
						`insert into saved_views (id, org_id, owner_user_id, surface, name, state, visibility, created_at, updated_at)
					 values ($1, $2, $3, 'logs', 'Broken', '{"search": "not params"}'::jsonb, 'org', now(), now())`,
						["00000000-0000-4000-8000-0000000000ff", ORG, BEN.userId],
					),
				)
				assert.deepStrictEqual(names(yield* views.list(ANA, "logs")), ["Mine"])
				assert.deepStrictEqual(names(yield* views.list(BEN, "logs")), [])
				assert.strictEqual(mine.name, "Mine")

				yield* views.remove(
					ADMIN,
					Schema.decodeSync(SavedViewId)("00000000-0000-4000-8000-0000000000ff"),
				)
				const gone = yield* Effect.flip(
					views.remove(BEN, Schema.decodeSync(SavedViewId)("00000000-0000-4000-8000-0000000000ff")),
				)
				assert.strictEqual(gone._tag, "@maple/http/saved-views/SavedViewNotFoundError")
			}).pipe(Effect.provide(SavedViewsService.layer.pipe(Layer.provide(db.layer))))
		},
	)
})
