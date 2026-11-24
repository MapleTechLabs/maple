import { assert, describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Exit, Option, Schema, String as Str } from "effect"
import { VcsInstallation } from "@maple/domain/http"
import { fakeGithubHttp, registryOverHttp } from "@maple/backend/services/integrations/vcs/__tests__/harness"
import { VcsProviderRegistry } from "@maple/backend/services/integrations/vcs/VcsProviderRegistry"

const INSTALLATION = Schema.decodeSync(VcsInstallation)({
	id: "00000000-0000-4000-8000-000000000042",
	orgId: "org_test",
	provider: "github",
	externalInstallationId: "42",
	accountLogin: "acme",
	accountType: "organization",
	externalAccountId: "1",
	accountAvatarUrl: null,
	repositorySelection: "all",
	status: "active",
	suspendedAt: null,
	ciTracesEnabled: true,
	auditLogEnabled: true,
	auditCategories: {},
	repositoryDiscovery: null,
	installedByUserId: "user_1",
	createdAt: 0,
	updatedAt: 0,
})
const REPO = { externalRepoId: "7", owner: "acme", name: "api", fullName: "acme/api" }
const NOW = Date.parse("2026-11-24T12:00:00Z")
const SINCE = Date.parse("2026-11-24T11:45:00Z")

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const suite = (id: number, pushedAt: string, overrides: Record<string, unknown> = {}) => ({
	id,
	actor_id: 9,
	actor_name: "mallory",
	before_sha: "aaa",
	after_sha: "bbb",
	ref: "refs/heads/main",
	repository_id: 7,
	repository_name: "api",
	pushed_at: pushedAt,
	result: "fail",
	evaluation_result: "fail",
	...overrides,
})

/** A fake GitHub that answers by path: the token, each rule suite page, and each suite's rules. */
const github = (opts: {
	readonly pages: ReadonlyArray<ReadonlyArray<unknown>>
	readonly listStatus?: number
	readonly rules?: Readonly<Record<number, ReadonlyArray<{ rule_type: string; result: string }>>>
	readonly requests?: Array<string>
}) =>
	registryOverHttp(
		fakeGithubHttp(({ url }) => {
			opts.requests?.push(url)
			const parsed = new URL(url)
			if (Str.endsWith("/access_tokens")(parsed.pathname))
				return json({ token: "t", expires_at: "2099-01-01T00:00:00Z" })
			const detail = /\/rulesets\/rule-suites\/(\d+)$/u.exec(parsed.pathname)
			if (detail !== null) {
				const rules = opts.rules?.[Number(detail[1])]
				return rules === undefined
					? json({ message: "Not Found" }, 404)
					: json({ rule_evaluations: rules })
			}
			if (opts.listStatus !== undefined) return json({ message: "Not Found" }, opts.listStatus)
			return json(opts.pages[Number(parsed.searchParams.get("page") ?? "1") - 1] ?? [])
		}),
	)

const refused = (sinceMs = SINCE) =>
	Effect.gen(function* () {
		const registry = yield* VcsProviderRegistry
		const provider = yield* registry.resolve("github")
		return yield* provider.fetchRefusedPushes(INSTALLATION, REPO, { sinceMs, nowMs: NOW })
	})

describe("GithubProvider refused pushes", () => {
	it.effect(
		"reads the failed rule suites after the cursor, oldest first, with the rules that failed",
		() => {
			const requests: Array<string> = []
			return Effect.gen(function* () {
				const { events, newestMs } = yield* refused()
				assert.deepStrictEqual(
					Arr.map(events, (event) => [event.providerEventId, event.outcomeReason]),
					[
						["rule-suite-11", "non_fast_forward"],
						["rule-suite-12", "required_signatures, pull_request"],
					],
				)
				assert.deepStrictEqual(events[0], {
					provider: "github",
					providerEventId: "rule-suite-11",
					account: "acme",
					occurredAtMs: Date.parse("2026-11-24T11:50:00Z"),
					actor: { type: "user", id: "9", name: "mallory" },
					action: "rule_suite.failed",
					category: "permission",
					outcome: "denied",
					outcomeReason: "non_fast_forward",
					target: { type: "branch", name: "acme/api: main" },
					raw: {
						rule_suite_id: 11,
						ref: "refs/heads/main",
						before: "aaa",
						after: "bbb",
						failed_rules: ["non_fast_forward"],
					},
				})
				assert.strictEqual(newestMs, Date.parse("2026-11-24T11:55:00Z"))
				const list = new URL(
					Option.getOrElse(Arr.findFirst(requests, Str.includes("rule-suites?")), () => ""),
				)
				assert.strictEqual(list.pathname, "/repos/acme/api/rulesets/rule-suites")
				assert.strictEqual(list.searchParams.get("rule_suite_result"), "fail")
				assert.strictEqual(list.searchParams.get("time_period"), "hour")
				// The suite at the cursor was read last time: no second page, no detail for it.
				assert.isFalse(Arr.some(requests, Str.includes("page=2")))
				assert.isFalse(Arr.some(requests, Str.endsWith("/rule-suites/10")))
			}).pipe(
				Effect.provide(
					github({
						requests,
						pages: [
							[
								suite(12, "2026-11-24T11:55:00Z"),
								suite(11, "2026-11-24T11:50:00Z"),
								suite(10, "2026-11-24T11:45:00Z"),
							],
						],
						rules: {
							11: [
								{ rule_type: "non_fast_forward", result: "fail" },
								{ rule_type: "required_signatures", result: "pass" },
							],
							12: [
								{ rule_type: "required_signatures", result: "fail" },
								{ rule_type: "pull_request", result: "fail" },
							],
						},
					}),
				),
			)
		},
	)

	it.effect("keeps a refusal whose rules GitHub would not say, and an actor GitHub no longer names", () =>
		Effect.gen(function* () {
			const { events } = yield* refused()
			assert.strictEqual(events.length, 1)
			assert.strictEqual(events[0]?.outcomeReason, undefined)
			assert.deepStrictEqual(events[0]?.actor, { type: "unknown", id: undefined, name: undefined })
		}).pipe(
			Effect.provide(
				github({
					pages: [[suite(20, "2026-11-24T11:58:00Z", { actor_id: null, actor_name: null })]],
				}),
			),
		),
	)

	it.effect("walks a full page to the next, and widens GitHub's window to cover an old cursor", () => {
		const requests: Array<string> = []
		const full = Arr.makeBy(100, (i) => suite(1000 - i, "2026-11-24T08:00:00Z"))
		return Effect.gen(function* () {
			const { events, newestMs } = yield* refused(Date.parse("2026-11-23T12:00:00Z"))
			assert.strictEqual(events.length, 101)
			assert.strictEqual(newestMs, Date.parse("2026-11-24T08:00:00Z"))
			const pages = Arr.filter(requests, Str.includes("rule-suites?"))
			assert.deepStrictEqual(
				Arr.map(pages, (url) => new URL(url).searchParams.get("page")),
				["1", "2"],
			)
			assert.strictEqual(new URL(pages[0] ?? "").searchParams.get("time_period"), "day")
		}).pipe(Effect.provide(github({ requests, pages: [full, [suite(1, "2026-11-23T20:00:00Z")]] })))
	})

	it.effect("stops after three pages and says older refusals were left unread", () => {
		const requests: Array<string> = []
		const page = (n: number) => Arr.makeBy(100, (i) => suite(n * 1000 - i, "2026-11-24T11:59:00Z"))
		return Effect.gen(function* () {
			const { events, truncated } = yield* refused()
			assert.strictEqual(events.length, 300)
			assert.isTrue(truncated)
			assert.isFalse(Arr.some(requests, Str.includes("page=4")))
		}).pipe(Effect.provide(github({ requests, pages: [page(1), page(2), page(3), page(4)] })))
	})

	it.effect("answers a repository without rule insights as unavailable", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(refused())
			assert.isTrue(Exit.isFailure(exit))
			if (Exit.isFailure(exit)) {
				const error = exit.cause.reasons[0]
				assert.strictEqual(
					error?._tag === "Fail" ? error.error._tag : undefined,
					"@maple/http/errors/VcsRepoUnavailableError",
				)
			}
		}).pipe(Effect.provide(github({ pages: [], listStatus: 404 }))),
	)
})
