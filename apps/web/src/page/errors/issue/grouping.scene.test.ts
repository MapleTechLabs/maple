import { OrgId } from "@maple/domain"
import {
	ErrorIssueFingerprintGrouping,
	ErrorIssueGroupingResponse,
	ErrorIssueId,
	ErrorIssueSimilarIssue,
	ErrorIssueSimilarResponse,
	IsoDateTimeString,
} from "@maple/domain/http"
import { encodePublicId, V2ErrorIssueDetail } from "@maple/domain/http/v2"
import { Array as Arr, Result, Schema } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { click, Command, expect as expectView, given, role, scene, text } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { refusalFailure } from "../../kit/refusal"
import type { PageContext } from "../../contract"
import { SplitOutFingerprint } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { init, routeChanged, update } from "./update"
import { groupingTab, ruleLabel } from "./view-grouping"

// The Grouping tab reads only once it is open on a loaded issue, and its split and merge
// settle with the server's message beside the row, or by reading the issue again.

const orgId = Schema.decodeSync(OrgId)("org_acme")
const issueId = Schema.decodeSync(ErrorIssueId)("0199a004-0000-7000-8000-000000000001")
const similarId = Schema.decodeSync(ErrorIssueId)("0199a004-0000-7000-8000-000000000002")
const iso = Schema.decodeSync(IsoDateTimeString)
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-01 00:00:00", endTime: "2026-10-01 12:00:00" }
const NOW = Date.UTC(2026, 9, 1, 12)
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)

const wire = Schema.decodeSync(V2ErrorIssueDetail)({
	id: encodePublicId("iss", issueId),
	object: "error_issue",
	kind: "error",
	fingerprint_hash: "12660752272409977512",
	service_name: "payment-svc",
	exception_type: "ConnectionTimeout",
	exception_message: "timed out acquiring a connection",
	error_label: "ConnectionTimeout",
	top_frame: "at acquire (pool.ts:42)",
	workflow_state: "triage",
	priority: 1,
	severity: "high",
	severity_source: null,
	source_ref: null,
	assigned_actor: null,
	lease_holder: null,
	lease_expires_at: null,
	claimed_at: null,
	notes: null,
	first_seen_at: "2026-10-01T10:00:00.000Z",
	last_seen_at: "2026-10-01T11:44:00.000Z",
	occurrence_count: 12,
	resolved_at: null,
	last_resolved_at: null,
	last_regressed_at: null,
	regression_count: 0,
	resolved_versions: [],
	snooze_until: null,
	archived_at: null,
	has_open_incident: false,
	comment_count: 0,
	open_pull_request_count: 0,
	merged_pull_request_count: 0,
	timeseries: [],
	sample_traces: [],
	incidents: [],
	environments: [],
})

const fingerprint = (fields: Partial<ConstructorParameters<typeof ErrorIssueFingerprintGrouping>[0]>) =>
	new ErrorIssueFingerprintGrouping({
		fingerprintHash: "111",
		source: "primary",
		rule: "type-message",
		orgRule: null,
		pinned: false,
		exceptionType: "ConnectionTimeout",
		messageSignature: "timed out acquiring a connection",
		frames: [],
		skippedFrames: [],
		customKey: null,
		sampledAt: null,
		...fields,
	})

const grouping = new ErrorIssueGroupingResponse({
	truncated: false,
	fingerprints: [
		fingerprint({}),
		fingerprint({
			fingerprintHash: "222",
			source: "group",
			rule: "type-function",
			messageSignature: "",
			frames: ["    at acquire (db/pool.ts:42:7)"],
			skippedFrames: ["    at dispatch (hono/dist/hono-base.js:188:23)"],
		}),
	],
})

const similar = new ErrorIssueSimilarResponse({
	issues: [
		new ErrorIssueSimilarIssue({
			id: similarId,
			serviceName: "payment-svc",
			exceptionType: "ConnectionTimeout",
			exceptionMessage: "timed out acquiring a pooled connection",
			errorLabel: "ConnectionTimeout",
			workflowState: "triage",
			occurrenceCount: 40,
			lastSeenAt: iso("2026-10-01T11:00:00.000Z"),
			similarity: 0.8,
		}),
	],
})

const loadedOn = (search: Model["search"]) => {
	const windowed = pageUpdate(
		init({ issueId, search }, context).model,
		Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
	).model
	return pageUpdate(
		windowed,
		Message.CompletedFetchDetail({ key: windowed.detail.key ?? "", result: Result.succeed(wire) }),
	)
}

const answered = (): Model => {
	const model = loadedOn({ tab: "grouping" }).model
	return Arr.reduce(
		[
			Message.CompletedFetchGrouping({
				key: model.grouping.key ?? "",
				result: Result.succeed(grouping),
			}),
			Message.CompletedFetchSimilar({ key: model.similar.key ?? "", result: Result.succeed(similar) }),
		],
		model,
		(next, message) => pageUpdate(next, message).model,
	)
}

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	groupingTab(h, model, { nowMs: NOW, timeZone: "UTC" })

describe("issue grouping", () => {
	test("the Overview tab never reads grouping; opening the Grouping tab does, once", () => {
		const overview = loadedOn({})
		expect(names(overview.commands)).not.toContain("FetchErrorIssueGrouping")
		const opened = routeChanged(overview.model, { search: { tab: "grouping" } }, context)
		expect(names(opened.commands)).toContain("FetchErrorIssueGrouping")
		expect(names(opened.commands)).toContain("FetchErrorIssueSimilar")
		const again = routeChanged(opened.model, { search: { tab: "grouping" } }, context)
		expect(names(again.commands)).not.toContain("FetchErrorIssueGrouping")
	})

	test("a page entered on the Grouping tab waits for the issue before it reads", () => {
		const entered = init({ issueId, search: { tab: "grouping" } }, context)
		expect(names(entered.commands)).not.toContain("FetchErrorIssueGrouping")
		expect(names(loadedOn({ tab: "grouping" }).commands)).toContain("FetchErrorIssueGrouping")
	})

	test("rules read in plain words, naming the function a type-function key read", () => {
		expect(ruleLabel(grouping.fingerprints[1] ?? fingerprint({}))).toBe(
			"Same type, first function acquire",
		)
		expect(ruleLabel(fingerprint({ rule: "org-rule", orgRule: "Pool timeouts" }))).toBe(
			"Org rule: Pool timeouts",
		)
		expect(ruleLabel(fingerprint({ rule: null }))).toBe("Not keyed yet")
	})

	test("a refused split shows the server's message under its fingerprint", () => {
		scene(
			{ update: pageUpdate, view },
			given(answered()),
			click(role("button", { name: "Split out" })),
			Command.expectExact(SplitOutFingerprint({ issueId, fingerprintHash: "222" })),
			Command.resolve(
				SplitOutFingerprint,
				Message.CompletedSplitOut({
					fingerprintHash: "222",
					result: Result.fail(
						refusalFailure(
							"Couldn't split out the fingerprint",
							"Only a grouped fingerprint can be split out.",
						),
					),
				}),
			),
			expectView(role("alert")).toHaveText("Only a grouped fingerprint can be split out."),
		)
	})

	test("a merge reads the issue and the tab again once it lands", () => {
		const merging = pageUpdate(answered(), Message.ClickedMergeSimilar({ sourceIssueId: similarId }))
		expect(names(merging.commands)).toContain("MergeSimilarErrorIssue")
		expect(
			pageUpdate(merging.model, Message.ClickedSplitOut({ fingerprintHash: "222" })).commands,
		).toBeUndefined()
		const done = pageUpdate(
			merging.model,
			Message.CompletedMergeSimilar({ sourceIssueId: similarId, result: Result.succeed(null) }),
		)
		expect(done.model.mergingIssueId).toBeNull()
		expect(done.outMessage).toMatchObject({ type: "success", title: "Merged into this issue" })
		expect(names(done.commands)).toEqual(
			expect.arrayContaining([
				"FetchErrorIssueDetail",
				"FetchErrorIssueGrouping",
				"FetchErrorIssueSimilar",
			]),
		)
	})

	test("skipped frames stay folded until asked for", () => {
		scene(
			{ update: pageUpdate, view },
			given(answered()),
			expectView(text("at dispatch (hono/dist/hono-base.js:188:23)")).toBeAbsent(),
			click(role("button", { name: "1 skipped as library or runtime frames" })),
			expectView(text("at dispatch (hono/dist/hono-base.js:188:23)")).toExist(),
		)
	})
})
