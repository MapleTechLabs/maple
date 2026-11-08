import { Array as Arr, Effect, Layer, Order, String as Str } from "effect"
import { HttpClient, HttpClientResponse, UrlParams } from "effect/http"
import { CLERK_API_URL } from "./http"
import { type FakeClerkOrganization, type FakeClerkUser, userWire } from "./testing-seed"

export * from "./testing-seed"

/** What the fake serves and what it saw. Mutate `throttleAfter` to simulate the shared limit. */
export interface FakeClerk {
	readonly secretKey: string
	readonly users: ReadonlyArray<FakeClerkUser>
	readonly organizations: ReadonlyArray<FakeClerkOrganization>
	/** Calls served before every further call answers 429 with `Retry-After: 7`. */
	throttleAfter: number | null
	readonly calls: Array<{
		readonly path: string
		readonly params: ReadonlyArray<readonly [string, string]>
	}>
	/** Every request's Authorization header, to prove the key goes only there. */
	readonly authHeaders: Array<string>
}

export const makeFakeClerk = (options: {
	readonly secretKey: string
	readonly users: ReadonlyArray<FakeClerkUser>
	readonly organizations?: ReadonlyArray<FakeClerkOrganization>
	readonly throttleAfter?: number
}): FakeClerk => ({
	secretKey: options.secretKey,
	users: options.users,
	organizations: options.organizations ?? [],
	throttleAfter: options.throttleAfter ?? null,
	calls: [],
	authHeaders: [],
})

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
	Response.json(body, { status, headers })

const clerkError = (status: number, message: string) =>
	json(status, { errors: [{ message, long_message: message, code: "fake" }] })

const num = (params: UrlParams.UrlParams, key: string): number | null => {
	const raw = UrlParams.getFirst(params, key)
	return raw._tag === "None" ? null : Number(raw.value)
}

/** Clerk's `*_after` / `*_before` read as exclusive bounds; a missing value never matches a bound. */
const inRange = (params: UrlParams.UrlParams, name: string, value: number | null): boolean => {
	const after = num(params, `${name}_after`)
	const before = num(params, `${name}_before`)
	if (after === null && before === null) return true
	return value !== null && (after === null || value > after) && (before === null || value < before)
}

const oneOf = (params: UrlParams.UrlParams, key: string, value: string | null): boolean => {
	const wanted = UrlParams.getAll(params, key)
	return wanted.length === 0 || (value !== null && wanted.includes(value))
}

const partial = (params: UrlParams.UrlParams, key: string, value: string | null): boolean => {
	const query = UrlParams.getFirst(params, key)
	return (
		query._tag === "None" ||
		(value !== null && Str.includes(Str.toLowerCase(query.value))(Str.toLowerCase(value)))
	)
}

const matchingUsers = (fake: FakeClerk, p: UrlParams.UrlParams) =>
	Arr.filter(
		fake.users,
		(u) =>
			oneOf(p, "user_id", u.id) &&
			oneOf(p, "email_address", u.email) &&
			oneOf(p, "username", u.username) &&
			oneOf(p, "external_id", u.externalId) &&
			(UrlParams.getAll(p, "organization_id").length === 0 ||
				Arr.some(UrlParams.getAll(p, "organization_id"), (org) =>
					Arr.contains(u.organizationIds, org),
				)) &&
			partial(p, "email_address_query", u.email) &&
			partial(p, "username_query", u.username) &&
			oneOf(p, "banned", String(u.banned)) &&
			inRange(p, "created_at", u.createdAt) &&
			inRange(p, "last_active_at", u.lastActiveAt) &&
			inRange(p, "last_sign_in_at", u.lastSignInAt),
	)

const USER_ORDER = {
	created_at: (u) => u.createdAt,
	updated_at: (u) => u.updatedAt,
	last_active_at: (u) => u.lastActiveAt ?? 0,
	last_sign_in_at: (u) => u.lastSignInAt ?? 0,
	username: (u) => u.username ?? "",
	email_address: (u) => u.email,
} satisfies Record<string, (u: FakeClerkUser) => number | string>
const ORG_ORDER = {
	created_at: (o) => o.createdAt,
	name: (o) => o.name,
} satisfies Record<string, (o: FakeClerkOrganization) => number | string>

/** `order_by` (default `-created_at`), then `offset` and `limit` (default 10, max 500), like Clerk. */
const page = <A>(
	rows: ReadonlyArray<A>,
	p: UrlParams.UrlParams,
	keys: Readonly<Record<string, (a: A) => number | string>>,
) => {
	const raw = UrlParams.getFirst(p, "order_by")
	const orderBy = raw._tag === "None" ? "-created_at" : raw.value
	const desc = Str.startsWith("-")(orderBy)
	const key = keys[Str.replace(/^[+-]/, "")(orderBy)]
	if (key === undefined) return null
	const byKey = Order.mapInput(
		Order.make<number | string>((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
		key,
	)
	const sorted = Arr.sort(rows, desc ? Order.flip(byKey) : byKey)
	const offset = num(p, "offset") ?? 0
	return Arr.take(Arr.drop(sorted, offset), num(p, "limit") ?? 10)
}

const serve = (fake: FakeClerk, path: string, p: UrlParams.UrlParams): Response => {
	const limit = num(p, "limit")
	if (limit !== null && (limit < 1 || limit > 500))
		return clerkError(422, "limit must be between 1 and 500")
	if (path === "/users/count")
		return json(200, { object: "total_count", total_count: matchingUsers(fake, p).length })
	if (path === "/users") {
		const rows = page(matchingUsers(fake, p), p, USER_ORDER)
		return rows === null ? clerkError(422, "invalid order_by") : json(200, Arr.map(rows, userWire))
	}
	if (path === "/organizations") {
		const matching = Arr.filter(fake.organizations, (o) => oneOf(p, "organization_id", o.id))
		const rows = page(matching, p, ORG_ORDER)
		const withCount = (o: FakeClerkOrganization) => ({
			object: "organization",
			id: o.id,
			name: o.name,
			slug: o.slug,
			created_at: o.createdAt,
			updated_at: o.updatedAt,
			members_count: Arr.filter(fake.users, (u) => Arr.contains(u.organizationIds, o.id)).length,
		})
		return rows === null
			? clerkError(422, "invalid order_by")
			: json(200, { data: Arr.map(rows, withCount), total_count: matching.length })
	}
	return clerkError(404, "not found")
}

/** An `HttpClient` that answers like Clerk's Backend API for the seeded data. Deterministic. */
export const fakeClerkHttpClient = (fake: FakeClerk) =>
	Layer.succeed(
		HttpClient.HttpClient,
		HttpClient.make((request, url) =>
			Effect.sync(() => {
				const path = Str.startsWith(CLERK_API_URL)(url.href)
					? Str.replace(/^\/v1/, "")(url.pathname)
					: url.pathname
				const auth = request.headers["authorization"] ?? ""
				fake.authHeaders.push(auth)
				fake.calls.push({
					path,
					params: Arr.map(
						request.urlParams.params,
						([k, v]) => [k, typeof v === "string" ? v : "<redacted>"] as const,
					),
				})
				const throttled = fake.throttleAfter !== null && fake.calls.length > fake.throttleAfter
				const response =
					request.method !== "GET"
						? clerkError(405, "method not allowed")
						: auth !== `Bearer ${fake.secretKey}`
							? clerkError(401, "The provided Clerk Secret Key is invalid.")
							: throttled
								? json(
										429,
										{ errors: [{ message: "Too many requests" }] },
										{ "retry-after": "7" },
									)
								: serve(fake, path, request.urlParams)
				return HttpClientResponse.fromWeb(request, response)
			}),
		),
	)
