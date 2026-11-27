import { Array as Arr, Record as Rec, String as Str } from "effect"
import { type Permission, permissions } from "../../policy"
import type { EndpointAccessEntry } from "../access-catalog"

// Writes what each operation asks of the caller's role into the OpenAPI document, from the access
// catalog: the gate's own marks, so the reference cannot drift from what the API enforces.

const HTTP_OPERATION_METHODS = ["get", "post", "put", "patch", "delete", "head"] as const

interface AccessOperation {
	description?: string
	"x-required-permissions"?: ReadonlyArray<Permission>
	"x-conditional-permissions"?: ReadonlyArray<Permission>
}
type AccessPathItem = Partial<Record<(typeof HTTP_OPERATION_METHODS)[number], AccessOperation>>
interface AccessSpec {
	readonly paths?: Record<string, AccessPathItem | undefined>
}

/** `/v2/slos/:id` as the document writes it: `/v2/slos/{id}`. */
const documentPath = (routePath: string): string => Str.replaceAll(/:([A-Za-z0-9_]+)/g, "{$1}")(routePath)

const named = (permission: Permission): string => `${permissions[permission].label} (\`${permission}\`)`

const listed = (names: ReadonlyArray<string>, last: "and" | "or"): string =>
	names.length <= 1
		? Arr.join(names, "")
		: `${Arr.join(names.slice(0, -1), ", ")} ${last} ${names[names.length - 1]}`

/** The sentences an operation's description gains, or none for an endpoint that asks nothing. */
export const accessSentences = (entry: Pick<EndpointAccessEntry, "requires" | "handler">): string =>
	Arr.join(
		[
			...(entry.requires.length > 0
				? [`The caller's role needs ${listed(Arr.map(entry.requires, named), "and")}.`]
				: []),
			...(entry.handler.length > 0
				? [`Depending on the request, it also needs ${listed(Arr.map(entry.handler, named), "or")}.`]
				: []),
		],
		" ",
	)

/** Adds each operation's role permissions: as `x-…-permissions` fields and in its description. */
export const addAccessRequirements =
	(catalog: ReadonlyArray<EndpointAccessEntry>) =>
	<S extends AccessSpec>(spec: S): S => {
		const byOperation = new Map(
			Arr.map(catalog, (entry) => [
				`${Str.toLowerCase(entry.method)} ${documentPath(entry.path)}`,
				entry,
			]),
		)
		for (const [path, pathItem] of Rec.toEntries(spec.paths ?? {})) {
			if (pathItem === undefined) continue
			for (const method of HTTP_OPERATION_METHODS) {
				const operation = pathItem[method]
				const entry = byOperation.get(`${method} ${path}`)
				if (operation === undefined || entry === undefined) continue
				const sentences = accessSentences(entry)
				if (sentences === "") continue
				operation.description =
					operation.description === undefined
						? sentences
						: `${operation.description}\n\n${sentences}`
				if (entry.requires.length > 0) operation["x-required-permissions"] = entry.requires
				if (entry.handler.length > 0) operation["x-conditional-permissions"] = entry.handler
			}
		}
		return spec
	}
