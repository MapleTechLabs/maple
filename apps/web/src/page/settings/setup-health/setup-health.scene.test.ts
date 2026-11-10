import { V2SetupAudit } from "@maple/domain/http/v2"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { AsyncData } from "foldkit"
import { describe, expect, test } from "vitest"
import { healthSegments, orderFindings, resolvedChecks, setupHealthAction } from "./derive"
import { Message } from "./model"
import { init, update } from "./update"
import { Array as Arr, Result, Schema } from "effect"

const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)

const report = Schema.decodeSync(V2SetupAudit)({
	object: "setup_audit",
	generated_at: "2026-11-08T12:00:00.000Z",
	data_status: "ok",
	telemetry_checks_available: true,
	summary: { critical: 0, warn: 0, info: 0, pass: 0, skip: 0 },
	checks: [],
	open_recommendation_count: 0,
})

describe("setup health", () => {
	test("entry runs the audit; Re-run keeps the report up and asks once while it re-runs", () => {
		expect(names(init().commands)).toEqual(["FetchSetupAudit"])
		const loaded = update(
			init().model,
			Message.CompletedFetchAudit({ result: Result.succeed(report) }),
		).model
		const rerun = update(loaded, Message.ClickedRerun())
		expect(names(rerun.commands)).toEqual(["FetchSetupAudit"])
		expect(AsyncData.getOrElse(rerun.model.audit, () => null)).toEqual(report)
		expect(names(update(rerun.model, Message.ClickedRerun()).commands)).toEqual([])
	})

	test("Retry after a failed audit runs it again", () => {
		const failed = update(
			init().model,
			Message.CompletedFetchAudit({ result: Result.fail(toLoadFailure(new Error("down"))) }),
		).model
		expect(names(update(failed, Message.ClickedRetry()).commands)).toEqual(["FetchSetupAudit"])
	})

	test("findings put the most severe first and skip what passed", () => {
		const checks = [
			{ status: "fail", severity: "info" },
			{ status: "pass", severity: "critical" },
			{ status: "fail", severity: "critical" },
		] as const
		expect(Arr.map(orderFindings(checks), (check) => check.severity)).toEqual(["critical", "info"])
		expect(resolvedChecks([{ status: "pass" }, { status: "skip" }]).label).toBe(
			"Passing (1) and skipped (1)",
		)
	})

	test("the summary bar drops empty segments, and a check names where it is fixed", () => {
		expect(healthSegments({ critical: 0, warn: 2, info: 0, pass: 41, skip: 0 })).toEqual([
			{ segment: "warn", count: 2 },
			{ segment: "pass", count: 41 },
		])
		expect(setupHealthAction({ id: "CFG-MAP-01", affected: [] })).toEqual({
			kind: "link",
			label: "Open ingestion",
			href: "/settings?tab=ingestion",
		})
		expect(setupHealthAction({ id: "TRC-04", affected: [] })).toMatchObject({
			kind: "docs",
			label: "Read upstream context guide",
		})
	})

	test("a leaked credential opens a new ingest rule; a duplicate resource key opens the version guide", () => {
		expect(setupHealthAction({ id: "PII-01", affected: [] })).toEqual({
			kind: "link",
			label: "Add an ingest rule",
			href: "/settings/ingestion/rules/new",
		})
		expect(setupHealthAction({ id: "RES-06", affected: [] })).toEqual(
			setupHealthAction({ id: "RES-02", affected: [] }),
		)
	})
})
