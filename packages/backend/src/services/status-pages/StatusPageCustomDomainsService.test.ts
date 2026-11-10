import { afterEach, assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Layer, Schema, Array as Arr } from "effect"
import { TestClock } from "effect/testing"
import { OrgId } from "@maple/primitives"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "@maple/backend/testing/test-pglite"
import { CloudflareCustomHostnames } from "./CloudflareCustomHostnames"
import { customDomainProgress, StatusPageCustomDomainsService } from "./StatusPageCustomDomainsService"
import { StatusPagesService } from "./StatusPagesService"
import {
	cleanupRows,
	type InMemoryCustomHostnames,
	NOW,
	newPageId,
	ORG,
	readPage,
	seedPage,
} from "./status-page-test-support"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const OTHER_ORG = Schema.decodeSync(OrgId)("org_status_pages_other")
const TARGET = "status-domains.maple.test"

const withDomains = <A, E>(
	body: (ctx: {
		readonly testDb: TestDb
		readonly cloudflare: InMemoryCustomHostnames
		readonly domains: StatusPageCustomDomainsService["Service"]
		readonly pages: StatusPagesService["Service"]
	}) => Effect.Effect<A, E>,
	options: { readonly cnameTarget?: string | null } = {},
) =>
	Effect.gen(function* () {
		yield* TestClock.setTime(NOW)
		const testDb = createTestDb(trackedDbs)
		const cloudflare = yield* CloudflareCustomHostnames.makeInMemory({
			cnameTarget: options.cnameTarget === undefined ? TARGET : options.cnameTarget,
		})
		const layer = Layer.mergeAll(
			Layer.effect(StatusPageCustomDomainsService, StatusPageCustomDomainsService.make).pipe(
				Layer.provide(Layer.succeed(CloudflareCustomHostnames, cloudflare.api)),
			),
			Layer.effect(StatusPagesService, StatusPagesService.make),
		).pipe(Layer.provide(testDb.layer))
		return yield* Effect.gen(function* () {
			const domains = yield* StatusPageCustomDomainsService
			const pages = yield* StatusPagesService
			return yield* body({ testDb, cloudflare, domains, pages })
		}).pipe(Effect.provide(layer))
	})

const revision = (testDb: TestDb, pageId: string) =>
	readPage(testDb, pageId).pipe(Effect.map((row) => Number(row?.revision)))

const onlyHostnameId = (cloudflare: InMemoryCustomHostnames) =>
	cloudflare.hostnames.pipe(Effect.map((map) => [...map.keys()][0] ?? ""))

describe("StatusPageCustomDomainsService", () => {
	it.effect("adds a domain at Cloudflare and shows the CNAME and ownership records to add", () =>
		withDomains(({ testDb, cloudflare, domains }) =>
			Effect.gen(function* () {
				const pageId = newPageId()
				yield* seedPage(testDb, { id: pageId, slug: "acme" })

				const result = yield* domains.set(ORG, pageId, "  Status.Acme.com. ")
				assert.isTrue(result.available)
				assert.strictEqual(result.cnameTarget, TARGET)
				assert.strictEqual(result.domain?.hostname, "status.acme.com")
				assert.strictEqual(result.domain?.status, "pending_dns")
				assert.deepStrictEqual(
					Arr.map(result.domain?.dnsRecords ?? [], (record) => [
						record.type,
						record.name,
						record.purpose,
					]),
					[
						["CNAME", "status.acme.com", "routing"],
						["TXT", "_cf-custom-hostname.status.acme.com", "ownership"],
					],
				)
				assert.strictEqual(result.domain?.dnsRecords[0]?.value, TARGET)
				assert.strictEqual((yield* cloudflare.hostnames).size, 1)
				assert.deepStrictEqual([...(yield* cloudflare.routes).values()], ["status.acme.com"])
				assert.isNotNull(result.domain?.cloudflareRouteId ?? null)
			}),
		),
	)

	it.effect("moves through DNS and certificate to active on the poll, and republishes the page", () =>
		withDomains(({ testDb, cloudflare, domains }) =>
			Effect.gen(function* () {
				const pageId = newPageId()
				yield* seedPage(testDb, { id: pageId, slug: "acme" })
				yield* domains.set(ORG, pageId, "status.acme.com")
				const id = yield* onlyHostnameId(cloudflare)
				const before = yield* revision(testDb, pageId)

				yield* cloudflare.setHostname(id, {
					status: "active",
					sslStatus: "pending_validation",
					errors: [],
				})
				yield* TestClock.adjust(60_000)
				const first = yield* domains.poll(NOW + 60_000)
				assert.strictEqual(first.checked, 1)
				const pendingSsl = yield* domains.get(ORG, pageId)
				assert.strictEqual(pendingSsl.domain?.status, "pending_ssl")
				// Verified: the ownership record is no longer asked for.
				assert.deepStrictEqual(
					Arr.map(pendingSsl.domain?.dnsRecords ?? [], (record) => record.purpose),
					["routing"],
				)
				assert.strictEqual(yield* revision(testDb, pageId), before)

				yield* cloudflare.setHostname(id, { sslStatus: "active" })
				yield* TestClock.adjust(60_000)
				const second = yield* domains.poll(NOW + 120_000)
				assert.strictEqual(second.activated, 1)
				const active = yield* domains.get(ORG, pageId)
				assert.strictEqual(active.domain?.status, "active")
				assert.strictEqual(active.domain?.activatedAt, NOW + 120_000)
				assert.isNull(active.domain?.lastError ?? null)
				assert.strictEqual(yield* revision(testDb, pageId), before + 1)
			}),
		),
	)

	it.effect("checks a new domain every minute, and a settled one only hours later", () =>
		withDomains(({ testDb, cloudflare, domains }) =>
			Effect.gen(function* () {
				const pageId = newPageId()
				yield* seedPage(testDb, { id: pageId, slug: "acme" })
				yield* domains.set(ORG, pageId, "status.acme.com")
				assert.strictEqual((yield* domains.poll(NOW + 30_000)).checked, 0)
				assert.strictEqual((yield* domains.poll(NOW + 60_000)).checked, 1)

				const id = yield* onlyHostnameId(cloudflare)
				yield* cloudflare.setHostname(id, { status: "active", sslStatus: "active", errors: [] })
				yield* domains.poll(NOW + 120_000)
				assert.strictEqual((yield* domains.poll(NOW + 60 * 60_000)).checked, 0)
				assert.strictEqual((yield* domains.poll(NOW + 120_000 + 6 * 60 * 60_000)).checked, 1)
			}),
		),
	)

	it.effect("rejects hostnames that cannot be a custom domain", () =>
		withDomains(({ testDb, domains }) =>
			Effect.gen(function* () {
				const pageId = newPageId()
				yield* seedPage(testDb, { id: pageId, slug: "acme" })
				for (const hostname of [
					"acme.com",
					"status.maple.dev",
					"10.0.0.1",
					"https://status.acme.com",
					"a_b.acme.com",
				]) {
					const exit = yield* Effect.exit(domains.set(ORG, pageId, hostname))
					assert.isTrue(Exit.isFailure(exit), hostname)
					if (Exit.isFailure(exit)) {
						const error = exit.cause.reasons[0]
						assert.strictEqual(
							error?._tag === "Fail" ? error.error._tag : null,
							"@maple/http/errors/StatusPageValidationError",
							hostname,
						)
					}
				}
			}),
		),
	)

	it.effect("refuses a hostname another org's page already uses", () =>
		withDomains(({ testDb, domains }) =>
			Effect.gen(function* () {
				const pageId = newPageId()
				const otherPage = newPageId()
				yield* seedPage(testDb, { id: pageId, slug: "acme" })
				yield* seedPage(testDb, { id: otherPage, slug: "other" })
				yield* Effect.promise(() =>
					executeSql(testDb, `UPDATE status_pages SET org_id = $1 WHERE id = $2`, [
						OTHER_ORG,
						otherPage,
					]),
				)
				yield* domains.set(OTHER_ORG, otherPage, "status.acme.com")

				const exit = yield* Effect.exit(domains.set(ORG, pageId, "status.acme.com"))
				const reason = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined
				assert.strictEqual(
					reason?._tag === "Fail" ? reason.error._tag : null,
					"@maple/http/errors/StatusPageCustomDomainTakenError",
				)
			}),
		),
	)

	it.effect("never touches another org's page", () =>
		withDomains(({ testDb, domains }) =>
			Effect.gen(function* () {
				const pageId = newPageId()
				yield* seedPage(testDb, { id: pageId, slug: "acme" })
				const exit = yield* Effect.exit(domains.set(OTHER_ORG, pageId, "status.acme.com"))
				const reason = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined
				assert.strictEqual(
					reason?._tag === "Fail" ? reason.error._tag : null,
					"@maple/http/errors/StatusPageNotFoundError",
				)
			}),
		),
	)

	it.effect("replacing a domain queues the old one's teardown", () =>
		withDomains(({ testDb, cloudflare, domains }) =>
			Effect.gen(function* () {
				const pageId = newPageId()
				yield* seedPage(testDb, { id: pageId, slug: "acme" })
				yield* domains.set(ORG, pageId, "status.acme.com")
				const oldId = yield* onlyHostnameId(cloudflare)

				const result = yield* domains.set(ORG, pageId, "status.acme.io")
				assert.strictEqual(result.domain?.hostname, "status.acme.io")
				const queued = yield* Effect.promise(() =>
					testDb.pglite.query<{
						hostname: string
						cloudflare_hostname_id: string
						slug: string | null
					}>(`SELECT hostname, cloudflare_hostname_id, slug FROM status_page_cleanups`),
				)
				assert.deepStrictEqual(queued.rows, [
					{ hostname: "status.acme.com", cloudflare_hostname_id: oldId, slug: null },
				])
			}),
		),
	)

	it.effect("setting the same hostname again changes nothing", () =>
		withDomains(({ testDb, cloudflare, domains }) =>
			Effect.gen(function* () {
				const pageId = newPageId()
				yield* seedPage(testDb, { id: pageId, slug: "acme" })
				yield* domains.set(ORG, pageId, "status.acme.com")
				yield* domains.set(ORG, pageId, "STATUS.acme.com")
				assert.strictEqual((yield* cloudflare.hostnames).size, 1)
				assert.deepStrictEqual(yield* cleanupRows(testDb), [])
			}),
		),
	)

	it.effect("removing a domain queues its teardown and republishes a page it served", () =>
		withDomains(({ testDb, cloudflare, domains }) =>
			Effect.gen(function* () {
				const pageId = newPageId()
				yield* seedPage(testDb, { id: pageId, slug: "acme" })
				yield* domains.set(ORG, pageId, "status.acme.com")
				const id = yield* onlyHostnameId(cloudflare)
				yield* cloudflare.setHostname(id, { status: "active", sslStatus: "active", errors: [] })
				yield* domains.check(ORG, pageId)
				const before = yield* revision(testDb, pageId)

				const result = yield* domains.remove(ORG, pageId)
				assert.isNull(result.domain)
				assert.strictEqual(yield* revision(testDb, pageId), before + 1)
				assert.strictEqual((yield* cleanupRows(testDb)).length, 1)
				assert.isNull((yield* domains.get(ORG, pageId)).domain)
			}),
		),
	)

	it.effect("adding a removed hostname back takes over its queued Cloudflare hostname", () =>
		withDomains(({ testDb, cloudflare, domains }) =>
			Effect.gen(function* () {
				const pageId = newPageId()
				yield* seedPage(testDb, { id: pageId, slug: "acme" })
				yield* domains.set(ORG, pageId, "status.acme.com")
				const id = yield* onlyHostnameId(cloudflare)
				yield* domains.remove(ORG, pageId)

				const result = yield* domains.set(ORG, pageId, "status.acme.com")
				assert.strictEqual(result.domain?.cloudflareHostnameId, id)
				assert.strictEqual((yield* cloudflare.hostnames).size, 1)
				const queued = yield* Effect.promise(() =>
					testDb.pglite.query<{ cloudflare_hostname_id: string | null }>(
						`SELECT cloudflare_hostname_id FROM status_page_cleanups`,
					),
				)
				assert.deepStrictEqual(queued.rows, [{ cloudflare_hostname_id: null }])
			}),
		),
	)

	it.effect("saves the domain when Cloudflare is down, and creates it on a later poll", () =>
		withDomains(({ testDb, cloudflare, domains }) =>
			Effect.gen(function* () {
				const pageId = newPageId()
				yield* seedPage(testDb, { id: pageId, slug: "acme" })
				yield* cloudflare.setFailing(true)
				const result = yield* domains.set(ORG, pageId, "status.acme.com")
				assert.strictEqual(result.domain?.status, "pending_dns")
				assert.isNull(result.domain?.cloudflareHostnameId ?? null)
				assert.isNotNull(result.domain?.lastError ?? null)

				yield* cloudflare.setFailing(false)
				yield* domains.poll(NOW + 60_000)
				const later = yield* domains.get(ORG, pageId)
				assert.isNotNull(later.domain?.cloudflareHostnameId ?? null)
				assert.strictEqual((yield* cloudflare.hostnames).size, 1)
			}),
		),
	)

	it.effect("recreates a hostname removed at Cloudflare when checked", () =>
		withDomains(({ testDb, cloudflare, domains }) =>
			Effect.gen(function* () {
				const pageId = newPageId()
				yield* seedPage(testDb, { id: pageId, slug: "acme" })
				yield* domains.set(ORG, pageId, "status.acme.com")
				const id = yield* onlyHostnameId(cloudflare)
				yield* cloudflare.dropHostname(id)

				const result = yield* domains.check(ORG, pageId)
				assert.notStrictEqual(result.domain?.cloudflareHostnameId, id)
				assert.strictEqual((yield* cloudflare.hostnames).size, 1)
			}),
		),
	)

	it.effect("deleting the page queues its domain's teardown with the page's", () =>
		withDomains(({ testDb, cloudflare, domains, pages }) =>
			Effect.gen(function* () {
				const pageId = newPageId()
				yield* seedPage(testDb, { id: pageId, slug: "acme" })
				yield* domains.set(ORG, pageId, "status.acme.com")
				const id = yield* onlyHostnameId(cloudflare)

				yield* pages.remove(ORG, pageId)
				const queued = yield* Effect.promise(() =>
					testDb.pglite.query<{ slug: string; hostname: string; cloudflare_hostname_id: string }>(
						`SELECT slug, hostname, cloudflare_hostname_id FROM status_page_cleanups`,
					),
				)
				assert.deepStrictEqual(queued.rows, [
					{ slug: "acme", hostname: "status.acme.com", cloudflare_hostname_id: id },
				])
				const left = yield* Effect.promise(() =>
					testDb.pglite.query(`SELECT 1 FROM status_page_custom_domains`),
				)
				assert.strictEqual(left.rows.length, 0)
			}),
		),
	)

	it.effect("says custom domains are unavailable where Cloudflare is not configured", () =>
		withDomains(
			({ testDb, domains }) =>
				Effect.gen(function* () {
					const pageId = newPageId()
					yield* seedPage(testDb, { id: pageId, slug: "acme" })
					const view = yield* domains.get(ORG, pageId)
					assert.isFalse(view.available)
					const exit = yield* Effect.exit(domains.set(ORG, pageId, "status.acme.com"))
					const reason = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined
					assert.strictEqual(
						reason?._tag === "Fail" ? reason.error._tag : null,
						"@maple/http/errors/StatusPageCustomDomainsUnavailableError",
					)
					assert.deepStrictEqual(yield* domains.poll(NOW), { checked: 0, activated: 0, failed: 0 })
				}),
			{ cnameTarget: null },
		),
	)
})

describe("customDomainProgress", () => {
	const state = {
		id: "cfh-1",
		hostname: "status.acme.com",
		status: "active",
		sslStatus: "active",
		ownership: null,
		validationRecords: [] as ReadonlyArray<{
			readonly txtName: string | null
			readonly txtValue: string | null
		}>,
		errors: [] as ReadonlyArray<string>,
	}
	const progress = (
		patch: Partial<typeof state> & { readonly errors?: ReadonlyArray<string> },
		previous: "pending_dns" | "active" = "pending_dns",
	) =>
		customDomainProgress({
			hostname: "status.acme.com",
			cnameTarget: TARGET,
			previous,
			state: { ...state, ...patch },
		})

	it("fails a certificate that timed out, with Cloudflare's reason", () => {
		const result = progress({ sslStatus: "validation_timed_out", errors: ["CAA record blocks issuance"] })
		assert.strictEqual(result.status, "failed")
		assert.strictEqual(result.error, "CAA record blocks issuance")
	})

	it("fails a hostname that moved away", () => {
		const result = progress({ status: "moved" }, "active")
		assert.strictEqual(result.status, "failed")
		assert.include(result.error ?? "", "CNAME")
	})

	it("keeps an active domain active through a renewal still pending", () => {
		assert.strictEqual(progress({ sslStatus: "pending_validation" }, "active").status, "active")
	})

	it("asks for certificate TXT records while the certificate is pending", () => {
		const result = progress({
			sslStatus: "pending_validation",
			validationRecords: [{ txtName: "_acme-challenge.status.acme.com", txtValue: "token" }],
		})
		assert.strictEqual(result.status, "pending_ssl")
		assert.deepStrictEqual(
			Arr.map(result.dnsRecords, (record) => [record.type, record.name, record.purpose]),
			[
				["CNAME", "status.acme.com", "routing"],
				["TXT", "_acme-challenge.status.acme.com", "certificate"],
			],
		)
	})
})
