// SAFETY-FILE: JSON in this test is emitted by the fixture or unit under test before its fields are asserted.
import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest"
import { mintOrgReadJwt } from "@maple/backend/services/auth/tinybird-jwt"
import { Array as Arr, Option, String as Str } from "effect"
import { rowFilterFor } from "./data-scope"

// What a namespace-limited role's token does on a real Tinybird: the row filters `rowFilterFor`
// writes are accepted, hold on every scan, and a datasource left out of the token is refused.
// Needs Tinybird Local: `TINYBIRD_LOCAL_E2E=1 bunx vitest run src/services/warehouse/data-scope.tinybird.e2e.test.ts`.

const enabled = process.env.TINYBIRD_LOCAL_E2E === "1"
const apiBase = Str.replace(/\/$/, "")(process.env.TINYBIRD_LOCAL_E2E_URL ?? "http://127.0.0.1:7181")
// The ClickHouse-compatible gateway is a separate listener: its cases run when its URL is given.
const gatewayUrl = process.env.TINYBIRD_LOCAL_E2E_GATEWAY_URL
const gatewayBase = Str.replace(/\/$/, "")(gatewayUrl ?? "http://127.0.0.1:7182")
const workspaceName = `DataScopeE2E_${Date.now()}_${Str.slice(2, 8)(Math.random().toString(36))}`

interface LocalTokens {
	readonly admin_token: string
	readonly user_token: string
}

interface LocalWorkspace {
	readonly id: string
	readonly name: string
	readonly token: string
}

let tokens: LocalTokens | undefined
let workspace: LocalWorkspace | undefined
let signingKey: string | undefined

const responseJson = async <T>(response: Response): Promise<T> => {
	const text = await response.text()
	if (!response.ok) throw new Error(`Tinybird ${response.status}: ${Str.slice(0, 500)(text)}`)
	return JSON.parse(text) as T
}

const createWorkspace = async (localTokens: LocalTokens): Promise<LocalWorkspace> => {
	await responseJson<Record<string, unknown>>(
		await fetch(`${apiBase}/v1/workspaces`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${localTokens.user_token}`,
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({ name: workspaceName }),
		}),
	)
	const listed = await responseJson<{ readonly workspaces: ReadonlyArray<LocalWorkspace> }>(
		await fetch(
			`${apiBase}/v1/user/workspaces?with_organization=true&token=${encodeURIComponent(localTokens.admin_token)}`,
		),
	)
	const created = Arr.findFirst(listed.workspaces, (candidate) => candidate.name === workspaceName)
	if (Option.isNone(created)) throw new Error("Tinybird Local workspace was not returned after creation")
	return created.value
}

// Named like the real ones, so `rowFilterFor` writes the filters it writes in production: `traces`
// filters on resource attributes, `trace_list_mv` on its namespace column, `trace_index` is a
// locator, and `error_events` only names a service.
const DATAFILES = {
	traces: [
		"SCHEMA >",
		"    OrgId String `json:$.OrgId`,",
		"    TraceId String `json:$.TraceId`,",
		"    ServiceName String `json:$.ServiceName`,",
		"    ResourceAttributes Map(LowCardinality(String), String) `json:$.ResourceAttributes`",
	],
	trace_list_mv: [
		"SCHEMA >",
		"    OrgId String `json:$.OrgId`,",
		"    TraceId String `json:$.TraceId`,",
		"    ServiceNamespace LowCardinality(String) `json:$.ServiceNamespace`",
	],
	trace_index: [
		"SCHEMA >",
		"    OrgId String `json:$.OrgId`,",
		"    TraceId String `json:$.TraceId`,",
		"    ServiceName String `json:$.ServiceName`",
	],
	error_events: [
		"SCHEMA >",
		"    OrgId String `json:$.OrgId`,",
		"    TraceId String `json:$.TraceId`,",
		"    ServiceName String `json:$.ServiceName`",
	],
} as const

type Datasource = keyof typeof DATAFILES
const DATASOURCES: ReadonlyArray<Datasource> = ["traces", "trace_list_mv", "trace_index", "error_events"]

const buildDatasources = async (target: LocalWorkspace): Promise<void> => {
	const form = new FormData()
	for (const name of DATASOURCES) {
		const datafile = Arr.join(
			[...DATAFILES[name], 'ENGINE "MergeTree"', 'ENGINE_SORTING_KEY "OrgId"'],
			"\n",
		)
		form.append("data_project://", new Blob([datafile], { type: "text/plain" }), `${name}.datasource`)
	}
	const body = await responseJson<{ readonly result: string; readonly error?: string }>(
		await fetch(`${apiBase}/v1/build`, {
			method: "POST",
			headers: { Authorization: `Bearer ${target.token}` },
			body: form,
		}),
	)
	if (body.result !== "success" && body.result !== "no_changes") {
		throw new Error(`Tinybird local build failed: ${body.error ?? body.result}`)
	}
}

// One span per (org, namespace); `t5` reports no namespace at all, `t6` one with a non-ASCII name.
const SPANS = [
	{ OrgId: "org_a", TraceId: "t1", ServiceName: "api", ns: "checkout" },
	{ OrgId: "org_a", TraceId: "t2", ServiceName: "ledger", ns: "payments" },
	{ OrgId: "org_a", TraceId: "t3", ServiceName: "indexer", ns: "search" },
	{ OrgId: "org_b", TraceId: "t4", ServiceName: "api", ns: "checkout" },
	{ OrgId: "org_a", TraceId: "t5", ServiceName: "legacy", ns: "" },
	{ OrgId: "org_a", TraceId: "t6", ServiceName: "søk", ns: "søk/eu-1" },
] as const

const ingest = async (target: LocalWorkspace, name: Datasource, rows: ReadonlyArray<unknown>) => {
	await responseJson<Record<string, unknown>>(
		await fetch(`${apiBase}/v0/events?name=${name}&wait=true`, {
			method: "POST",
			headers: { Authorization: `Bearer ${target.token}`, "Content-Type": "application/x-ndjson" },
			body: Arr.join(
				Arr.map(rows, (row) => JSON.stringify(row)),
				"\n",
			),
		}),
	)
}

const ingestFixtures = async (target: LocalWorkspace): Promise<void> => {
	await ingest(
		target,
		"traces",
		Arr.map(SPANS, ({ ns, ...span }) => ({
			...span,
			ResourceAttributes: ns === "" ? {} : { "service.namespace": ns },
		})),
	)
	await ingest(
		target,
		"trace_list_mv",
		Arr.map(SPANS, ({ ns, ServiceName: _service, ...span }) => ({ ...span, ServiceNamespace: ns })),
	)
	const byService = Arr.map(SPANS, ({ ns: _ns, ...span }) => span)
	await ingest(target, "trace_index", byService)
	await ingest(target, "error_events", byService)
}

const loadSigningKey = async (target: LocalWorkspace): Promise<string> => {
	const body = await responseJson<{
		readonly tokens: ReadonlyArray<{
			readonly name: string
			readonly token: string
			readonly scopes: ReadonlyArray<{ readonly type: string }>
		}>
	}>(await fetch(`${apiBase}/v0/tokens/`, { headers: { Authorization: `Bearer ${target.token}` } }))
	const admin = Arr.findFirst(
		body.tokens,
		(candidate) =>
			candidate.name === "workspace admin token" &&
			Arr.some(candidate.scopes, (scope) => scope.type === "ADMIN"),
	)
	if (Option.isNone(admin)) throw new Error("Tinybird Local did not return a workspace admin token")
	return admin.value.token
}

/** The token a compiled read of `org_a` limited to `namespaces` runs on, as the route mints it. */
const limitedToken = (namespaces: ReadonlyArray<string>, read: "compiled" | "caller-sql" = "compiled") => {
	if (workspace === undefined || signingKey === undefined) throw new Error("workspace not initialized")
	return mintOrgReadJwt({
		signingKey,
		workspaceId: workspace.id,
		orgId: "org_a",
		datasourceNames: DATASOURCES,
		rowFilters: new Map(
			Arr.getSomes(
				Arr.map(DATASOURCES, (name) =>
					Option.map(rowFilterFor(name, namespaces, read), (filter) => [name, filter] as const),
				),
			),
		),
		nowSeconds: Math.floor(Date.now() / 1000),
		ttlSeconds: 600,
	})
}

interface Answer {
	readonly ok: boolean
	readonly status: number
	readonly ids: ReadonlyArray<string>
}

/** The trace ids a statement answers with through the query API, sorted; `ok` false when refused. */
const viaApi = async (token: string, query: string): Promise<Answer> => {
	const response = await fetch(`${apiBase}/v0/sql`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ q: `${query} FORMAT JSON` }),
	})
	if (!response.ok) return { ok: false, status: response.status, ids: [] }
	const body = (await response.json()) as { readonly data: ReadonlyArray<{ readonly TraceId: string }> }
	return { ok: true, status: response.status, ids: Arr.map(body.data, (row) => row.TraceId).sort() }
}

/** The same through the ClickHouse-compatible gateway, with the token as the password. */
const viaGateway = async (token: string, query: string): Promise<Answer> => {
	if (workspace === undefined) throw new Error("workspace not initialized")
	const response = await fetch(`${gatewayBase}/?database=${encodeURIComponent(workspace.name)}`, {
		method: "POST",
		headers: {
			"X-ClickHouse-Key": token,
			"X-ClickHouse-Database": workspace.name,
			"Content-Type": "text/plain",
		},
		body: `${query} FORMAT JSONEachRow`,
	})
	const text = await response.text()
	if (!response.ok) return { ok: false, status: response.status, ids: [] }
	const lines = Arr.filter(Str.split("\n")(Str.trim(text)), (line) => line !== "")
	return {
		ok: true,
		status: response.status,
		ids: Arr.map(lines, (line) => (JSON.parse(line) as { readonly TraceId: string }).TraceId).sort(),
	}
}

// Every way a statement tries to reach past the filter. Each must answer only `checkout` rows of org_a.
const ESCAPES: ReadonlyArray<string> = [
	"SELECT TraceId FROM traces",
	"SELECT TraceId FROM traces WHERE 1 = 1 OR ResourceAttributes['service.namespace'] = 'payments'",
	"SELECT TraceId FROM traces WHERE OrgId = 'org_b' OR OrgId = 'org_a'",
	"SELECT TraceId FROM (SELECT TraceId FROM traces)",
	"SELECT TraceId FROM traces AS t",
	"SELECT TraceId FROM traces UNION ALL SELECT TraceId FROM traces WHERE ServiceName = 'ledger'",
	"WITH every AS (SELECT TraceId FROM traces) SELECT TraceId FROM every",
	// An alias that shadows the filtered column must not satisfy the filter.
	"SELECT TraceId, mapUpdate(ResourceAttributes, map('service.namespace', 'checkout')) AS ResourceAttributes FROM traces",
	"SELECT TraceId FROM trace_list_mv",
	"SELECT TraceId, 'checkout' AS ServiceNamespace FROM trace_list_mv",
	"SELECT TraceId FROM trace_list_mv WHERE ServiceNamespace IN ('payments', 'search', '') OR 1 = 1",
	"SELECT a.TraceId AS TraceId FROM traces AS a INNER JOIN trace_list_mv AS b ON a.OrgId = b.OrgId",
	"SELECT TraceId FROM traces WHERE TraceId IN (SELECT TraceId FROM trace_list_mv)",
]

describe.skipIf(!enabled)("namespace row filters on Tinybird Local", () => {
	beforeAll(async () => {
		tokens = await responseJson<LocalTokens>(await fetch(`${apiBase}/tokens`))
		workspace = await createWorkspace(tokens)
		signingKey = await loadSigningKey(workspace)
		await buildDatasources(workspace)
		await ingestFixtures(workspace)
	}, 120_000)

	afterAll(async () => {
		if (tokens === undefined || workspace === undefined) return
		const response = await fetch(
			`${apiBase}/v1/workspaces/${workspace.id}?hard_delete_confirmation=yes`,
			{
				method: "DELETE",
				headers: { Authorization: `Bearer ${tokens.user_token}` },
			},
		)
		if (!response.ok) throw new Error(`Failed to delete Tinybird E2E workspace (${response.status})`)
	}, 30_000)

	it("keeps every statement to the role's namespace through the query API", async () => {
		const token = limitedToken(["checkout"])
		const answers = await Promise.all(Arr.map(ESCAPES, (query) => viaApi(token, query)))
		assert.deepStrictEqual(
			Arr.map(
				answers,
				(answer, index) =>
					`${ESCAPES[index]} => ${answer.ok ? Arr.dedupe(answer.ids) : answer.status}`,
			),
			Arr.map(ESCAPES, (query) => `${query} => t1`),
		)
	})

	it.skipIf(gatewayUrl === undefined)(
		"keeps every statement to the role's namespace through the ClickHouse gateway",
		async () => {
			const token = limitedToken(["checkout"])
			const answers = await Promise.all(Arr.map(ESCAPES, (query) => viaGateway(token, query)))
			assert.deepStrictEqual(
				Arr.map(
					answers,
					(answer, index) =>
						`${ESCAPES[index]} => ${answer.ok ? Arr.dedupe(answer.ids) : answer.status}`,
				),
				Arr.map(ESCAPES, (query) => `${query} => t1`),
			)
		},
	)

	it("reads several namespaces, a non-ASCII one, and never rows that report none", async () => {
		assert.deepStrictEqual((await viaApi(limitedToken(["checkout", "payments"]), ESCAPES[0] ?? "")).ids, [
			"t1",
			"t2",
		])
		assert.deepStrictEqual((await viaApi(limitedToken(["søk/eu-1"]), ESCAPES[0] ?? "")).ids, ["t6"])
		assert.deepStrictEqual(
			(await viaApi(limitedToken(["søk/eu-1"]), "SELECT TraceId FROM trace_list_mv")).ids,
			["t6"],
		)
		// Twenty namespaces of sixty-four characters: the longest list a role can name.
		const longest = Arr.makeBy(
			19,
			(index) => `${Str.repeat(61)("n")}-${Str.padStart(2, "0")(String(index))}`,
		)
		assert.deepStrictEqual((await viaApi(limitedToken([...longest, "search"]), ESCAPES[0] ?? "")).ids, [
			"t3",
		])
	})

	it("reads no row when the role's namespaces were lost, or none can be written", async () => {
		for (const namespaces of [[], ["it's"], ["x') OR OrgId != ('"]]) {
			const answer = await viaApi(limitedToken(namespaces), "SELECT TraceId FROM traces")
			assert.deepStrictEqual([answer.ok, answer.ids], [true, []])
		}
	})

	it("refuses a datasource the token leaves out, alone or joined to one it lists", async () => {
		const token = limitedToken(["checkout"])
		for (const query of [
			"SELECT TraceId FROM error_events",
			"SELECT a.TraceId AS TraceId FROM traces AS a INNER JOIN error_events AS b ON a.TraceId = b.TraceId",
			"SELECT TraceId FROM traces WHERE TraceId IN (SELECT TraceId FROM error_events)",
			// A CTE named like a datasource the token lists does not carry another one in.
			"WITH trace_list_mv AS (SELECT TraceId FROM error_events) SELECT TraceId FROM trace_list_mv",
		]) {
			assert.isFalse((await viaApi(token, query)).ok, query)
			if (gatewayUrl !== undefined) assert.isFalse((await viaGateway(token, query)).ok, query)
		}
	})

	it("seeks through the trace index to spans of the role's namespaces only", async () => {
		const seek =
			"SELECT TraceId FROM traces WHERE (ServiceName, TraceId) IN (SELECT ServiceName, TraceId FROM trace_index WHERE OrgId = 'org_a')"
		assert.deepStrictEqual((await viaApi(limitedToken(["checkout"]), seek)).ids, ["t1"])
		if (gatewayUrl !== undefined) {
			assert.deepStrictEqual((await viaGateway(limitedToken(["checkout"]), seek)).ids, ["t1"])
		}
		// The index itself is another org's to no one: its rows stay inside org_a.
		assert.deepStrictEqual(
			(await viaApi(limitedToken(["checkout"]), "SELECT TraceId FROM trace_index")).ids,
			["t1", "t2", "t3", "t5", "t6"],
		)
	})

	it("leaves the trace index out of a token for caller SQL", async () => {
		const token = limitedToken(["checkout"], "caller-sql")
		assert.isFalse((await viaApi(token, "SELECT TraceId FROM trace_index")).ok)
		assert.deepStrictEqual((await viaApi(token, "SELECT TraceId FROM traces")).ids, ["t1"])
	})
})
