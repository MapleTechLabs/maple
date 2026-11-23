// A fake Fleet server for tests, answering the `/api/v1/fleet/*` reads Maple makes from a mutable
// world, with every request recorded. Its policy and fleet paths follow `version`, as real servers
// do: `/teams` before 4.82, `/fleets` from it, and only `/policies` from Fleet 5 (410 on the rest).
import { Array as Arr, Layer, Order, String as Str } from "effect"
import { FetchHttpClient } from "effect/http"
import { Env } from "@maple/backend/platform/Env"
import type { TestDb } from "@maple/backend/testing/test-pglite"
import * as VendorFake from "@maple/backend/testing/vendor-fake"
import { fakeCostEnvConfig } from "../../cost/providers/fake-cost-env"

export const FAKE_FLEET_URL = "https://fleet.example.com"
export const FAKE_FLEET_TOKEN = "fleet-api-token-0123456789"

export interface FakeFleetActivity {
	readonly id: number
	readonly created_at: string
	readonly type: string
	readonly actor_full_name?: string | null
	readonly actor_id?: number | null
	readonly actor_email?: string | null
	readonly fleet_initiated?: boolean
	readonly details?: Readonly<Record<string, unknown>> | null
}

export interface FakeFleetPolicy {
	readonly id: number
	readonly name: string
	readonly critical?: boolean
	readonly failing_host_count: number
	readonly passing_host_count: number
	readonly resolution?: string
}

export interface FakeFleetSoftware {
	readonly id: number
	readonly name: string
	readonly version: string
	readonly hosts_count: number
	readonly vulnerabilities: ReadonlyArray<{ readonly cve: string; readonly cvss_score?: number | null }>
}

export interface FakeFleet {
	/** Answers every request with this status instead, when set. */
	status: number | null
	globalRole: string | null
	version: string
	orgName: string
	tier: string
	activities: Array<FakeFleetActivity>
	/** An older server that pages from the start whatever `after` says. */
	ignoresAfter: boolean
	hostCount: number
	/** The global policies. */
	policies: Array<FakeFleetPolicy>
	/** The server's fleets; null is Fleet Free, which has none and answers 402. */
	fleets: Array<{ readonly id: number; readonly name: string }> | null
	/** Each fleet's own policies, by fleet id; 0 holds those of devices in no fleet. */
	fleetPolicies: Record<number, ReadonlyArray<FakeFleetPolicy>>
	/** Fleets still listed whose policies answer 404: deleted between the two reads. */
	vanishedFleets: ReadonlyArray<number>
	/** The devices failing each policy, by policy id. */
	failingHosts: Record<number, ReadonlyArray<{ readonly id: number; readonly hostname: string }>>
	software: Array<FakeFleetSoftware>
	/**
	 * How the policies list pages: a first page of 100 when no `per_page` is sent (a default the
	 * docs do not rule out), or every policy whatever is asked.
	 */
	policyPaging: "default-100" | "ignored"
	/** Fleet's own CVE rows (`/vulnerabilities`), each counting a device once; null answers 404, as older servers do. */
	cves: Array<{
		readonly cve: string
		readonly hosts_count: number
		readonly cvss_score?: number
		readonly details_link?: string
	}> | null
	readonly fake: VendorFake.VendorFake
}

/** Matched as a suffix: a server can sit under a path prefix. */
const PREFIX = "/api/v1/fleet"

type Era = "teams" | "fleets" | "fleet5"

const eraOf = (version: string): Era => {
	const [, major, minor] = /^(\d+)\.(\d+)/.exec(version) ?? []
	return Number(major) >= 5 ? "fleet5" : Number(minor) >= 82 ? "fleets" : "teams"
}

/** Fleet 5's answer on a path it removed. */
const gone = (endpoint: string) =>
	VendorFake.json(
		{
			message: "Gone",
			errors: [
				{
					name: "base",
					reason: `The "GET ${endpoint}" endpoint is not available anymore. What to use instead: https://fleetdm.com/learn-more-about/fleet-5-upgrade`,
				},
			],
		},
		410,
	)

/** A path this version never had: the router's own plain 404. */
const noRoute = () => VendorFake.text("404 page not found", 404)

const needsPremium = () =>
	VendorFake.json(
		{ message: "Payment Required", errors: [{ name: "base", reason: "Requires Fleet Premium license" }] },
		402,
	)

const paged = <A>(rows: ReadonlyArray<A>, search: URLSearchParams, defaultPerPage: number) => {
	const perPage = Number(search.get("per_page") ?? String(defaultPerPage))
	const page = Number(search.get("page") ?? "0")
	return rows.slice(page * perPage, (page + 1) * perPage)
}

const policiesPage = (world: FakeFleet, policies: ReadonlyArray<FakeFleetPolicy>, search: URLSearchParams) =>
	world.policyPaging === "ignored" ? policies : paged(policies, search, 100)

/** A fleet's own policies, or undefined when the server has no such fleet. */
const policiesOfFleet = (world: FakeFleet, id: number): ReadonlyArray<FakeFleetPolicy> | undefined =>
	Arr.contains(world.vanishedFleets, id) ||
	(id !== 0 && !Arr.some(world.fleets ?? [], (fleet) => fleet.id === id))
		? undefined
		: (world.fleetPolicies[id] ?? [])

const fleetNotFound = (id: number) =>
	VendorFake.json(
		{
			message: "Resource Not Found",
			errors: [{ name: "base", reason: `Fleet ${id} was not found in the datastore` }],
		},
		404,
	)

/** `GET /activities` as Fleet pages it: `order_key=id` with `after` is a keyset cursor. */
const activitiesPage = (world: FakeFleet, search: URLSearchParams) => {
	const after = world.ignoresAfter ? null : search.get("after")
	const start = search.get("start_created_at")
	const perPage = Number(search.get("per_page") ?? "10000")
	const matching = Arr.sort(
		Arr.filter(
			world.activities,
			(activity) =>
				(after === null || activity.id > Number(after)) &&
				(start === null || activity.created_at >= start),
		),
		search.get("order_direction") === "desc"
			? Order.mapInput(Order.flip(Order.Number), (activity: FakeFleetActivity) => activity.id)
			: Order.mapInput(Order.Number, (activity: FakeFleetActivity) => activity.id),
	)
	const offset = Number(search.get("page") ?? "0") * perPage
	const page = matching.slice(offset, offset + perPage)
	return {
		// Fleet leaves an empty list out, as Go's omitempty does.
		...(page.length === 0 ? undefined : { activities: page }),
		meta: {
			has_next_results: matching.length > offset + perPage,
			has_previous_results: after !== null || offset > 0,
		},
	}
}

export const makeFakeFleet = (overrides: Partial<Omit<FakeFleet, "fake">> = {}): FakeFleet => {
	const world: FakeFleet = {
		status: null,
		globalRole: "observer",
		version: "4.62.0",
		orgName: "Acme Corp",
		tier: "free",
		activities: [],
		ignoresAfter: false,
		hostCount: 0,
		policies: [],
		fleets: null,
		fleetPolicies: {},
		vanishedFleets: [],
		failingHosts: {},
		software: [],
		policyPaging: "default-100",
		cves: null,
		...overrides,
		fake: VendorFake.make({
			routes: [
				{
					respond: () =>
						world.status === null
							? undefined
							: VendorFake.json(
									{ message: "refused", errors: [{ reason: "refused" }] },
									world.status,
								),
				},
				{
					path: new RegExp(`${PREFIX}/me$`),
					respond: () =>
						VendorFake.json({
							user: {
								id: 7,
								name: "Maple reader",
								email: "maple@acme.test",
								global_role: world.globalRole,
								api_only: true,
							},
						}),
				},
				{
					path: new RegExp(`${PREFIX}/version$`),
					respond: () => VendorFake.json({ version: world.version }),
				},
				{
					path: new RegExp(`${PREFIX}/config$`),
					respond: () =>
						VendorFake.json({
							org_info: { org_name: world.orgName },
							license: { tier: world.tier },
						}),
				},
				{
					path: new RegExp(`${PREFIX}/hosts/count$`),
					respond: () => VendorFake.json({ count: world.hostCount }),
				},
				{
					path: new RegExp(`${PREFIX}/global/policies$`),
					respond: (request) => {
						if (eraOf(world.version) === "fleet5") return gone("/global/policies")
						const policies = policiesPage(world, world.policies, request.search)
						// Fleet 4 leaves an empty list out, as Go's omitempty does.
						return VendorFake.json(policies.length === 0 ? {} : { policies })
					},
				},
				{
					// Fleet 5: every scope from one path, `fleet_id` picking a fleet (0 for no fleet).
					path: new RegExp(`${PREFIX}/policies$`),
					respond: (request) => {
						if (eraOf(world.version) !== "fleet5") return noRoute()
						const fleetId = request.search.get("fleet_id")
						if (fleetId === null)
							return VendorFake.json({
								policies: policiesPage(world, world.policies, request.search),
							})
						if (world.fleets === null) return needsPremium()
						const own = policiesOfFleet(world, Number(fleetId))
						return own === undefined
							? fleetNotFound(Number(fleetId))
							: VendorFake.json({ policies: policiesPage(world, own, request.search) })
					},
				},
				{
					path: new RegExp(`${PREFIX}/(fleets|teams)$`),
					respond: (request) => {
						const era = eraOf(world.version)
						const named = Str.endsWith("/fleets")(request.path) ? "fleets" : "teams"
						if (era === "fleet5" && named === "teams") return gone("/teams")
						if (era === "teams" && named === "fleets") return noRoute()
						if (world.fleets === null) return needsPremium()
						const fleets = paged(world.fleets, request.search, 100)
						return VendorFake.json({
							...(era === "fleet5" ? undefined : { teams: fleets }),
							...(era === "teams" ? undefined : { fleets }),
						})
					},
				},
				{
					// Fleet 4: a fleet's own policies, with the global ones beside them.
					path: new RegExp(`${PREFIX}/(fleets|teams)/\\d+/policies$`),
					respond: (request) => {
						const era = eraOf(world.version)
						const [, named = "", id = ""] =
							/\/(fleets|teams)\/(\d+)\/policies$/.exec(request.path) ?? []
						if (era === "fleet5") return gone(`/${named}/{fleet_id}/policies`)
						if (era === "teams" && named === "fleets") return noRoute()
						const own = policiesOfFleet(world, Number(id))
						if (own === undefined) return fleetNotFound(Number(id))
						const policies = policiesPage(world, own, request.search)
						return VendorFake.json({
							...(policies.length === 0 ? undefined : { policies }),
							...(world.policies.length === 0
								? undefined
								: { inherited_policies: world.policies }),
						})
					},
				},
				{
					path: new RegExp(`${PREFIX}/hosts$`),
					respond: (request) =>
						VendorFake.json({
							hosts: world.failingHosts[Number(request.search.get("policy_id"))] ?? [],
						}),
				},
				{
					path: new RegExp(`${PREFIX}/software/versions$`),
					respond: (request) => {
						const page = Number(request.search.get("page") ?? "0")
						const perPage = Number(request.search.get("per_page") ?? "100")
						const software = world.software.slice(page * perPage, (page + 1) * perPage)
						return VendorFake.json({
							...(software.length === 0 ? undefined : { software }),
							meta: { has_next_results: (page + 1) * perPage < world.software.length },
						})
					},
				},
				{
					path: new RegExp(`${PREFIX}/vulnerabilities$`),
					respond: (request) => {
						if (world.cves === null) return VendorFake.json({ message: "not found" }, 404)
						const page = Number(request.search.get("page") ?? "0")
						const perPage = Number(request.search.get("per_page") ?? "20")
						const sorted = Arr.sort(
							world.cves,
							Order.mapInput(
								Order.flip(Order.Number),
								(row: { readonly hosts_count: number }) => row.hosts_count,
							),
						)
						const rows = sorted.slice(page * perPage, (page + 1) * perPage)
						return VendorFake.json({
							...(rows.length === 0 ? undefined : { vulnerabilities: rows }),
							count: world.cves.length,
							meta: { has_next_results: (page + 1) * perPage < world.cves.length },
						})
					},
				},
				{
					path: new RegExp(`${PREFIX}/activities$`),
					respond: (request) => VendorFake.json(activitiesPage(world, request.search)),
				},
			],
		}),
	}
	return world
}

/** Everything the Fleet services need, over a test database and whatever answers their requests. */
export const fleetDeps = (testDb: TestDb, fetch: Layer.Layer<never>) =>
	Layer.mergeAll(FetchHttpClient.layer, testDb.layer, Env.layer).pipe(
		Layer.provide(fetch),
		Layer.provide(fakeCostEnvConfig()),
	)

/** {@link fleetDeps} over the fake. */
export const fakeFleetDeps = (testDb: TestDb, world: FakeFleet) => fleetDeps(testDb, world.fake.layer)
