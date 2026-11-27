import { describe, expect, it } from "@effect/vitest"
import { Array as Arr, Context, Option } from "effect"
import { accessCatalogOf, type CatalogApi, endpointsBehind, TENANT_GATES } from "./access-catalog"
import { EndpointAccess, handlerChecks, requires, ScopedTelemetry } from "./endpoint-access"

type Mark = Context.Service.Shape<typeof EndpointAccess>

const endpoint = (
	identifier: string,
	method: string,
	path: string,
	options: { readonly mark?: Mark; readonly gated?: boolean; readonly scoped?: boolean } = {},
) => ({
	identifier,
	method,
	path,
	annotations: Context.empty().pipe(
		Context.add(EndpointAccess, options.mark),
		Context.add(ScopedTelemetry, options.scoped === true),
	),
	middlewares: new Set(options.gated === false ? [] : [TENANT_GATES[0]]),
})

// One of each shape a mark can take: a group that requires, a group whose handlers check, a list
// mark, an open read with a handler check, an endpoint outside the gate, and writes nobody marked.
const api: CatalogApi = {
	identifier: "Example",
	groups: {
		boards: {
			identifier: "boards",
			annotations: Context.make(EndpointAccess, requires("telemetry:read")),
			endpoints: {
				create: endpoint("create", "POST", "/boards", {
					mark: [requires("telemetry:read", "dashboards:edit"), handlerChecks("query:sql")],
				}),
				query: endpoint("query", "POST", "/boards/query", { scoped: true }),
				webhook: endpoint("webhook", "POST", "/boards/webhook", { gated: false }),
			},
		},
		rules: {
			identifier: "rules",
			annotations: Context.make(EndpointAccess, handlerChecks("alerts:manage", "query:sql")),
			endpoints: {
				list: endpoint("list", "GET", "/rules"),
				create: endpoint("create", "POST", "/rules"),
				mute: endpoint("mute", "POST", "/rules/:id/mute", { mark: handlerChecks("alerts:manage") }),
				secret: endpoint("secret", "GET", "/rules/:id/secret", {
					mark: handlerChecks("integrations:manage"),
				}),
				link: endpoint("link", "POST", "/rules/link", { mark: "personal" }),
				spend: endpoint("spend", "GET", "/rules/spend", {
					mark: ["personal", handlerChecks("billing:manage")],
				}),
			},
		},
		unmarked: {
			identifier: "unmarked",
			annotations: Context.empty(),
			endpoints: {
				search: endpoint("search", "POST", "/v2/traces/search"),
				create: endpoint("create", "POST", "/v2/slos"),
			},
		},
	},
}

const catalog = accessCatalogOf([api])
const entry = (group: string, name: string) =>
	Option.getOrThrow(Arr.findFirst(catalog, (one) => one.group === group && one.endpoint === name))
const names = (entries: ReadonlyArray<{ readonly group: string; readonly endpoint: string }>) =>
	Arr.map(entries, (one) => `${one.group}.${one.endpoint}`)

describe("the access catalog", () => {
	it("leaves out an endpoint no tenant gate guards", () => {
		expect(names(catalog)).not.toContain("boards.webhook")
		expect(catalog).toHaveLength(10)
	})

	it("lists a permission once when the endpoint and its group both ask for it", () => {
		expect(entry("boards", "create").requires).toEqual(["telemetry:read", "dashboards:edit"])
	})

	it("carries a handler's own permission beside the gate's rule on one endpoint", () => {
		expect(entry("boards", "create").handler).toEqual(["query:sql"])
	})

	it("gives a group's handler mark to its writes, and Read telemetry to its reads", () => {
		expect(entry("rules", "create")).toMatchObject({
			requires: [],
			handler: ["alerts:manage", "query:sql"],
		})
		expect(entry("rules", "list")).toMatchObject({ requires: ["telemetry:read"], handler: [] })
	})

	it("lets an endpoint's handler mark replace its group's, on a write and on a read", () => {
		expect(entry("rules", "mute").handler).toEqual(["alerts:manage"])
		expect(entry("rules", "secret")).toMatchObject({
			requires: ["telemetry:read"],
			handler: ["integrations:manage"],
		})
	})

	it("gives a group's handler mark to no endpoint that carries a rule of its own", () => {
		expect(entry("rules", "link")).toMatchObject({ requires: [], handler: [] })
	})

	it("asks nothing at the gate of a read open to every member, and still names its handler check", () => {
		expect(entry("rules", "spend")).toMatchObject({ requires: [], handler: ["billing:manage"] })
	})

	it("reads an unmarked v2 POST the scope registry calls a read as needing Read telemetry", () => {
		expect(entry("unmarked", "search")).toMatchObject({ requires: ["telemetry:read"], unmarked: false })
	})

	it("calls any other write without a rule unmarked", () => {
		expect(entry("unmarked", "create")).toMatchObject({ requires: [], unmarked: true })
	})
})

describe("endpointsBehind", () => {
	it("lists what a permission opens, with whether the gate or the handler asks for it", () => {
		const sql = endpointsBehind(catalog, "query:sql")
		expect(Arr.map(sql, (one) => [`${one.group}.${one.endpoint}`, one.use])).toEqual([
			["boards.create", "handler"],
			["rules.create", "handler"],
		])
		const read = endpointsBehind(catalog, "telemetry:read")
		expect(Arr.map(read, (one) => [`${one.group}.${one.endpoint}`, one.use])).toEqual([
			["boards.create", "requires"],
			["boards.query", "requires"],
			["rules.list", "requires"],
			["rules.secret", "requires"],
			["unmarked.search", "requires"],
		])
	})

	it("lists the scoped read for the endpoints marked for it, where it stands in for Read telemetry", () => {
		expect(names(endpointsBehind(catalog, "telemetry:read_scoped"))).toEqual(["boards.query"])
	})

	it("opens nothing for a permission no endpoint asks for", () => {
		expect(endpointsBehind(catalog, "sso:manage")).toEqual([])
	})
})
