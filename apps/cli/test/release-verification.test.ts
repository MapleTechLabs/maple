// Deploy verification on a real ClickHouse engine: a version's first half hour
// against the half hour before it, on the same service and environment.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as CH from "@maple/query-engine/ch"
import { normalizeSqlForClickHouseClient } from "@maple/query-engine/execution"
import { compileUnsafe } from "@maple-dev/effect-orm/clickhouse"
import { OrgId } from "@maple/domain"
import { Effect, Schema, Array as Arr, String as Str } from "effect"
import { CommitSha, ServiceDeploysRequest, ServiceName } from "@maple/domain/http"
import { Queries } from "@maple/query-engine/registry"
import { baselineWarehouseCapabilities } from "@maple/query-engine/observability"
import schemaSql from "@maple/local-server/schema/local-schema.sql" with { type: "text" }
import { Chdb } from "@maple/local-server/chdb"
import { decodeJsonEachRow } from "@maple/local-server/chdb-rows"
import { describeWithChdb } from "./libchdb-test-support"

const ORG = "org_verify"
const MINUTE_MS = 60_000
/** Three hours ago on the hour: recent, so the raw table's TTL keeps it. */
const DEPLOY_MS = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 3 * 3_600_000

const ts = (ms: number) => Str.replace("Z", "")(Str.replace("T", " ")(new Date(ms).toISOString()))
const seconds = (ms: number) => Str.slice(0, 19)(ts(ms))

interface Minute {
	readonly service: string
	readonly sha: string
	readonly atMs: number
	readonly spans: number
	readonly errors: number
	readonly durationMs: number
}

/** Spans for every minute in [fromMin, toMin) relative to the deploy. */
const minutes = (
	service: string,
	sha: string,
	fromMin: number,
	toMin: number,
	spans: number,
	errors: number,
	durationMs = 20,
): Minute[] =>
	Arr.map(Arr.range(fromMin, toMin - 1), (m) => ({
		service,
		sha,
		atMs: DEPLOY_MS + m * MINUTE_MS + 5_000,
		spans,
		errors,
		durationMs,
	}))

const insert = (db: Chdb, rows: ReadonlyArray<Minute>) => {
	let n = 0
	const values = Arr.flatMap(rows, (row) =>
		Arr.map(Arr.range(1, row.spans), (i) => {
			n += 1
			const status = i <= row.errors ? "Error" : "Ok"
			return `('${ORG}', '${ts(row.atMs + i)}', 't${n}', 's${n}', '', 'GET /', 'Server', '${row.service}', map('vcs.ref.head.revision', '${row.sha}', 'deployment.environment.name', 'production'), ${row.durationMs * 1_000_000}, '${status}')`
		}),
	)
	Arr.forEach(Arr.chunksOf(values, 2_000), (chunk) =>
		db.exec(
			`INSERT INTO traces (OrgId, Timestamp, TraceId, SpanId, ParentSpanId, SpanName, SpanKind, ServiceName, ResourceAttributes, Duration, StatusCode) VALUES ${Arr.join(chunk, ", ")}`,
		),
	)
}

const decode = decodeJsonEachRow(CH.releaseVerificationRowSchema)

describeWithChdb("release verification", () => {
	let root = ""
	let db: Chdb

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "maple-release-verify-"))
		db = Chdb.open({ dataDir: join(root, "data"), schemaSql })
		insert(db, [
			// api: v1 all morning at 1% errors, v2 from the deploy at 10% errors.
			...minutes("api", "v1", -120, 0, 100, 1),
			...minutes("api", "v2", 0, 45, 100, 10, 80),
			// web: v1 busy before, v2 lands on a quiet slot. Same error rate on both:
			// a lifetime comparison would see nothing either, but neither must the window.
			...minutes("web", "w1", -60, 0, 50, 1),
			...minutes("web", "w2", 0, 10, 50, 1),
			// cron: no version reported before, then its first tagged build.
			...minutes("cron", "unknown", -40, 0, 60, 0),
			...minutes("cron", "c1", 0, 20, 60, 0),
			// The window ends 30 minutes in: v2's minutes past it do not count.
		])
	})

	afterAll(() => {
		db.close()
		rmSync(root, { recursive: true, force: true })
	})

	const run = () => {
		const { sql } = compileUnsafe(CH.releaseVerificationQuery({}), {
			orgId: OrgId.make(ORG),
			startTime: seconds(DEPLOY_MS - 3 * 3_600_000),
			endTime: seconds(DEPLOY_MS + 3_600_000),
			deploysFrom: seconds(DEPLOY_MS - 3 * 3_600_000),
		})
		return decode(db.query(normalizeSqlForClickHouseClient(sql)))
	}

	test("compares a deploy's first half hour with the half hour before it", () => {
		const api = Arr.findFirst(run(), (row) => row.commitSha === "v2")
		expect(api._tag).toBe("Some")
		if (api._tag !== "Some") return
		expect(api.value.afterSpans).toBe(3_000)
		expect(api.value.afterErrors).toBe(300)
		expect(api.value.beforeSpans).toBe(3_000)
		expect(api.value.beforeErrors).toBe(30)
		expect(api.value.afterP95Ms).toBeGreaterThan(api.value.beforeP95Ms * 2)
	})

	test("a version that has only served ten minutes is measured over those ten", () => {
		const web = Arr.findFirst(run(), (row) => row.commitSha === "w2")
		if (web._tag !== "Some") throw new Error("w2 missing")
		expect(web.value.afterSpans).toBe(500)
		expect(web.value.afterErrors).toBe(10)
		expect(web.value.beforeSpans).toBe(1_500)
	})

	test("the oldest version in the window has no before", () => {
		const v1 = Arr.findFirst(run(), (row) => row.commitSha === "v1")
		if (v1._tag !== "Some") throw new Error("v1 missing")
		expect(v1.value.beforeSpans).toBe(0)
	})

	test("one commit across services: only that commit's deploys come back", () => {
		const { sql } = compileUnsafe(CH.releaseVerificationQuery({ commitSha: "v2" }), {
			orgId: OrgId.make(ORG),
			startTime: seconds(DEPLOY_MS - 3 * 3_600_000),
			endTime: seconds(DEPLOY_MS + 3_600_000),
			deploysFrom: seconds(DEPLOY_MS - 3 * 3_600_000),
		})
		const rows = decode(db.query(normalizeSqlForClickHouseClient(sql)))
		expect(Arr.map(rows, (row) => [row.serviceName, row.commitSha])).toEqual([["api", "v2"]])
		expect(rows[0]?.beforeSpans).toBe(3_000)
	})

	test("the service page's read starts early: a deploy near the window's start still has its before", () => {
		const compiled = Effect.runSync(
			Queries.serviceDeploys.compile(
				new ServiceDeploysRequest({
					serviceName: Schema.decodeSync(ServiceName)("api"),
					startTime: seconds(DEPLOY_MS - 10 * MINUTE_MS),
					endTime: seconds(DEPLOY_MS + 3_600_000),
				}),
				OrgId.make(ORG),
				baselineWarehouseCapabilities(),
			),
		)
		const rows = decode(db.query(normalizeSqlForClickHouseClient(compiled.sql)))
		expect(new Set(Arr.map(rows, (row) => row.serviceName))).toEqual(new Set(["api"]))
		const v2 = Arr.findFirst(rows, (row) => row.commitSha === "v2")
		if (v2._tag !== "Some") throw new Error("v2 missing")
		expect(v2.value.beforeSpans).toBe(3_000)
		// v1 was running before the window: the query leaves it out rather than call it a deploy.
		expect(Arr.some(rows, (row) => row.commitSha === "v1")).toBe(false)
	})

	test("a commit's read is bounded to the services it reached, as the API runs it", () => {
		const request = new ServiceDeploysRequest({
			commitSha: Schema.decodeSync(CommitSha)("w2"),
			startTime: seconds(DEPLOY_MS - 10 * MINUTE_MS),
			endTime: seconds(DEPLOY_MS + 3_600_000),
		})
		const services = decodeJsonEachRow(CH.commitServicesRowSchema)(
			db.query(
				normalizeSqlForClickHouseClient(
					Effect.runSync(
						Queries.commitServices.compile(
							{ ...request, commitSha: Schema.decodeSync(CommitSha)("w2") },
							OrgId.make(ORG),
							baselineWarehouseCapabilities(),
						),
					).sql,
				),
			),
		)
		expect(Arr.map(services, (row) => row.serviceName)).toEqual(["web"])
		const rows = decode(
			db.query(
				normalizeSqlForClickHouseClient(
					Effect.runSync(
						Queries.serviceDeploys.compile(
							{ ...request, serviceNames: Arr.map(services, (row) => row.serviceName) },
							OrgId.make(ORG),
							baselineWarehouseCapabilities(),
						),
					).sql,
				),
			),
		)
		expect(Arr.map(rows, (row) => [row.serviceName, row.commitSha, row.beforeSpans])).toEqual([
			["web", "w2", 1_500],
		])
	})

	test("traffic that reported no version still counts as the before of the first tagged build", () => {
		const cron = Arr.findFirst(run(), (row) => row.commitSha === "c1")
		if (cron._tag !== "Some") throw new Error("c1 missing")
		expect(cron.value.beforeSpans).toBe(1_800)
		expect(Arr.some(run(), (row) => row.commitSha === "unknown")).toBe(false)
	})
})
