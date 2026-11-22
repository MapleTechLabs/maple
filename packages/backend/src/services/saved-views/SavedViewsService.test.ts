import { afterEach, assert, describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Layer, Order, Result, Schema, String as Str, Tracer } from "effect"
import { OrgId, SavedViewId, UserId } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "@maple/backend/testing/test-pglite"
import { SAVED_VIEWS_PER_OWNER_LIMIT, SavedViewsService } from "./SavedViewsService"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeSync(OrgId)("org_views")
const OTHER_ORG = Schema.decodeSync(OrgId)("org_elsewhere")
const decodeUser = Schema.decodeSync(UserId)

const caller = (orgId: OrgId, user: string, role: string): Policy.Actor => ({
	orgId,
	userId: decodeUser(user),
	permissions: Policy.grantsOf([role]),
})

const ANA = caller(ORG, "user_ana", "org:member")
const BEN = caller(ORG, "user_ben", "org:member")
const ADMIN = caller(ORG, "user_admin", "org:admin")
const ANALYST = caller(ORG, "user_analyst", "org:analyst")
// The same user id in another org: only the org tells the two apart.
const ANA_ELSEWHERE = caller(OTHER_ORG, "user_ana", "org:admin")

const asCaller = (actor: Policy.Actor) => Effect.provideService(Policy.CurrentActor, actor)

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
				const created = yield* views
					.create({ surface: "logs", name: "Checkout", state })
					.pipe(asCaller(ANA))
				assert.strictEqual(created.visibility, "private")
				assert.strictEqual(created.isOwner, true)
				assert.strictEqual(created.canDelete, true)

				const listed = yield* views.list("logs").pipe(asCaller(ANA))
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
					yield* views
						.create({
							surface: "logs",
							name: "Api errors",
							state: errorState,
							visibility: "org",
						})
						.pipe(asCaller(BEN))
					yield* views
						.create({ surface: "logs", name: "Ben private", state: errorState })
						.pipe(asCaller(BEN))
					yield* views
						.create({ surface: "logs", name: "zebra", state: errorState })
						.pipe(asCaller(ANA))
					yield* views
						.create({ surface: "logs", name: "Alpha", state: errorState })
						.pipe(asCaller(ANA))
					yield* views
						.create({ surface: "traces", name: "Slow traces", state: errorState })
						.pipe(asCaller(ANA))

					const listed = yield* views.list("logs").pipe(asCaller(ANA))
					assert.deepStrictEqual(names(listed), ["Alpha", "zebra", "Api errors"])
					assert.deepStrictEqual(
						Arr.map(listed, (view) => view.isOwner),
						[true, true, false],
					)
					assert.deepStrictEqual(names(yield* views.list("traces").pipe(asCaller(ANA))), [
						"Slow traces",
					])
					assert.deepStrictEqual(names(yield* views.list("metrics").pipe(asCaller(ANA))), [])
				}),
			),
	)

	it.effect("never lists or changes a view from another org", () =>
		provide(
			Effect.gen(function* () {
				const views = yield* SavedViewsService
				const shared = yield* views
					.create({
						surface: "logs",
						name: "Shared here",
						state: errorState,
						visibility: "org",
					})
					.pipe(asCaller(ANA))

				assert.deepStrictEqual(yield* views.list("logs").pipe(asCaller(ANA_ELSEWHERE)), [])
				const renamed = yield* Effect.flip(
					views.update(shared.id, { name: "Taken over" }).pipe(asCaller(ANA_ELSEWHERE)),
				)
				assert.strictEqual(renamed._tag, "@maple/http/saved-views/SavedViewNotFoundError")
				const removed = yield* Effect.flip(views.remove(shared.id).pipe(asCaller(ANA_ELSEWHERE)))
				assert.strictEqual(removed._tag, "@maple/http/saved-views/SavedViewNotFoundError")

				assert.deepStrictEqual(names(yield* views.list("logs").pipe(asCaller(ANA))), ["Shared here"])
			}),
		),
	)

	it.effect("lets only the owner rename, update or unshare a view", () =>
		provide(
			Effect.gen(function* () {
				const views = yield* SavedViewsService
				const shared = yield* views
					.create({
						surface: "traces",
						name: "Slow checkout",
						state: errorState,
						visibility: "org",
					})
					.pipe(asCaller(ANA))
				const hidden = yield* views
					.create({
						surface: "traces",
						name: "Scratch",
						state: errorState,
					})
					.pipe(asCaller(ANA))

				// A shared view is visible to Ben and the admin, so the refusal says who may change it.
				const byMember = yield* Effect.flip(
					views.update(shared.id, { name: "Mine now" }).pipe(asCaller(BEN)),
				)
				assert.strictEqual(byMember._tag, "@maple/http/saved-views/SavedViewForbiddenError")
				const byAdmin = yield* Effect.flip(
					views.update(shared.id, { visibility: "private" }).pipe(asCaller(ADMIN)),
				)
				assert.strictEqual(byAdmin._tag, "@maple/http/saved-views/SavedViewForbiddenError")
				// A private one answers as missing: its existence is not Ben's to learn.
				const onPrivate = yield* Effect.flip(
					views.update(hidden.id, { name: "Found it" }).pipe(asCaller(BEN)),
				)
				assert.strictEqual(onPrivate._tag, "@maple/http/saved-views/SavedViewNotFoundError")

				const nextState = { search: { hasError: true, timePreset: "24h" } }
				const updated = yield* views
					.update(shared.id, {
						name: "Failing checkout",
						state: nextState,
					})
					.pipe(asCaller(ANA))
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
				const view = yield* views
					.create({
						surface: "metrics",
						name: "Latency",
						state: errorState,
					})
					.pipe(asCaller(ANA))
				assert.deepStrictEqual(yield* views.list("metrics").pipe(asCaller(BEN)), [])

				yield* views.update(view.id, { visibility: "org" }).pipe(asCaller(ANA))
				assert.deepStrictEqual(names(yield* views.list("metrics").pipe(asCaller(BEN))), ["Latency"])

				yield* views.update(view.id, { visibility: "private" }).pipe(asCaller(ANA))
				assert.deepStrictEqual(yield* views.list("metrics").pipe(asCaller(BEN)), [])
			}),
		),
	)

	it.effect("lets the owner delete any of their views and an org admin a shared one", () =>
		provide(
			Effect.gen(function* () {
				const views = yield* SavedViewsService
				const shared = yield* views
					.create({
						surface: "logs",
						name: "Shared",
						state: errorState,
						visibility: "org",
					})
					.pipe(asCaller(ANA))
				const alsoShared = yield* views
					.create({
						surface: "logs",
						name: "Shared too",
						state: errorState,
						visibility: "org",
					})
					.pipe(asCaller(ANA))
				const hidden = yield* views
					.create({
						surface: "logs",
						name: "Private",
						state: errorState,
					})
					.pipe(asCaller(ANA))

				const byMember = yield* Effect.flip(views.remove(shared.id).pipe(asCaller(BEN)))
				assert.strictEqual(byMember._tag, "@maple/http/saved-views/SavedViewForbiddenError")
				const adminOnPrivate = yield* Effect.flip(views.remove(hidden.id).pipe(asCaller(ADMIN)))
				assert.strictEqual(adminOnPrivate._tag, "@maple/http/saved-views/SavedViewNotFoundError")

				assert.deepStrictEqual(
					Arr.map(yield* views.list("logs").pipe(asCaller(ADMIN)), (view) => [
						view.name,
						view.canDelete,
					]),
					[
						["Shared", true],
						["Shared too", true],
					],
				)
				assert.deepStrictEqual(
					Arr.map(yield* views.list("logs").pipe(asCaller(BEN)), (view) => view.canDelete),
					[false, false],
				)

				yield* views.remove(shared.id).pipe(asCaller(ADMIN))
				yield* views.remove(alsoShared.id).pipe(asCaller(ANA))
				yield* views.remove(hidden.id).pipe(asCaller(ANA))
				assert.deepStrictEqual(yield* views.list("logs").pipe(asCaller(ANA)), [])
			}),
		),
	)

	it.effect("lets an analyst keep and change their own views", () =>
		provide(
			Effect.gen(function* () {
				const views = yield* SavedViewsService
				const view = yield* views
					.create({
						surface: "logs",
						name: "Signups",
						state: errorState,
					})
					.pipe(asCaller(ANALYST))
				const shared = yield* views.update(view.id, { visibility: "org" }).pipe(asCaller(ANALYST))
				assert.strictEqual(shared.visibility, "org")
				yield* views.remove(view.id).pipe(asCaller(ANALYST))
				assert.deepStrictEqual(yield* views.list("logs").pipe(asCaller(ANALYST)), [])
			}),
		),
	)

	it.effect("refuses a second view of the same name for one owner in one explorer", () =>
		provide(
			Effect.gen(function* () {
				const views = yield* SavedViewsService
				yield* views
					.create({ surface: "logs", name: "Errors", state: errorState })
					.pipe(asCaller(ANA))
				const other = yield* views
					.create({
						surface: "logs",
						name: "Warnings",
						state: errorState,
					})
					.pipe(asCaller(ANA))

				const duplicate = yield* Effect.flip(
					views.create({ surface: "logs", name: "Errors", state: errorState }).pipe(asCaller(ANA)),
				)
				assert.strictEqual(duplicate._tag, "@maple/http/saved-views/SavedViewNameTakenError")
				const renamed = yield* Effect.flip(
					views.update(other.id, { name: "Errors" }).pipe(asCaller(ANA)),
				)
				assert.strictEqual(renamed._tag, "@maple/http/saved-views/SavedViewNameTakenError")

				// The name is the owner's per explorer: another explorer and another person may use it.
				yield* views
					.create({ surface: "traces", name: "Errors", state: errorState })
					.pipe(asCaller(ANA))
				yield* views
					.create({ surface: "logs", name: "Errors", state: errorState })
					.pipe(asCaller(BEN))
				assert.deepStrictEqual(names(yield* views.list("logs").pipe(asCaller(ANA))), [
					"Errors",
					"Warnings",
				])
			}),
		),
	)

	it.effect("refuses a taken name without a failed database span", () => {
		const spans: Array<Tracer.NativeSpan> = []
		const tracer = Tracer.make({
			span(options) {
				const span = new Tracer.NativeSpan(options)
				spans.push(span)
				return span
			},
		})
		return provide(
			Effect.gen(function* () {
				const views = yield* SavedViewsService
				yield* views
					.create({ surface: "logs", name: "Errors", state: errorState })
					.pipe(asCaller(ANA))
				const other = yield* views
					.create({ surface: "logs", name: "Other", state: errorState })
					.pipe(asCaller(ANA))
				yield* Effect.flip(
					views.create({ surface: "logs", name: "Errors", state: errorState }).pipe(asCaller(ANA)),
				)
				yield* Effect.flip(views.update(other.id, { name: "Errors" }).pipe(asCaller(ANA)))
				// Only the service call answering the 409 may fail; a database span failing opens an error issue.
				const failures = Arr.filterMap(spans, (span) =>
					span.status._tag === "Ended" && span.status.exit._tag === "Failure"
						? Result.succeed(span.name)
						: Result.failVoid,
				)
				assert.isAbove(failures.length, 0)
				assert.deepStrictEqual(
					Arr.filter(failures, (name) => !Str.startsWith("SavedViewsService.")(name)),
					[],
				)
			}).pipe(Effect.withTracer(tracer)),
		)
	})

	it.effect("stops one person at the per-explorer limit and leaves the other explorers open", () =>
		provide(
			Effect.gen(function* () {
				const views = yield* SavedViewsService
				yield* Effect.forEach(Arr.range(1, SAVED_VIEWS_PER_OWNER_LIMIT), (index) =>
					views
						.create({ surface: "logs", name: `View ${index}`, state: errorState })
						.pipe(asCaller(ANA)),
				)
				const over = yield* Effect.flip(
					views
						.create({ surface: "logs", name: "One too many", state: errorState })
						.pipe(asCaller(ANA)),
				)
				assert.strictEqual(over._tag, "@maple/http/saved-views/SavedViewLimitError")

				yield* views
					.create({ surface: "traces", name: "Still fine", state: errorState })
					.pipe(asCaller(ANA))
				yield* views
					.create({ surface: "logs", name: "Ben is fine", state: errorState })
					.pipe(asCaller(BEN))
			}),
		),
	)

	it.effect("lists the caller's own shared view once, beside another member's shared view", () =>
		provide(
			Effect.gen(function* () {
				const views = yield* SavedViewsService
				const mine = yield* views
					.create({ surface: "logs", name: "Mine", state: errorState })
					.pipe(asCaller(ANA))
				yield* views.update(mine.id, { visibility: "org" }).pipe(asCaller(ANA))
				yield* views
					.create({ surface: "logs", name: "Mine, private", state: errorState })
					.pipe(asCaller(ANA))
				const theirs = yield* views
					.create({
						surface: "logs",
						name: "Theirs",
						state: errorState,
					})
					.pipe(asCaller(BEN))
				yield* views.update(theirs.id, { visibility: "org" }).pipe(asCaller(BEN))
				yield* views
					.create({ surface: "logs", name: "Theirs, private", state: errorState })
					.pipe(asCaller(BEN))

				const listed = yield* views.list("logs").pipe(asCaller(ANA))
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
							views
								.create({ surface: "logs", name: `View ${index}`, state: errorState })
								.pipe(asCaller(ANA)),
						),
					{ concurrency: "unbounded" },
				)
				const saved = Arr.filter(outcomes, (outcome) => outcome._tag === "Success")
				assert.strictEqual(saved.length, SAVED_VIEWS_PER_OWNER_LIMIT)
				assert.strictEqual(
					(yield* views.list("logs").pipe(asCaller(ANA))).length,
					SAVED_VIEWS_PER_OWNER_LIMIT,
				)
			}),
		),
	)

	it.effect("leaves a view untouched by an update that changes nothing", () =>
		provide(
			Effect.gen(function* () {
				const views = yield* SavedViewsService
				const saved = yield* views
					.create({ surface: "logs", name: "Errors", state: errorState })
					.pipe(asCaller(ANA))
				const same = yield* views.update(saved.id, {}).pipe(asCaller(ANA))
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
				const mine = yield* views
					.create({ surface: "logs", name: "Mine", state: errorState })
					.pipe(asCaller(ANA))
				// A shared row written before the schema's limits: its state is not one the schema accepts.
				yield* Effect.promise(() =>
					executeSql(
						db,
						`insert into saved_views (id, org_id, owner_user_id, surface, name, state, visibility, created_at, updated_at)
					 values ($1, $2, $3, 'logs', 'Broken', '{"search": "not params"}'::jsonb, 'org', now(), now())`,
						["00000000-0000-4000-8000-0000000000ff", ORG, BEN.userId],
					),
				)
				assert.deepStrictEqual(names(yield* views.list("logs").pipe(asCaller(ANA))), ["Mine"])
				assert.deepStrictEqual(names(yield* views.list("logs").pipe(asCaller(BEN))), [])
				assert.strictEqual(mine.name, "Mine")

				yield* views
					.remove(Schema.decodeSync(SavedViewId)("00000000-0000-4000-8000-0000000000ff"))
					.pipe(asCaller(ADMIN))
				const gone = yield* Effect.flip(
					views
						.remove(Schema.decodeSync(SavedViewId)("00000000-0000-4000-8000-0000000000ff"))
						.pipe(asCaller(BEN)),
				)
				assert.strictEqual(gone._tag, "@maple/http/saved-views/SavedViewNotFoundError")
			}).pipe(Effect.provide(SavedViewsService.layer.pipe(Layer.provide(db.layer))))
		},
	)
})
