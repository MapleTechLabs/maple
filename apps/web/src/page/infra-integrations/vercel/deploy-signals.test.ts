import { VercelDeploymentSummary, type VercelInfraRequestBucket } from "@maple/domain/http"
import { Array as Arr } from "effect"
import { describe, expect, it } from "vitest"
import {
	deployCommitMarkers,
	deployLabel,
	deployRegressions,
	deployTitle,
	productionDeploysIn,
	regressionBands,
} from "./deploy-signals"

const BUCKET_MS = 15 * 60_000
const T0 = new Date("2026-11-10T00:00:00.000Z").getTime()

const bucket = (i: number, requests: number, requests5xx: number): VercelInfraRequestBucket => ({
	bucket: new Date(T0 + i * BUCKET_MS).toISOString(),
	requests,
	requests2xx: requests - requests5xx,
	requests3xx: 0,
	requests4xx: 0,
	requests5xx,
	cacheHits: 0,
	cacheLookups: 0,
	errorLogs: 0,
})

const deploy = (id: string, atMs: number, state = "READY", target: string | null = "production") =>
	new VercelDeploymentSummary({
		id,
		projectId: "prj_shop",
		url: `${id}.vercel.app`,
		target,
		state,
		branch: "main",
		commitSha: `${id}0000000000`,
		commitMessage: null,
		creator: null,
		createdAt: atMs - 60_000,
		buildingAt: atMs - 50_000,
		readyAt: state === "READY" ? atMs : null,
		errorCode: null,
		errorMessage: null,
		inspectorUrl: null,
	})

// 20 quiet buckets at 0.2% 5xx, a 6% spike in buckets 10–12, quiet again after.
const BUCKETS = Array.from({ length: 20 }, (_, i) => bucket(i, 1_000, i >= 10 && i <= 12 ? 60 : 2))

describe("deployRegressions", () => {
	it("pins the spike on the deploy just before it and ends it with the next deploy", () => {
		const bad = deploy("bad1234", T0 + 10 * BUCKET_MS + 60_000)
		const fix = deploy("fix5678", T0 + 13 * BUCKET_MS + 60_000)
		const [regression, ...rest] = deployRegressions(BUCKETS, [fix, bad], BUCKET_MS)
		expect(rest).toEqual([])
		expect(regression?.deployment.id).toBe("bad1234")
		expect(regression?.peakRate).toBeCloseTo(0.06)
		expect(regression?.beforeRate).toBeCloseTo(0.002)
		expect(regression?.failedRequests).toBe(180)
		expect(regression?.endsAtMs).toBe(T0 + 13 * BUCKET_MS)
	})

	it("ignores a deploy whose following buckets stay at the usual rate", () => {
		expect(deployRegressions(BUCKETS, [deploy("calm111", T0 + 3 * BUCKET_MS)], BUCKET_MS)).toEqual([])
	})

	it("ignores a jump in buckets too thin to read", () => {
		const thin = Array.from({ length: 10 }, (_, i) => bucket(i, i === 6 ? 10 : 1_000, i === 6 ? 5 : 2))
		expect(deployRegressions(thin, [deploy("thin111", T0 + 6 * BUCKET_MS)], BUCKET_MS)).toEqual([])
	})
})

describe("productionDeploysIn", () => {
	it("keeps production deploys inside the window, oldest first", () => {
		const window = { startMs: T0, endMs: T0 + 20 * BUCKET_MS }
		const picked = productionDeploysIn(
			[
				deploy("late000", T0 + 9 * BUCKET_MS),
				deploy("early00", T0 + 2 * BUCKET_MS),
				deploy("preview", T0 + 4 * BUCKET_MS, "READY", null),
				deploy("outside", T0 + 30 * BUCKET_MS),
			],
			window,
		)
		expect(Arr.map(picked, (d) => d.id)).toEqual(["early00", "late000"])
	})
})

describe("regressionBands", () => {
	it("shades each regression's window without a label of its own", () => {
		const bad = deploy("bad1234", T0 + 10 * BUCKET_MS + 60_000)
		const bands = regressionBands(deployRegressions(BUCKETS, [bad], BUCKET_MS))
		expect(Arr.map(bands, (b) => [b.id, b.tone, b.label])).toEqual([["bad1234", "crit", ""]])
		expect(bands[0]?.endsAt).toBeDefined()
	})
})

describe("deployCommitMarkers", () => {
	it("puts each deploy at the moment it went live, a failed build named as one", () => {
		const shipped = deploy("ok12345", T0 + 3 * BUCKET_MS)
		const failed = deploy("err9999", T0 + 4 * BUCKET_MS, "ERROR")
		const markers = deployCommitMarkers([shipped, failed])
		expect(Arr.map(markers, (m) => [m.bucket, m.label])).toEqual([
			[new Date(T0 + 3 * BUCKET_MS).toISOString(), "ok12345"],
			// A failed build never went live: it sits where it was created.
			[new Date(T0 + 4 * BUCKET_MS - 60_000).toISOString(), "failed · err9999"],
		])
	})
})

describe("deployTitle", () => {
	it("reads the commit's first line, and a short id for a deploy with no commit", () => {
		const cli = new VercelDeploymentSummary({
			...deploy("x", T0),
			id: "dpl_FcAuGdT6Dfebn3txnja7jnno5D55",
			commitSha: null,
		})
		expect(deployLabel(cli)).toBe("dpl_FcAuGdT")
		expect(deployTitle(cli)).toBe("dpl_FcAuGdT")
		expect(
			deployTitle(new VercelDeploymentSummary({ ...deploy("y", T0), commitMessage: "Fix the cart\n\nLong body" })),
		).toBe("Fix the cart")
	})
})
