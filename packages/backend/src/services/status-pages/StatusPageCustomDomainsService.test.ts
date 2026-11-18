import { afterEach, assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Layer, Ref, Schema, Array as Arr, String as Str } from "effect"
import { TestClock } from "effect/testing"
import { OrgId, type StatusPageId } from "@maple/primitives"
import { DnsTxtResolver } from "@maple/backend/platform/DnsTxtResolver"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "@maple/backend/testing/test-pglite"
import { CloudflareCustomHostnames, type CloudflareCustomHostnamesApi } from "./CloudflareCustomHostnames"
import { customDomainOwnershipRecord } from "./custom-domain-ownership"
import { customDomainProgress, StatusPageCustomDomainsService } from "./StatusPageCustomDomainsService"
import { StatusPagesService } from "./StatusPagesService"
import {
	cleanupRows,
	DAY_MS,
	type InMemoryCustomHostnames,
	type InMemoryDns,
	makeInMemoryDns,
	NOW,
	newPageId,
	ORG,
	readPage,
	seedCustomDomain,
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
		readonly dns: InMemoryDns
		readonly domains: StatusPageCustomDomainsService["Service"]
		readonly pages: StatusPagesService["Service"]
	}) => Effect.Effect<A, E>,
	options: {
		readonly cnameTarget?: string | null
		/** Stands in for parts of the double, to act while a check is mid-call to Cloudflare. */
		readonly api?: (api: CloudflareCustomHostnamesApi) => CloudflareCustomHostnamesApi
	} = {},
) =>
	Effect.gen(function* () {
		yield* TestClock.setTime(NOW)
		const testDb = createTestDb(trackedDbs)
		const cloudflare = yield* CloudflareCustomHostnames.makeInMemory({
			cnameTarget: options.cnameTarget === undefined ? TARGET : options.cnameTarget,
		})
		const dns = yield* makeInMemoryDns
		const layer = Layer.mergeAll(
			Layer.effect(StatusPageCustomDomainsService, StatusPageCustomDomainsService.make).pipe(
				Layer.provide(
					Layer.succeed(
						CloudflareCustomHostnames,
						options.api === undefined ? cloudflare.api : options.api(cloudflare.api),
					),
				),
				Layer.provide(Layer.succeed(DnsTxtResolver, dns.api)),
			),
			Layer.effect(StatusPagesService, StatusPagesService.make),
		).pipe(Layer.provide(testDb.layer))
		return yield* Effect.gen(function* () {
			const domains = yield* StatusPageCustomDomainsService
			const pages = yield* StatusPagesService
			return yield* body({ testDb, cloudflare, dns, domains, pages })
		}).pipe(Effect.provide(layer))
	})

/** Publishes the ownership record of the page's claim on `hostname`, as the zone's owner would. */
const publishOwnership = (dns: InMemoryDns, pageId: StatusPageId, hostname: string, orgId: OrgId = ORG) =>
	dns.publish(customDomainOwnershipRecord({ orgId, pageId, hostname }))

const moveToOtherOrg = (testDb: TestDb, pageId: StatusPageId) =>
	Effect.promise(() =>
		executeSql(testDb, `UPDATE status_pages SET org_id = $1 WHERE id = $2`, [OTHER_ORG, pageId]),
	)

const revision = (testDb: TestDb, pageId: string) =>
	readPage(testDb, pageId).pipe(Effect.map((row) => Number(row?.revision)))

const onlyHostnameId = (cloudflare: InMemoryCustomHostnames) =>
	cloudflare.hostnames.pipe(Effect.map((map) => [...map.keys()][0] ?? ""))

/** An effect to run once, the next time `before` wraps a Cloudflare call, ahead of that call. */
const interleave = Effect.gen(function* () {
	const next = yield* Ref.make<Effect.Effect<void>>(Effect.void)
	return {
		arm: (during: Effect.Effect<void, unknown>) => Ref.set(next, Effect.orDie(during)),
		before: <A, E>(call: Effect.Effect<A, E>) =>
			Ref.getAndSet(next, Effect.void).pipe(Effect.flatten, Effect.andThen(call)),
	}
})

const domainRows = (testDb: TestDb) =>
	Effect.promise(() =>
		testDb.pglite.query<{ page_id: string; hostname: string; cloudflare_hostname_id: string | null }>(
			`SELECT page_id, hostname, cloudflare_hostname_id FROM status_page_custom_domains ORDER BY page_id`,
		),
	).pipe(Effect.map((result) => result.rows))

const queuedCloudflareRemovals = (testDb: TestDb) =>
	Effect.promise(() =>
		testDb.pglite.query<{
			hostname: string
			cloudflare_hostname_id: string | null
			cloudflare_route_id: string | null
		}>(
			`SELECT hostname, cloudflare_hostname_id, cloudflare_route_id FROM status_page_cleanups
			 WHERE cloudflare_hostname_id IS NOT NULL OR cloudflare_route_id IS NOT NULL`,
		),
	).pipe(Effect.map((result) => result.rows))

describe("StatusPageCustomDomainsService", () => {
	it.effect("a new claim lists its CNAME and ownership records, with nothing at Cloudflare yet", () =>
		withDomains(({ testDb, cloudflare, domains }) =>
			Effect.gen(function* () {
				const pageId = newPageId()
				yield* seedPage(testDb, { id: pageId, slug: "acme" })

				const result = yield* domains.set(ORG, pageId, "  Status.Acme.com. ")
				assert.isTrue(result.available)
				assert.strictEqual(result.cnameTarget, TARGET)
				assert.strictEqual(result.domain?.hostname, "status.acme.com")
				assert.strictEqual(result.domain?.status, "pending_dns")
				assert.deepStrictEqual(result.domain?.dnsRecords, [
					{ type: "CNAME", name: "status.acme.com", value: TARGET, purpose: "routing" },
					customDomainOwnershipRecord({ orgId: ORG, pageId, hostname: "status.acme.com" }),
				])
				assert.isNull(result.domain?.cloudflareHostnameId ?? null)
				assert.isNull(result.domain?.lastError ?? null)
				assert.strictEqual((yield* cloudflare.hostnames).size, 0)
				assert.strictEqual((yield* cloudflare.routes).size, 0)

				// Checking without the record published creates nothing either, and says why.
				const checked = yield* domains.check(ORG, pageId)
				assert.strictEqual(checked.domain?.status, "pending_dns")
				assert.include(checked.domain?.lastError ?? "", "ownership TXT record")
				assert.strictEqual((yield* cloudflare.hostnames).size, 0)
				assert.strictEqual((yield* cloudflare.routes).size, 0)
			}),
		),
	)

	it.effect("creates the domain at Cloudflare once its ownership record is published", () =>
		withDomains(({ testDb, cloudflare, dns, domains }) =>
			Effect.gen(function* () {
				const pageId = newPageId()
				yield* seedPage(testDb, { id: pageId, slug: "acme" })
				yield* domains.set(ORG, pageId, "status.acme.com")
				yield* publishOwnership(dns, pageId, "status.acme.com")

				assert.strictEqual((yield* domains.poll(NOW + 60_000)).checked, 1)
				const created = (yield* domains.get(ORG, pageId)).domain
				assert.isNotNull(created?.cloudflareHostnameId ?? null)
				assert.isNotNull(created?.cloudflareRouteId ?? null)
				assert.deepStrictEqual(
					Arr.map(created?.dnsRecords ?? [], (record) => [
						record.type,
						record.name,
						record.purpose,
					]),
					[
						["CNAME", "status.acme.com", "routing"],
						["TXT", "_cf-custom-hostname.status.acme.com", "ownership"],
					],
				)
				assert.strictEqual((yield* cloudflare.hostnames).size, 1)
				assert.deepStrictEqual([...(yield* cloudflare.routes).values()], ["status.acme.com"])
			}),
		),
	)

	it.effect("a record published for another organization or another page does not verify", () =>
		withDomains(({ testDb, cloudflare, dns, domains }) =>
			Effect.gen(function* () {
				const pageId = newPageId()
				const otherPage = newPageId()
				yield* seedPage(testDb, { id: pageId, slug: "acme" })
				yield* seedPage(testDb, { id: otherPage, slug: "other" })
				yield* publishOwnership(dns, pageId, "status.acme.com", OTHER_ORG)
				yield* publishOwnership(dns, otherPage, "status.acme.com")
				yield* publishOwnership(dns, pageId, "status.acme.io")

				yield* domains.set(ORG, pageId, "status.acme.com")
				const checked = yield* domains.check(ORG, pageId)
				assert.strictEqual(checked.domain?.status, "pending_dns")
				assert.isNull(checked.domain?.cloudflareHostnameId ?? null)
				assert.strictEqual((yield* cloudflare.hostnames).size, 0)
			}),
		),
	)

	it.effect("a failed DNS lookup does not verify, and is kept as the last error", () =>
		withDomains(({ testDb, cloudflare, dns, domains }) =>
			Effect.gen(function* () {
				const pageId = newPageId()
				yield* seedPage(testDb, { id: pageId, slug: "acme" })
				yield* publishOwnership(dns, pageId, "status.acme.com")
				yield* dns.setFailing(true)

				const result = yield* domains.set(ORG, pageId, "status.acme.com")
				assert.strictEqual(result.domain?.status, "pending_dns")
				assert.include(result.domain?.lastError ?? "", "could not look up")
				assert.isTrue(
					Arr.some(result.domain?.dnsRecords ?? [], (record) =>
						Str.startsWith("_maple-challenge.")(record.name),
					),
				)
				assert.strictEqual((yield* cloudflare.hostnames).size, 0)

				yield* dns.setFailing(false)
				const checked = yield* domains.check(ORG, pageId)
				assert.isNotNull(checked.domain?.cloudflareHostnameId ?? null)
			}),
		),
	)

	it.effect("a domain already at Cloudflare is checked as before, with no ownership record", () =>
		withDomains(({ testDb, cloudflare, dns, domains }) =>
			Effect.gen(function* () {
				const pageId = newPageId()
				yield* seedPage(testDb, { id: pageId, slug: "acme" })
				const existing = yield* cloudflare.api.createHostname("status.acme.com")
				yield* seedCustomDomain(testDb, {
					pageId,
					hostname: "status.acme.com",
					status: "pending_dns",
					cloudflareHostnameId: existing.id,
				})
				// No record is published and DNS is down: neither matters to this domain.
				yield* dns.setFailing(true)
				yield* cloudflare.setHostname(existing.id, {
					status: "active",
					sslStatus: "active",
					errors: [],
				})

				const checked = yield* domains.check(ORG, pageId)
				assert.strictEqual(checked.domain?.status, "active")
				assert.strictEqual(checked.domain?.cloudflareHostnameId, existing.id)
				assert.isNull(checked.domain?.lastError ?? null)
				assert.deepStrictEqual(
					Arr.map(checked.domain?.dnsRecords ?? [], (record) => record.purpose),
					["routing"],
				)
			}),
		),
	)

	it.effect("refuses a domain for an internal page, which is served on no address", () =>
		withDomains(({ testDb, cloudflare, domains }) =>
			Effect.gen(function* () {
				const pageId = newPageId()
				yield* seedPage(testDb, { id: pageId, slug: "acme", visibility: "internal" })
				const refused = yield* Effect.flip(domains.set(ORG, pageId, "status.acme.com"))
				assert.strictEqual(refused._tag, "@maple/http/errors/StatusPageValidationError")
				assert.strictEqual((yield* cloudflare.hostnames).size, 0)
			}),
		),
	)

	it.effect("moves through DNS and certificate to active on the poll, and republishes the page", () =>
		withDomains(({ testDb, cloudflare, dns, domains }) =>
			Effect.gen(function* () {
				const pageId = newPageId()
				yield* seedPage(testDb, { id: pageId, slug: "acme" })
				yield* publishOwnership(dns, pageId, "status.acme.com")
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
		withDomains(({ testDb, cloudflare, dns, domains }) =>
			Effect.gen(function* () {
				const pageId = newPageId()
				yield* seedPage(testDb, { id: pageId, slug: "acme" })
				yield* publishOwnership(dns, pageId, "status.acme.com")
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

	it.effect("refuses a hostname another org's page has proved it owns", () =>
		withDomains(({ testDb, dns, domains }) =>
			Effect.gen(function* () {
				const pageId = newPageId()
				const otherPage = newPageId()
				yield* seedPage(testDb, { id: pageId, slug: "acme" })
				yield* seedPage(testDb, { id: otherPage, slug: "other" })
				yield* moveToOtherOrg(testDb, otherPage)
				yield* publishOwnership(dns, otherPage, "status.acme.com", OTHER_ORG)
				const held = yield* domains.set(OTHER_ORG, otherPage, "status.acme.com")
				// Even with its own record published, a page cannot take a hostname another has proved.
				yield* publishOwnership(dns, pageId, "status.acme.com")

				const exit = yield* Effect.exit(domains.set(ORG, pageId, "status.acme.com"))
				const reason = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined
				assert.strictEqual(
					reason?._tag === "Fail" ? reason.error._tag : null,
					"@maple/http/errors/StatusPageCustomDomainTakenError",
				)
				assert.deepStrictEqual((yield* domains.get(OTHER_ORG, otherPage)).domain, held.domain)
				assert.isNull((yield* domains.get(ORG, pageId)).domain)
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
		withDomains(({ testDb, cloudflare, dns, domains }) =>
			Effect.gen(function* () {
				const pageId = newPageId()
				yield* seedPage(testDb, { id: pageId, slug: "acme" })
				yield* publishOwnership(dns, pageId, "status.acme.com")
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
		withDomains(({ testDb, cloudflare, dns, domains }) =>
			Effect.gen(function* () {
				const pageId = newPageId()
				yield* seedPage(testDb, { id: pageId, slug: "acme" })
				yield* publishOwnership(dns, pageId, "status.acme.com")
				yield* domains.set(ORG, pageId, "status.acme.com")
				yield* domains.set(ORG, pageId, "STATUS.acme.com")
				assert.strictEqual((yield* cloudflare.hostnames).size, 1)
				assert.deepStrictEqual(yield* cleanupRows(testDb), [])
			}),
		),
	)

	it.effect("removing a domain queues its teardown and republishes a page it served", () =>
		withDomains(({ testDb, cloudflare, dns, domains }) =>
			Effect.gen(function* () {
				const pageId = newPageId()
				yield* seedPage(testDb, { id: pageId, slug: "acme" })
				yield* publishOwnership(dns, pageId, "status.acme.com")
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
		withDomains(({ testDb, cloudflare, dns, domains }) =>
			Effect.gen(function* () {
				const pageId = newPageId()
				yield* seedPage(testDb, { id: pageId, slug: "acme" })
				yield* publishOwnership(dns, pageId, "status.acme.com")
				yield* domains.set(ORG, pageId, "status.acme.com")
				const id = yield* onlyHostnameId(cloudflare)
				yield* domains.remove(ORG, pageId)
				// Its own earlier hostname comes back without asking for the record again.
				yield* dns.unpublish("_maple-challenge.status.acme.com")

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
		withDomains(({ testDb, cloudflare, dns, domains }) =>
			Effect.gen(function* () {
				const pageId = newPageId()
				yield* seedPage(testDb, { id: pageId, slug: "acme" })
				yield* cloudflare.setFailing(true)
				yield* publishOwnership(dns, pageId, "status.acme.com")
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
		withDomains(({ testDb, cloudflare, dns, domains }) =>
			Effect.gen(function* () {
				const pageId = newPageId()
				yield* seedPage(testDb, { id: pageId, slug: "acme" })
				yield* publishOwnership(dns, pageId, "status.acme.com")
				yield* domains.set(ORG, pageId, "status.acme.com")
				const id = yield* onlyHostnameId(cloudflare)
				yield* cloudflare.dropHostname(id)
				yield* dns.unpublish("_maple-challenge.status.acme.com")

				const result = yield* domains.check(ORG, pageId)
				assert.notStrictEqual(result.domain?.cloudflareHostnameId, id)
				assert.strictEqual((yield* cloudflare.hostnames).size, 1)
			}),
		),
	)

	it.effect("deleting the page queues its domain's teardown with the page's", () =>
		withDomains(({ testDb, cloudflare, dns, domains, pages }) =>
			Effect.gen(function* () {
				const pageId = newPageId()
				yield* seedPage(testDb, { id: pageId, slug: "acme" })
				yield* publishOwnership(dns, pageId, "status.acme.com")
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
					assert.deepStrictEqual(yield* domains.poll(NOW), {
						checked: 0,
						activated: 0,
						failed: 0,
						errored: 0,
						expired: 0,
					})
				}),
			{ cnameTarget: null },
		),
	)

	it.effect("never reads, checks or removes another org's domain", () =>
		withDomains(({ testDb, domains }) =>
			Effect.gen(function* () {
				const pageId = newPageId()
				yield* seedPage(testDb, { id: pageId, slug: "acme" })
				yield* seedCustomDomain(testDb, {
					pageId,
					hostname: "status.acme.com",
					status: "active",
					cloudflareHostnameId: "cfh-acme",
					cloudflareRouteId: "route-acme",
				})
				const before = yield* domainRows(testDb)

				for (const attempt of [
					domains.get(OTHER_ORG, pageId),
					domains.check(OTHER_ORG, pageId),
					domains.remove(OTHER_ORG, pageId),
				]) {
					const refused = yield* Effect.flip(attempt)
					assert.strictEqual(refused._tag, "@maple/http/errors/StatusPageNotFoundError")
				}
				assert.deepStrictEqual(yield* domainRows(testDb), before)
				assert.deepStrictEqual(yield* cleanupRows(testDb), [])
			}),
		),
	)

	it.effect("fails a hostname the zone holds for another stage or service", () =>
		withDomains(({ testDb, cloudflare, dns, domains }) =>
			Effect.gen(function* () {
				const pageId = newPageId()
				yield* seedPage(testDb, { id: pageId, slug: "acme" })
				yield* cloudflare.addForeignHostname("status.acme.com")

				yield* publishOwnership(dns, pageId, "status.acme.com")
				const result = yield* domains.set(ORG, pageId, "status.acme.com")
				assert.strictEqual(result.domain?.status, "failed")
				assert.isNull(result.domain?.cloudflareHostnameId ?? null)
				assert.include(result.domain?.lastError ?? "", "already set up with Cloudflare")
				assert.strictEqual((yield* cloudflare.routes).size, 0)
			}),
		),
	)

	it.effect("takes over the zone's hostname an earlier attempt created without recording it", () =>
		withDomains(({ testDb, cloudflare, dns, domains }) =>
			Effect.gen(function* () {
				const pageId = newPageId()
				yield* seedPage(testDb, { id: pageId, slug: "acme" })
				const earlier = yield* cloudflare.api.createHostname("status.acme.com")

				yield* publishOwnership(dns, pageId, "status.acme.com")
				const result = yield* domains.set(ORG, pageId, "status.acme.com")
				assert.strictEqual(result.domain?.status, "pending_dns")
				assert.strictEqual(result.domain?.cloudflareHostnameId, earlier.id)
				assert.strictEqual((yield* cloudflare.hostnames).size, 1)
			}),
		),
	)

	it.effect("a check racing another keeps the hostname the other created", () =>
		Effect.gen(function* () {
			const race = yield* interleave
			yield* withDomains(
				({ testDb, cloudflare, dns, domains }) =>
					Effect.gen(function* () {
						const pageId = newPageId()
						yield* seedPage(testDb, { id: pageId, slug: "acme" })
						// While set's check asks Cloudflare, a "Check now" creates the hostname first.
						yield* race.arm(domains.check(ORG, pageId))

						yield* publishOwnership(dns, pageId, "status.acme.com")
						const result = yield* domains.set(ORG, pageId, "status.acme.com")
						const id = yield* onlyHostnameId(cloudflare)
						assert.strictEqual((yield* cloudflare.hostnames).size, 1)
						assert.strictEqual(result.domain?.status, "pending_dns")
						assert.strictEqual(result.domain?.cloudflareHostnameId, id)
						assert.strictEqual((yield* domains.get(ORG, pageId)).domain?.cloudflareHostnameId, id)
						assert.deepStrictEqual(yield* cleanupRows(testDb), [])
					}),
				{
					api: (api) => ({
						...api,
						createHostname: (hostname) => race.before(api.createHostname(hostname)),
					}),
				},
			)
		}),
	)

	it.effect("queues what a check created when the domain was removed while it talked to Cloudflare", () =>
		Effect.gen(function* () {
			const midCall = yield* interleave
			yield* withDomains(
				({ testDb, cloudflare, dns, domains }) =>
					Effect.gen(function* () {
						const pageId = newPageId()
						yield* seedPage(testDb, { id: pageId, slug: "acme" })
						yield* midCall.arm(domains.remove(ORG, pageId))

						yield* publishOwnership(dns, pageId, "status.acme.com")
						const result = yield* domains.set(ORG, pageId, "status.acme.com")
						assert.isNull(result.domain)
						const id = yield* onlyHostnameId(cloudflare)
						const [routeId] = [...(yield* cloudflare.routes).keys()]
						assert.deepStrictEqual(yield* queuedCloudflareRemovals(testDb), [
							{
								hostname: "status.acme.com",
								cloudflare_hostname_id: id,
								cloudflare_route_id: routeId ?? null,
							},
						])
					}),
				{
					api: (api) => ({
						...api,
						createRoute: (hostname) => midCall.before(api.createRoute(hostname)),
					}),
				},
			)
		}),
	)

	it.effect("names the record to publish when the hostname is held by a claim nobody proved", () =>
		withDomains(({ testDb, cloudflare, domains }) =>
			Effect.gen(function* () {
				const pageId = newPageId()
				const otherPage = newPageId()
				yield* seedPage(testDb, { id: pageId, slug: "acme" })
				yield* seedPage(testDb, { id: otherPage, slug: "other" })
				yield* moveToOtherOrg(testDb, otherPage)
				const held = yield* domains.set(OTHER_ORG, otherPage, "status.acme.com")

				const refused = yield* Effect.flip(domains.set(ORG, pageId, "status.acme.com"))
				assert.strictEqual(refused._tag, "@maple/http/errors/StatusPageCustomDomainTakenError")
				const record = customDomainOwnershipRecord({
					orgId: ORG,
					pageId,
					hostname: "status.acme.com",
				})
				assert.include(refused.message, record.name)
				assert.include(refused.message, record.value)
				assert.deepStrictEqual((yield* domains.get(OTHER_ORG, otherPage)).domain, held.domain)
				assert.isNull((yield* domains.get(ORG, pageId)).domain)
				assert.strictEqual((yield* cloudflare.hostnames).size, 0)
			}),
		),
	)

	it.effect("a claim nobody proved gives way to the page whose ownership record is published", () =>
		withDomains(({ testDb, cloudflare, dns, domains }) =>
			Effect.gen(function* () {
				const pageId = newPageId()
				const otherPage = newPageId()
				yield* seedPage(testDb, { id: pageId, slug: "acme" })
				yield* seedPage(testDb, { id: otherPage, slug: "other" })
				yield* moveToOtherOrg(testDb, otherPage)
				yield* domains.set(OTHER_ORG, otherPage, "status.acme.com")
				yield* publishOwnership(dns, pageId, "status.acme.com")

				const claimed = yield* domains.set(ORG, pageId, "status.acme.com")
				assert.strictEqual(claimed.domain?.hostname, "status.acme.com")
				assert.isNotNull(claimed.domain?.cloudflareHostnameId ?? null)
				assert.isNull((yield* domains.get(OTHER_ORG, otherPage)).domain)
				assert.deepStrictEqual(
					Arr.map(yield* domainRows(testDb), (row) => row.page_id),
					[pageId],
				)
				// The claim that gave way is taken down like any removed domain.
				assert.deepStrictEqual(
					Arr.map(yield* cleanupRows(testDb), (row) => row.page_id),
					[otherPage],
				)
				assert.strictEqual((yield* cloudflare.hostnames).size, 1)
			}),
		),
	)

	it.effect("does not take over a hostname another organization's removal still has queued", () =>
		withDomains(({ testDb, cloudflare, dns, domains }) =>
			Effect.gen(function* () {
				const pageId = newPageId()
				const otherPage = newPageId()
				yield* seedPage(testDb, { id: pageId, slug: "acme" })
				yield* seedPage(testDb, { id: otherPage, slug: "other" })
				yield* moveToOtherOrg(testDb, otherPage)
				yield* publishOwnership(dns, otherPage, "status.acme.com", OTHER_ORG)
				yield* domains.set(OTHER_ORG, otherPage, "status.acme.com")
				const id = yield* onlyHostnameId(cloudflare)
				yield* domains.remove(OTHER_ORG, otherPage)

				const result = yield* domains.set(ORG, pageId, "status.acme.com")
				assert.strictEqual(result.domain?.status, "pending_dns")
				assert.isNull(result.domain?.cloudflareHostnameId ?? null)
				assert.isNull(result.domain?.cloudflareRouteId ?? null)
				// The other organization's teardown keeps what it has to remove.
				assert.deepStrictEqual(
					Arr.map(yield* queuedCloudflareRemovals(testDb), (row) => row.cloudflare_hostname_id),
					[id],
				)
			}),
		),
	)

	it.effect("drops a claim that never went live within a week, freeing the hostname", () =>
		withDomains(({ testDb, domains }) =>
			Effect.gen(function* () {
				const squatter = newPageId()
				const recent = newPageId()
				const live = newPageId()
				const owner = newPageId()
				yield* seedPage(testDb, { id: squatter, slug: "squatter" })
				yield* seedPage(testDb, { id: recent, slug: "recent" })
				yield* seedPage(testDb, { id: live, slug: "live" })
				yield* seedPage(testDb, { id: owner, slug: "acme" })
				yield* seedCustomDomain(testDb, {
					pageId: squatter,
					hostname: "status.acme.com",
					status: "failed",
					cloudflareHostnameId: "cfh-squatter",
					createdAt: NOW - 8 * DAY_MS,
				})
				yield* seedCustomDomain(testDb, {
					pageId: recent,
					hostname: "status.recent.com",
					status: "pending_dns",
					createdAt: NOW - 6 * DAY_MS,
				})
				yield* seedCustomDomain(testDb, {
					pageId: live,
					hostname: "status.live.com",
					status: "active",
					createdAt: NOW - 30 * DAY_MS,
				})
				yield* Effect.promise(() =>
					executeSql(
						testDb,
						`UPDATE status_page_custom_domains SET activated_at = now() WHERE page_id = $1`,
						[live],
					),
				)

				assert.strictEqual((yield* domains.poll(NOW)).expired, 1)
				assert.sameMembers(
					Arr.map(yield* domainRows(testDb), (row) => row.hostname),
					["status.recent.com", "status.live.com"],
				)
				assert.deepStrictEqual(yield* queuedCloudflareRemovals(testDb), [
					{
						hostname: "status.acme.com",
						cloudflare_hostname_id: "cfh-squatter",
						cloudflare_route_id: null,
					},
				])
				const claimed = yield* domains.set(ORG, owner, "status.acme.com")
				assert.strictEqual(claimed.domain?.hostname, "status.acme.com")
			}),
		),
	)

	it.effect("checks a pending domain that is due even behind many settled ones checked longer ago", () =>
		withDomains(({ testDb, domains }) =>
			Effect.gen(function* () {
				yield* Effect.forEach(
					Arr.range(1, 100),
					(n) =>
						Effect.gen(function* () {
							const pageId = newPageId()
							yield* seedPage(testDb, { id: pageId, slug: `settled-${n}` })
							yield* seedCustomDomain(testDb, {
								pageId,
								hostname: `status.settled-${n}.com`,
								status: "active",
								lastCheckedAt: NOW - 2 * 60 * 60_000,
							})
						}),
					{ discard: true },
				)
				const pending = newPageId()
				yield* seedPage(testDb, { id: pending, slug: "pending" })
				yield* seedCustomDomain(testDb, {
					pageId: pending,
					hostname: "status.pending.com",
					status: "pending_dns",
					lastCheckedAt: NOW - 30 * 60_000,
				})

				assert.strictEqual((yield* domains.poll(NOW)).checked, 1)
				assert.strictEqual((yield* domains.get(ORG, pending)).domain?.lastCheckedAt, NOW)
			}),
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
