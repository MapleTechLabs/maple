import { describe, expect, it } from "@effect/vitest"
import { Array as Arr, Context, Predicate, Schema, SchemaAST, String as Str } from "effect"
import { HttpApi, type HttpApiGroup } from "effect/http-api"
import { MapleApi } from "./api"
import { MapleInternalApi } from "./internal-api"
import { MapleApiV2 } from "./v2/api"

// A path param with one of these names carries a credential or a device address, so a server
// span or request log must never record its value.
const SECRET_PARAM = /(token|secret|usercode|password|apikey)$/i

type Route = {
	readonly route: string
	readonly params: ReadonlyArray<string>
	readonly redacted: ReadonlyArray<string>
}

// HttpApi redacts a param whose schema is `Schema.Redacted` without a `RedactedNames` entry.
const isRedactedSchema = (ast: SchemaAST.AST) =>
	SchemaAST.isDeclaration(ast) &&
	Predicate.hasProperty(ast.annotations?.["representation"], "id") &&
	ast.annotations["representation"].id === "effect/schema/Redacted"

const redactedBySchema = (params: Schema.Top | undefined): ReadonlyArray<string> =>
	params !== undefined && SchemaAST.isObjects(params.ast)
		? Arr.map(
				Arr.filter(params.ast.propertySignatures, (signature) => isRedactedSchema(signature.type)),
				(signature) => String(signature.name),
			)
		: []

const routesOf = <Groups extends HttpApiGroup.Constraint>(api: HttpApi.HttpApi<string, Groups>) => {
	const routes: Array<Route> = []
	HttpApi.reflect(api, {
		onGroup: () => {},
		onEndpoint: ({ endpoint, mergedAnnotations }) =>
			routes.push({
				route: `${endpoint.method} ${endpoint.path}`,
				params: Arr.map(Arr.filter(Str.split(endpoint.path, "/"), Str.startsWith(":")), Str.slice(1)),
				redacted: [
					...(Context.getOrUndefined(mergedAnnotations, HttpApi.RedactedNames)?.params ?? []),
					...redactedBySchema(endpoint.params),
				],
			}),
	})
	return routes
}

const allRoutes = [...routesOf(MapleApi), ...routesOf(MapleInternalApi), ...routesOf(MapleApiV2)]

describe("secret path params", () => {
	it("are redacted in the server span of every route that has one", () => {
		const leaks = Arr.flatMap(allRoutes, ({ route, params, redacted }) =>
			Arr.map(
				Arr.filter(params, (param) => SECRET_PARAM.test(param) && !redacted.includes(param)),
				(param) => `${route} (${param})`,
			),
		)
		expect(leaks).toEqual([])
	})

	it("cover the mobile push token and the CLI login code", () => {
		const redactedRoutes = Arr.map(
			Arr.filter(allRoutes, ({ redacted }) => redacted.length > 0),
			({ route }) => route,
		)
		expect(redactedRoutes).toEqual(
			expect.arrayContaining([
				"PUT /v2/mobile_devices/:token",
				"DELETE /v2/mobile_devices/:token/live_activities/:incident_id",
				"GET /api/auth/cli/device/:userCode",
				"POST /api/auth/cli/device/:userCode/approve",
			]),
		)
	})
})
