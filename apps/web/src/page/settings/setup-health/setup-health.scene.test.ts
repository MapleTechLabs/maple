import { V2SetupAudit } from "@maple/domain/http/v2"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { AsyncData } from "foldkit"
import { describe, expect, test } from "vitest"
import { healthSegments, orderFindings, resolvedChecks, setupHealthAction } from "./derive"
import { Message } from "./model"
import { init, update } from "./update"
import { view } from "./view"
import type { HtmlBuilder } from "foldkit/html"
import { click, expect as expectView, given, role, scene, text } from "foldkit/scene"
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
	test("opening passing checks shows unavailable capability detail, entities and the capped remainder, but no skip detail", () => {
		const audit = Schema.decodeSync(V2SetupAudit)({
			...report,
			summary: { ...report.summary, pass: 1, skip: 1 },
			checks: [
				{
					object: "setup_audit_check",
					id: "CFG-INTEG-02",
					category: "integrations",
					title: "Cloudflare datasets are collecting",
					severity: "warn",
					status: "pass",
					detail: "2 datasets not included in the Cloudflare plan.",
					affected: [
						{
							kind: "integration",
							id: null,
							name: "firewall_events · example.com",
							note: "unavailable",
						},
					],
					affected_count: 2,
					fix_hint: "Review Cloudflare settings.",
				},
				{
					object: "setup_audit_check",
					id: "TRC-01",
					category: "traces",
					title: "Traces have complete parents",
					severity: "warn",
					status: "skip",
					detail: "Requires telemetry data, which is currently unavailable.",
					affected: [],
					affected_count: 0,
					fix_hint: "Restore warehouse access.",
				},
			],
		})
		const model = update(
			init().model,
			Message.CompletedFetchAudit({ result: Result.succeed(audit) }),
		).model
		scene(
			{
				update,
				view: (model, h: HtmlBuilder<Message>) =>
					h.submodel({
						slotId: "audit",
						model,
						view,
						toParentMessage: (message) => message,
						viewInputs: { nowMs: 0, timeZone: "UTC" },
					}),
			},
			given(model),
			click(role("button", { name: /Passing/ })),
			expectView(text("2 datasets not included in the Cloudflare plan.")).toExist(),
			expectView(text("firewall_events · example.com")).toExist(),
			expectView(text("+1 more")).toExist(),
			expectView(text("Skipped")).toExist(),
			expectView(text("Requires telemetry data, which is currently unavailable.")).not.toExist(),
		)
	})
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
			href: "/settings/ingestion",
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
