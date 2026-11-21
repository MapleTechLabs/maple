// Pure request building for `maple get|post|put|patch` and `maple api`: the
// path, `-d` fields and `-H` headers turn into one request against the
// logged-in workspace's API, never another host.

import { Array as Arr, Option, Predicate, Record as Rec, Result, Schema, String as Str } from "effect"
import { encodeJson } from "@maple/local-server/json"
import { CliUsageError } from "../lib/errors"

export const API_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const
export type ApiMethod = (typeof API_METHODS)[number]

/** GET and DELETE carry `-d` fields in the query string; the rest send a JSON body. */
export const sendsBody = (method: ApiMethod): boolean => method !== "GET" && method !== "DELETE"

const decodeJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown))

export const parseJson = (text: string, what: string): Result.Result<unknown, CliUsageError> =>
	Result.mapError(
		decodeJson(text),
		() => new CliUsageError({ message: `${what} is not valid JSON`, hint: "check quoting and commas" }),
	)

/**
 * The URL for `path` on the workspace API. Only a path is accepted: an absolute
 * or protocol-relative URL would send the stored token to another host.
 */
export const resolveApiPath = (apiUrl: string, path: string): Result.Result<URL, CliUsageError> => {
	const notAPath = new CliUsageError({
		message: `expected an API path such as /v2/services, got ${path}`,
		hint: "pass the path only; the host comes from `maple login` (or MAPLE_API_URL)",
	})
	if (!Str.startsWith("/")(path) || Str.startsWith("//")(path)) return Result.fail(notAPath)
	return Result.try({
		try: () => ({ base: new URL(apiUrl), url: new URL(path, apiUrl) }),
		catch: () => notAPath,
	}).pipe(
		Result.filterOrFail(
			({ base, url }) => url.origin === base.origin,
			() => notAPath,
		),
		Result.map(({ url }) => url),
	)
}

export interface Field {
	/** The key as typed, e.g. `filter[service]`, used verbatim in a query string. */
	readonly rawKey: string
	/** `a[b][]` → ["a", "b", ""]; an empty segment appends to an array. */
	readonly path: ReadonlyArray<string>
	readonly value: unknown
}

const FIELD_PATTERN = /^([^[\]=:]+)((?:\[[^[\]=]*\])*)(:?)=([\s\S]*)$/
const SEGMENT_PATTERN = /\[([^[\]]*)\]/g

/**
 * One `-d` value, Stripe style: `key=value` is a string, `key:=<json>` a typed
 * value (`limit:=10`, `enabled:=true`, `tags:='["a"]'`), and brackets nest
 * (`metadata[team]=core`, `ids[]=a`).
 */
export const parseField = (raw: string): Result.Result<Field, CliUsageError> => {
	const match = Option.getOrUndefined(Str.match(FIELD_PATTERN)(raw))
	const root = match?.[1]
	if (match === undefined || root === undefined)
		return Result.fail(
			new CliUsageError({
				message: `-d expects key=value or key:=<json>, got ${raw}`,
				hint: "e.g. -d name=checkout -d limit:=10 -d metadata[team]=core",
			}),
		)
	const brackets = match[2] ?? ""
	const text = match[4] ?? ""
	const rawKey = `${root}${brackets}`
	const nested = Arr.map(Arr.fromIterable(Str.matchAll(SEGMENT_PATTERN)(brackets)), (m) => m[1] ?? "")
	const value = match[3] === ":" ? parseJson(text, `-d ${rawKey}`) : Result.succeed<unknown>(text)
	return Result.map(value, (v) => ({ rawKey, path: [root, ...nested], value: v }))
}

type JsonObject = { [key: string]: unknown }
type Container = JsonObject | Array<unknown>

const emptyFor = (segment: string | undefined): Container => (segment === "" ? [] : {})

const setAt = (
	target: Container,
	path: ReadonlyArray<string>,
	value: unknown,
	rawKey: string,
): Result.Result<void, CliUsageError> => {
	const [head, ...rest] = path
	if (head === undefined) return Result.void
	const conflict = Result.fail(
		new CliUsageError({ message: `-d ${rawKey} conflicts with another -d for the same key` }),
	)
	if (Arr.isArray(target)) {
		if (head !== "") return conflict
		const child = rest.length === 0 ? value : emptyFor(rest[0])
		target.push(child)
		return Predicate.isObject(child) || Arr.isArray(child)
			? setAt(child, rest, value, rawKey)
			: Result.void
	}
	if (head === "") return conflict
	// `__proto__` would assign through to Object.prototype; inherited names are not fields.
	if (head === "__proto__")
		return Result.fail(new CliUsageError({ message: `-d ${rawKey} uses a reserved key name` }))
	const existing = Rec.has(target, head) ? target[head] : undefined
	if (rest.length === 0) {
		if (existing !== undefined) return conflict
		target[head] = value
		return Result.void
	}
	if (existing === undefined) {
		const child = emptyFor(rest[0])
		target[head] = child
		return setAt(child, rest, value, rawKey)
	}
	const wantsArray = rest[0] === ""
	if (wantsArray && Arr.isArray(existing)) return setAt(existing, rest, value, rawKey)
	if (!wantsArray && Predicate.isObject(existing)) return setAt(existing, rest, value, rawKey)
	return conflict
}

/** Fold `-d` fields into one JSON object body. */
export const buildBody = (fields: ReadonlyArray<Field>): Result.Result<JsonObject, CliUsageError> => {
	const initial: Result.Result<JsonObject, CliUsageError> = Result.succeed({})
	return Arr.reduce(fields, initial, (acc, f) =>
		Result.flatMap(acc, (b) => Result.map(setAt(b, f.path, f.value, f.rawKey), () => b)),
	)
}

const queryValue = (value: unknown): string => (Predicate.isString(value) ? value : encodeJson(value))

/** Append `-d` fields to the URL's query string, keys verbatim. */
export const withQuery = (url: URL, fields: ReadonlyArray<Field>): URL => {
	const next = new URL(url)
	Arr.forEach(fields, (f) => next.searchParams.append(f.rawKey, queryValue(f.value)))
	return next
}

const HEADER_PATTERN = /^([A-Za-z0-9!#$%&'*+.^_`|~-]+):([\s\S]*)$/

/** `-H "Name: value"` into a header pair. */
export const parseHeader = (raw: string): Result.Result<readonly [string, string], CliUsageError> => {
	const match = Option.getOrUndefined(Str.match(HEADER_PATTERN)(Str.trim(raw)))
	const name = match?.[1]
	if (match === undefined || name === undefined)
		return Result.fail(
			new CliUsageError({
				message: `-H expects "Name: value", got ${raw}`,
				hint: '-H "Idempotency-Key: abc"',
			}),
		)
	const header: readonly [string, string] = [name, Str.trim(match[2] ?? "")]
	return Result.succeed(header)
}

const messageField = (u: unknown): Option.Option<string> =>
	Predicate.hasProperty(u, "message") && Predicate.isString(u.message) && u.message !== ""
		? Option.some(u.message)
		: Option.none()

/** The human sentence in an error response body (`{ message }` or the v2 `{ error: { message } }`). */
export const errorMessageOf = (body: unknown): Option.Option<string> =>
	messageField(body).pipe(
		Option.orElse(() =>
			Predicate.hasProperty(body, "error") ? messageField(body.error) : Option.none(),
		),
	)
