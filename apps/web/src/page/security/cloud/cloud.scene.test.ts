import { OrgId } from "@maple/domain"
import { CLOUD_FINDING_SOURCE_SPECS } from "@maple/domain/cloud-security"
import { CloudFindingNotFoundError, CloudSecurityPersistenceError } from "@maple/domain/http"
import { Result, Schema, Array as Arr, String as Str } from "effect"
import { expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "@maple/views/data/load-failure"
import {
	allClearOverview,
	firstReadPendingOverview,
	CLOUD_DETAIL_SEARCH,
	cloudFindingDetailOf,
	cloudFindingsOf,
	failingOverview,
	moduleOverview,
	noCloudFindings,
	noConnectionOverview,
	populatedOverview,
} from "../../../lab/security-cloud-fixture"
import { AppRoute, hrefOf } from "../../../route"
import type { PageContext } from "../../contract"
import { listRequestOf } from "./derive"
import { type FindingsPage, Message, type Model, type Overview, type Search } from "./model"
import { init, routeChanged, update } from "./update"
import { view as pageView } from "./view"

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_acme"),
	pinnedNamespace: null,
	timeZone: "UTC",
}
const NOW = Date.UTC(2026, 10, 16, 12, 0)
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)

const listRoute = (search: Search = {}) => AppRoute.SecurityCloud({ search })
const detailRoute = AppRoute.SecurityCloudFinding({ search: CLOUD_DETAIL_SEARCH })

const answered = (
	route: Parameters<typeof init>[0],
	messages: ReadonlyArray<(model: Model) => Message>,
): Model =>
	Arr.reduce(
		[() => Message.ReadClock({ nowMs: NOW }), ...messages],
		init(route, context).model,
		(model, toMessage) => pageUpdate(model, toMessage(model)).model,
	)

const overviewIs = (overview: Overview) => (model: Model) =>
	Message.CompletedFetchOverview({ key: model.overview.key ?? "", result: Result.succeed(overview) })
const pageIs = (page: FindingsPage) => (model: Model) =>
	Message.CompletedFetchFirstPage({ key: model.firstPage.key ?? "", result: Result.succeed(page) })

const listed = (overview: Overview, page: FindingsPage = noCloudFindings, search: Search = {}) =>
	answered(listRoute(search), [overviewIs(overview), pageIs(page)])

describe("security cloud findings", () => {
	test("the list reads the overview and its first page; a finding reads the overview and itself", () => {
		expect(names(init(listRoute(), context).commands)).toEqual(
			expect.arrayContaining(["SecurityApiCloudOverview", "SecurityApiCloudFirstPage"]),
		)
		expect(names(init(detailRoute, context).commands)).toEqual(
			expect.arrayContaining(["SecurityApiCloudOverview", "SecurityApiCloudFinding"]),
		)
		expect(names(init(detailRoute, context).commands)).not.toContain("SecurityApiCloudFirstPage")
		// Back to the list from a finding: the overview already read is kept.
		const back = routeChanged(
			answered(detailRoute, [overviewIs(populatedOverview(NOW))]),
			listRoute(),
			context,
		)
		expect(names(back.commands)).toEqual(["SecurityApiCloudFirstPage"])
	})

	test("an org without AWS is pointed at connecting it with the security module", () => {
		scene(
			{ update: pageUpdate, view },
			given(listed(noConnectionOverview)),
			expectView(text("Connect AWS to see its security findings")).toExist(),
			expectView(role("link", { name: "Connect AWS" })).toHaveAttr(
				"href",
				hrefOf(AppRoute.SourcesNew({ search: { integration: "aws" } })),
			),
			expectView(role("table", { name: "Cloud findings" })).toBeAbsent(),
		)
	})

	test("a connection that does not ask for the module, or is not granted it yet, says what to do", () => {
		const manage = hrefOf(AppRoute.Integrations({ search: { integration: "aws" } }))
		scene(
			{ update: pageUpdate, view },
			given(listed(moduleOverview("not_requested"))),
			expectView(text("Turn on the Security scan module")).toExist(),
			expectView(role("link", { name: "Open the AWS connection" })).toHaveAttr("href", manage),
		)
		scene(
			{ update: pageUpdate, view },
			given(listed(moduleOverview("requested"))),
			expectView(text("Update the AWS stack to finish")).toExist(),
			expectView(role("link", { name: "Get the updated stack" })).toHaveAttr("href", manage),
		)
	})

	test("a service that is off in a region is named, with where to turn it on", () => {
		scene(
			{ update: pageUpdate, view },
			given(listed(populatedOverview(NOW), cloudFindingsOf(NOW))),
			expectView(text("Inspector is off in eu-west-1")).toExist(),
			expectView(role("link", { name: "Turn on Inspector" })).toHaveAttr(
				"href",
				CLOUD_FINDING_SOURCE_SPECS.inspector.enableUrl,
			),
		)
	})

	test("a failing or refused service shows the error it reported", () => {
		scene(
			{ update: pageUpdate, view },
			given(listed(failingOverview(NOW))),
			expectView(text("Reading Security Hub failed in eu-west-1, us-east-1")).toExist(),
			expectView(text("ThrottlingException: Rate exceeded")).toExist(),
			expectView(text("The role may not read IAM Access Analyzer in us-east-1")).toExist(),
			expectView(role("link", { name: "Update the AWS stack" })).toExist(),
			expectView(text("No active findings from the services that answered")).toExist(),
			expectView(text("No active findings")).toBeAbsent(),
		)
	})

	test("findings list with the services their resource serves, and a link to each finding", () => {
		const page = cloudFindingsOf(NOW)
		const first = page.findings[0]
		scene(
			{ update: pageUpdate, view },
			given(listed(populatedOverview(NOW), page)),
			expectView(role("table", { name: "Cloud findings" })).toExist(),
			expectView(text("checkout-api and 1 more, 1.3K requests")).toExist(),
			expectView(text("payments-webhook, 312 requests")).toExist(),
			expectView(text("No telemetry")).toExist(),
			expectView(role("link", { name: first?.title ?? "" })).toHaveAttr(
				"href",
				hrefOf(AppRoute.SecurityCloudFinding({ search: CLOUD_DETAIL_SEARCH })),
			),
		)
	})

	test("a page read without telemetry says so instead of claiming no service is affected", () => {
		const page = cloudFindingsOf(NOW)
		scene(
			{ update: pageUpdate, view },
			given(
				listed(populatedOverview(NOW), {
					...page,
					telemetryMatched: false,
					findings: Arr.map(page.findings, (finding) => ({ ...finding, affectedServices: [] })),
				}),
			),
			expectView(text("No telemetry")).toBeAbsent(),
			expectView(
				text("Telemetry could not be fully read just now, so affected services may be missing."),
			).toExist(),
		)
	})

	test("before the first read an empty list says it is waiting, not all clear", () => {
		scene(
			{ update: pageUpdate, view },
			given(listed(firstReadPendingOverview)),
			expectView(text("Waiting for the first read")).toExist(),
			expectView(text("No active findings")).toBeAbsent(),
		)
	})

	test("before the first read a filtered empty list still says it is waiting", () => {
		scene(
			{ update: pageUpdate, view },
			given(listed(firstReadPendingOverview, noCloudFindings, { severity: "critical" })),
			expectView(text("Waiting for the first read")).toExist(),
			expectView(text("No findings match these filters")).toBeAbsent(),
		)
	})

	test("a search longer than the API takes is cut to it, not dropped", () => {
		const long = Str.repeat(250)("x")
		expect(listRequestOf({ q: long })).toEqual({ search: Str.repeat(200)("x") })
		const model = listed(populatedOverview(NOW), cloudFindingsOf(NOW))
		const typed = pageUpdate(model, Message.ChangedSearchText({ value: long }))
		expect(pageUpdate(typed.model, Message.SubmittedSearch()).outMessage).toMatchObject({
			url: hrefOf(listRoute({ q: Str.repeat(200)("x") })),
		})
	})

	test("no active finding anywhere reads as all clear", () => {
		scene(
			{ update: pageUpdate, view },
			given(listed(allClearOverview(NOW))),
			expectView(text("No active findings")).toExist(),
			expectView(text("No findings match these filters")).toBeAbsent(),
		)
	})

	test("says which services' findings arrive live, and that the rest are polled", () => {
		const polled = allClearOverview(NOW)
		scene(
			{ update: pageUpdate, view },
			given(listed(polled)),
			expectView(
				text(/^Checked every five minutes, and live once AWS sends a finding event/u),
			).toExist(),
		)
		const pushed = (sources: ReadonlyArray<string>) => ({
			...polled,
			services: Arr.map(polled.services, (service) =>
				sources.includes(service.source) ? { ...service, pushedAt: NOW - 60_000 } : service,
			),
		})
		scene(
			{ update: pageUpdate, view },
			given(listed(pushed(["guardduty"]))),
			expectView(text(/^Live for GuardDuty: their findings arrive/u)).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(listed(pushed(["guardduty", "securityhub", "inspector", "access_analyzer"]))),
			expectView(text("Live: findings arrive as AWS reports them.")).toExist(),
		)
		// Only GuardDuty and Inspector are on, and both deliver: every enabled service is live.
		const twoOn = {
			...polled,
			services: Arr.filter(pushed(["guardduty", "inspector"]).services, (service) =>
				["guardduty", "inspector"].includes(service.source),
			),
		}
		scene(
			{ update: pageUpdate, view },
			given(listed(twoOn)),
			expectView(text("Live: findings arrive as AWS reports them.")).toExist(),
		)
		// Events that stopped over a week ago no longer count, as the poller no longer counts them.
		const stale = {
			...polled,
			services: Arr.map(polled.services, (service) => ({
				...service,
				pushedAt: NOW - 8 * 24 * 60 * 60_000,
			})),
		}
		scene(
			{ update: pageUpdate, view },
			given(listed(stale)),
			expectView(
				text(/^Checked every five minutes, and live once AWS sends a finding event/u),
			).toExist(),
		)
	})

	test("a severity tile and the filters move the URL; the request drops values it has no name for", () => {
		const model = listed(populatedOverview(NOW), cloudFindingsOf(NOW))
		const tile = pageUpdate(model, Message.ChangedFilter({ filter: "severity", value: "critical" }))
		expect(tile.outMessage).toMatchObject({ url: hrefOf(listRoute({ severity: "critical" })) })
		const typed = pageUpdate(model, Message.ChangedSearchText({ value: "  ssh " }))
		expect(pageUpdate(typed.model, Message.SubmittedSearch()).outMessage).toMatchObject({
			url: hrefOf(listRoute({ q: "ssh" })),
		})
		expect(
			listRequestOf({ severity: "urgent", source: "guardduty", region: "moon", q: " ssh " }),
		).toEqual({
			sources: ["guardduty"],
			search: "ssh",
		})
	})

	test("a filter picked while a search is only typed puts the box back to the applied search", () => {
		const model = listed(populatedOverview(NOW), cloudFindingsOf(NOW))
		const typed = pageUpdate(model, Message.ChangedSearchText({ value: "ssh" }))
		const filtered = pageUpdate(typed.model, Message.ChangedFilter({ filter: "severity", value: "high" }))
		expect(filtered.model.searchText).toBe("")
	})

	test("new filters read a new first page", () => {
		const model = listed(populatedOverview(NOW), cloudFindingsOf(NOW))
		const moved = routeChanged(model, listRoute({ source: "guardduty" }), context)
		expect(names(moved.commands)).toEqual(["SecurityApiCloudFirstPage"])
	})

	test("a list that failed to load reads again on retry", () => {
		const model = answered(listRoute(), [
			overviewIs(populatedOverview(NOW)),
			(current) =>
				Message.CompletedFetchFirstPage({
					key: current.firstPage.key ?? "",
					result: Result.fail(
						toLoadFailure(new CloudSecurityPersistenceError({ message: "down" })),
					),
				}),
		])
		expect(names(pageUpdate(model, Message.ClickedRetry()).commands)).toContain(
			"SecurityApiCloudFirstPage",
		)
	})

	test("a finding shows its resource, affected services and the way to it in the AWS console", () => {
		const detail = cloudFindingDetailOf(NOW)
		const model = answered(detailRoute, [
			overviewIs(populatedOverview(NOW)),
			(current) =>
				Message.CompletedFetchFinding({
					key: current.detail.key ?? "",
					result: Result.succeed(detail),
				}),
		])
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(text(detail.finding.title)).toExist(),
			expectView(text("i-0c3f9a2b1d4e5f678")).toExist(),
			expectView(role("link", { name: /Open in AWS console/ })).toHaveAttr(
				"href",
				detail.finding.consoleUrl,
			),
			expectView(role("link", { name: "checkout-api" })).toHaveAttr(
				"href",
				hrefOf(AppRoute.Service({ serviceName: "checkout-api", search: {} })),
			),
			expectView(role("link", { name: "All cloud findings" })).toExist(),
		)
	})

	test("a finding the store no longer has, or an incomplete link, says so", () => {
		const gone = answered(detailRoute, [
			overviewIs(populatedOverview(NOW)),
			(current) =>
				Message.CompletedFetchFinding({
					key: current.detail.key ?? "",
					result: Result.fail(
						toLoadFailure(new CloudFindingNotFoundError({ message: "No such finding." })),
					),
				}),
		])
		scene(
			{ update: pageUpdate, view },
			given(gone),
			expectView(text("This finding is not here")).toExist(),
		)
		const incomplete = answered(AppRoute.SecurityCloudFinding({ search: { id: "f-1" } }), [
			overviewIs(populatedOverview(NOW)),
		])
		expect(
			names(init(AppRoute.SecurityCloudFinding({ search: { id: "f-1" } }), context).commands),
		).not.toContain("SecurityApiCloudFinding")
		scene(
			{ update: pageUpdate, view },
			given(incomplete),
			expectView(text("This finding is not here")).toExist(),
		)
	})

	test("the rail lists Cloud and marks it open", () => {
		scene(
			{ update: pageUpdate, view },
			given(listed(populatedOverview(NOW), cloudFindingsOf(NOW))),
			expectView(role("navigation", { name: "Security sources" })).toExist(),
			expectView(role("link", { name: /Cloud/ })).toHaveAttr("href", hrefOf(listRoute())),
		)
	})
})
