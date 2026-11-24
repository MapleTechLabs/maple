// BOUNDARY-FILE: The fake HTTP service models JSON documents owned by the Maple API.
import { describe, it } from "@effect/vitest"
import { expect } from "vitest"
import { Effect, Layer, Option, Redacted, Schema, Array as Arr, Record as Rec, String as Str } from "effect"
import { noopSession } from "alchemy/Report"
import { StatusPage, StatusPageProvider, type StatusPageProps } from "../src/StatusPage"
import { MapleApi, type MapleApiContract } from "../src/MapleApi"
import { makeMapleApiResponseError, MapleErrorTags, type MapleError } from "../src/errors"

const decodeBody = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))

interface Component {
	id: string
	name: string
	manual_status: string | null
	[key: string]: unknown
}

/** A one-page fake of the v2 status page endpoints, with the API's ordering rules. */
const makeFake = () => {
	const calls: Array<string> = []
	let page: {
		id: string
		name: string
		slug: string
		has_password: boolean
		draft: boolean
		visibility: string
	} | null = null
	let components: Array<Component> = []
	const config = new Map<string, unknown>()
	let hostname: string | null = null
	let sequence = 0
	let revision = 0
	let afterConfigRead: (() => void) | undefined
	let refuseConfig = false
	let password: string | null = null
	const notFound = () =>
		makeMapleApiResponseError(404, {
			_tag: MapleErrorTags.statusPageNotFound,
			type: "not_found_error",
			code: "resource_missing",
			title: "Not found",
			message: "Status page not found",
			retryable: false,
			recovery: "none",
		})
	const invalid = (message: string) =>
		makeMapleApiResponseError(400, {
			_tag: "@maple/http/errors/StatusPageValidationError",
			type: "invalid_request_error",
			code: "invalid_request",
			title: "Invalid",
			message,
			retryable: false,
			recovery: "fix_request",
		})
	const configDoc = () => ({
		...Rec.fromEntries([...config]),
		version: `v${revision}`,
		components: structuredClone(components),
	})
	const domainDoc = () => ({
		object: "status_page_custom_domain",
		cname_target: "status-domains.maple.test",
		hostname,
		dns_records:
			hostname === null
				? []
				: [
						{
							type: "CNAME",
							name: hostname,
							value: "status-domains.maple.test",
							purpose: "routing",
						},
					],
	})
	const route = (method: string, path: string, body?: unknown): Effect.Effect<unknown, MapleError> => {
		calls.push(`${method} ${Str.split(path, "?")[0]}`)
		if (method === "POST" && path === "/v2/status_pages") {
			const input = decodeBody(body)
			page = {
				id: `stp_${++sequence}`,
				name: String(input.name),
				slug: String(input.slug),
				has_password: false,
				draft: input.publish === false,
				visibility: "public",
			}
			config.clear()
			config.set("name", page.name).set("slug", page.slug).set("visibility", "public")
			return Effect.succeed({ ...page })
		}
		if (page === null || !Str.startsWith(`/v2/status_pages/${page.id}`)(path))
			return Effect.fail(notFound())
		const [rest, query = ""] = Str.split(Str.slice(`/v2/status_pages/${page.id}`.length)(path), "?")
		const ifVersion = new URLSearchParams(query).get("if_version")
		switch (`${method} ${rest}`) {
			case "GET ":
				return Effect.succeed({ ...page })
			case "DELETE ":
				page = null
				password = null
				return Effect.succeed({ deleted: true })
			case "GET /config": {
				const doc = configDoc()
				afterConfigRead?.()
				afterConfigRead = undefined
				return Effect.succeed(doc)
			}
			case "PUT /config": {
				if (refuseConfig) return Effect.fail(invalid("Theme contrast too low"))
				if (ifVersion !== null && ifVersion !== `v${revision}`)
					return Effect.fail(
						makeMapleApiResponseError(409, {
							_tag: MapleErrorTags.statusPageConflict,
							type: "conflict_error",
							code: "status_page_conflict",
							title: "Conflict",
							message: "The page's config changed since it was read",
							retryable: false,
							recovery: "refresh",
						}),
					)
				revision++
				const input = decodeBody(body)
				const visibility = (input.visibility as string | undefined) ?? page.visibility
				if (visibility === "password" && !page.has_password)
					return Effect.fail(invalid("Set a page password first"))
				if (visibility === "internal" && hostname !== null)
					return Effect.fail(invalid("Remove the custom domain first"))
				const listed = input.components as Array<Record<string, unknown>>
				components = Arr.map(listed, (component) => ({
					...component,
					id: (component.id as string | undefined) ?? `stc_${++sequence}`,
					name: Str.trim(String(component.name)),
					manual_status: (component.manual_status as string | null | undefined) ?? null,
				}))
				const { components: _components, ...rest } = input
				config.clear()
				for (const [key, value] of Rec.toEntries({ ...rest, visibility })) config.set(key, value)
				page.visibility = visibility
				sequence++
				return Effect.succeed(configDoc())
			}
			case "PUT /password":
				password = String(decodeBody(body).password)
				page.has_password = true
				return Effect.succeed({ ...page })
			case "DELETE /password":
				if (page.visibility === "password") return Effect.fail(invalid("Make the page public first"))
				page.has_password = false
				password = null
				return Effect.succeed({ ...page })
			case "GET /custom_domain":
				return Effect.succeed(domainDoc())
			case "PUT /custom_domain":
				hostname = String(decodeBody(body).hostname)
				return Effect.succeed(domainDoc())
			case "DELETE /custom_domain":
				hostname = null
				return Effect.succeed(domainDoc())
			case "POST /publish":
				page.draft = false
				return Effect.succeed({ outcome: "published" })
		}
		return Effect.fail(notFound())
	}
	const api: MapleApiContract = {
		get: (path) => Effect.suspend(() => route("GET", path)),
		post: (path, body) => Effect.suspend(() => route("POST", path, body)),
		patch: (path, body) => Effect.suspend(() => route("PATCH", path, body)),
		put: (path, body) => Effect.suspend(() => route("PUT", path, body)),
		delete: (path) => Effect.suspend(() => route("DELETE", path)),
		upload: (path) => Effect.die(`unexpected upload ${path}`),
	}
	return {
		api,
		calls,
		page: () => page,
		password: () => password,
		components: () => components,
		setManualStatus: (name: string, status: string) => {
			components = Arr.map(components, (c) => (c.name === name ? { ...c, manual_status: status } : c))
			revision++
		},
		/** Runs `edit` right after the next config read, as a responder racing a deploy. */
		afterNextConfigRead: (edit: () => void) => {
			afterConfigRead = edit
		},
		refuseConfig: () => {
			refuseConfig = true
		},
		allowConfig: () => {
			refuseConfig = false
		},
	}
}

const reconcile = (
	fake: ReturnType<typeof makeFake>,
	news: StatusPageProps,
	previous?: { olds: StatusPageProps; output: StatusPage["Attributes"] },
) =>
	Effect.gen(function* () {
		const provider = yield* StatusPage.Provider
		return yield* provider.reconcile({
			id: "status",
			fqn: "test/status",
			instanceId: "i-1",
			news,
			olds: previous?.olds,
			output: previous?.output,
			session: noopSession,
			bindings: [],
		})
	}).pipe(Effect.provide(StatusPageProvider().pipe(Layer.provide(Layer.succeed(MapleApi, fake.api)))))

const base: StatusPageProps = {
	name: "Acme Status",
	slug: "acme-status",
	components: [{ name: "API" }, { name: "Dashboard", group: "Web" }],
}

describe("StatusPageProvider", () => {
	it.live("creates a draft, configures it, then publishes it", () =>
		Effect.gen(function* () {
			const fake = makeFake()
			const attributes = yield* reconcile(fake, {
				...base,
				visibility: "password",
				password: Redacted.make("correct horse battery"),
				custom_domain: "status.acme.com",
			})
			expect(fake.calls).toEqual([
				"POST /v2/status_pages",
				"PUT /v2/status_pages/stp_1/password",
				"GET /v2/status_pages/stp_1/custom_domain",
				"GET /v2/status_pages/stp_1/config",
				"PUT /v2/status_pages/stp_1/config",
				"PUT /v2/status_pages/stp_1/custom_domain",
				"POST /v2/status_pages/stp_1/publish",
			])
			expect(fake.page()).toMatchObject({
				draft: false,
				visibility: "password",
				has_password: true,
			})
			expect(Arr.map(attributes.components, (c) => c.name)).toEqual(["API", "Dashboard"])
			expect(attributes.customDomain).toMatchObject({
				hostname: "status.acme.com",
				dnsRecords: [{ type: "CNAME", name: "status.acme.com", purpose: "routing" }],
			})
		}),
	)

	it.live("keeps component IDs by name and leaves an unset manual status as responders set it", () =>
		Effect.gen(function* () {
			const fake = makeFake()
			const first = yield* reconcile(fake, base)
			const apiId = first.components[0]?.componentId
			fake.setManualStatus("API", "degraded")
			const next: StatusPageProps = {
				...base,
				components: [{ name: "Docs" }, { name: "API", description: "Public API" }],
			}
			const second = yield* reconcile(fake, next, {
				olds: base,
				output: first,
			})
			expect(second.components).toEqual([
				{ componentId: expect.any(String), name: "Docs" },
				{ componentId: apiId, name: "API" },
			])
			expect(
				Option.getOrUndefined(Arr.findFirst(fake.components(), (c) => c.name === "API"))
					?.manual_status,
			).toBe("degraded")
			const cleared = yield* reconcile(
				fake,
				{ ...next, components: [{ name: "API", manual_status: null }] },
				{ olds: next, output: second },
			)
			expect(cleared.components).toEqual([{ componentId: apiId, name: "API" }])
			expect(fake.components()[0]?.manual_status).toBeNull()
		}),
	)

	it.live("turns a password page internal: domain off before the config, password off after it", () =>
		Effect.gen(function* () {
			const fake = makeFake()
			const olds: StatusPageProps = {
				...base,
				visibility: "password",
				password: "correct horse battery",
				custom_domain: "status.acme.com",
			}
			const output = yield* reconcile(fake, olds)
			fake.calls.length = 0
			const internal = yield* reconcile(fake, { ...base, visibility: "internal" }, { olds, output })
			expect(Arr.filter(fake.calls, (call) => !Str.startsWith("GET")(call))).toEqual([
				"DELETE /v2/status_pages/stp_1/custom_domain",
				"PUT /v2/status_pages/stp_1/config",
				"DELETE /v2/status_pages/stp_1/password",
			])
			expect(fake.page()).toMatchObject({
				visibility: "internal",
				has_password: false,
			})
			expect(fake.password()).toBeNull()
			expect(internal.customDomain).toBeNull()
		}),
	)

	it.live("recreates a page deleted outside Alchemy", () =>
		Effect.gen(function* () {
			const fake = makeFake()
			const output = yield* reconcile(fake, base)
			yield* Effect.gen(function* () {
				const provider = yield* StatusPage.Provider
				yield* provider.delete({
					id: "status",
					fqn: "test/status",
					instanceId: "i-1",
					olds: base,
					output,
					session: noopSession,
					bindings: [],
				})
				expect(
					yield* provider.read!({
						id: "status",
						fqn: "test/status",
						instanceId: "i-1",
						olds: base,
						output,
					}),
				).toBeUndefined()
			}).pipe(
				Effect.provide(StatusPageProvider().pipe(Layer.provide(Layer.succeed(MapleApi, fake.api)))),
			)
			const recreated = yield* reconcile(fake, base, { olds: base, output })
			expect(recreated.statusPageId).not.toBe(output.statusPageId)
			expect(fake.page()?.id).toBe(recreated.statusPageId)
			expect(fake.page()?.draft).toBe(false)
		}),
	)

	it.live("re-reads the config when a responder changes a status mid-deploy", () =>
		Effect.gen(function* () {
			const fake = makeFake()
			const output = yield* reconcile(fake, base)
			fake.afterNextConfigRead(() => fake.setManualStatus("API", "major_outage"))
			const next = { ...base, description: "Live status" }
			yield* reconcile(fake, next, { olds: base, output })
			expect(
				Option.getOrUndefined(Arr.findFirst(fake.components(), (c) => c.name === "API"))
					?.manual_status,
			).toBe("major_outage")
		}),
	)

	it.live("deletes a page it created but could not configure, so a retry can reuse the slug", () =>
		Effect.gen(function* () {
			const fake = makeFake()
			fake.refuseConfig()
			const exit = yield* Effect.exit(reconcile(fake, base))
			expect(exit._tag).toBe("Failure")
			expect(fake.page()).toBeNull()
			expect(fake.calls).toContain("DELETE /v2/status_pages/stp_1")
		}),
	)

	it.live("matches a component written with surrounding spaces to its stored, trimmed name", () =>
		Effect.gen(function* () {
			const fake = makeFake()
			const props: StatusPageProps = { ...base, components: [{ name: " API " }] }
			const first = yield* reconcile(fake, props)
			const second = yield* reconcile(
				fake,
				{ ...props, description: "x" },
				{ olds: props, output: first },
			)
			expect(second.components[0]?.componentId).toBe(first.components[0]?.componentId)
		}),
	)

	it.live("plans an update when a manual status goes from unset to null", () =>
		Effect.gen(function* () {
			const provider = yield* StatusPage.Provider
			const olds: StatusPageProps = { ...base, components: [{ name: "API" }] }
			const news: StatusPageProps = { ...base, components: [{ name: "API", manual_status: null }] }
			const result = yield* provider.diff!({
				id: "status",
				fqn: "test/status",
				instanceId: "i-1",
				olds,
				news,
				output: undefined,
				oldBindings: [],
				newBindings: [],
			})
			expect(result?.action).toBe("update")
		}).pipe(
			Effect.provide(StatusPageProvider().pipe(Layer.provide(Layer.succeed(MapleApi, makeFake().api)))),
		),
	)

	it.live("rotates a password after the config, so a failed deploy keeps the old one", () =>
		Effect.gen(function* () {
			const fake = makeFake()
			const olds: StatusPageProps = {
				...base,
				visibility: "password",
				password: "correct horse battery",
			}
			const output = yield* reconcile(fake, olds)
			fake.calls.length = 0
			const rotated = { ...olds, password: "another long secret" }
			fake.refuseConfig()
			const failed = yield* Effect.exit(reconcile(fake, rotated, { olds, output }))
			expect(failed._tag).toBe("Failure")
			expect(fake.password()).toBe("correct horse battery")
			fake.allowConfig()
			yield* reconcile(fake, rotated, { olds, output })
			expect(fake.password()).toBe("another long secret")
		}),
	)

	it.live("sets a new password before an internal page turns password-protected", () =>
		Effect.gen(function* () {
			const fake = makeFake()
			const olds: StatusPageProps = {
				...base,
				visibility: "internal",
				password: "correct horse battery",
			}
			const output = yield* reconcile(fake, olds)
			fake.calls.length = 0
			const news: StatusPageProps = { ...base, visibility: "password", password: "another long secret" }
			yield* reconcile(fake, news, { olds, output })
			expect(Arr.filter(fake.calls, (call) => !Str.startsWith("GET")(call))).toEqual([
				"PUT /v2/status_pages/stp_1/password",
				"PUT /v2/status_pages/stp_1/config",
			])
			expect(fake.password()).toBe("another long secret")
		}),
	)

	it.live("rotates the password of a page that stays internal after the config", () =>
		Effect.gen(function* () {
			const fake = makeFake()
			const olds: StatusPageProps = {
				...base,
				visibility: "internal",
				password: "correct horse battery",
			}
			const output = yield* reconcile(fake, olds)
			fake.refuseConfig()
			const failed = yield* Effect.exit(
				reconcile(fake, { ...olds, password: "another long secret" }, { olds, output }),
			)
			expect(failed._tag).toBe("Failure")
			expect(fake.password()).toBe("correct horse battery")
			fake.allowConfig()
			fake.calls.length = 0
			yield* reconcile(fake, { ...olds, password: "another long secret" }, { olds, output })
			expect(Arr.filter(fake.calls, (call) => !Str.startsWith("GET")(call))).toEqual([
				"PUT /v2/status_pages/stp_1/config",
				"PUT /v2/status_pages/stp_1/password",
			])
			expect(fake.password()).toBe("another long secret")
		}),
	)

	it.live("sets a first password after the config when the page stays public", () =>
		Effect.gen(function* () {
			const fake = makeFake()
			const output = yield* reconcile(fake, base)
			fake.refuseConfig()
			const failed = yield* Effect.exit(
				reconcile(fake, { ...base, password: "correct horse battery" }, { olds: base, output }),
			)
			expect(failed._tag).toBe("Failure")
			expect(fake.password()).toBeNull()
		}),
	)

	it.live("moves the page to a new custom domain", () =>
		Effect.gen(function* () {
			const fake = makeFake()
			const olds: StatusPageProps = { ...base, custom_domain: "status.acme.com" }
			const output = yield* reconcile(fake, olds)
			const moved = yield* reconcile(
				fake,
				{ ...base, custom_domain: "status.acme.io" },
				{ olds, output },
			)
			expect(moved.customDomain?.hostname).toBe("status.acme.io")
		}),
	)
})
