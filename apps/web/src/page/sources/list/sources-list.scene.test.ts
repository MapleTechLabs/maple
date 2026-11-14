import { OrgId } from "@maple/domain"
import {
	encodePublicId,
	PublicIdPrefixes,
	SourcePublicId,
	V2Source,
	V2SourceUsageSummary,
} from "@maple/domain/http/v2"
import { Result, Schema, Array as Arr } from "effect"
import {
	click,
	Command,
	expect as expectView,
	expectOutMessage,
	given,
	label,
	role,
	scene,
	text,
	type,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { sourceHref } from "../kit/shared"
import { groupSources } from "./groups"
import { type PageContext, PageOutMessage } from "../../contract"
import { Message } from "./message"
import type { Model } from "./model"
import { FetchSourcesList, ResumeSource } from "./command"
import { init, update } from "./update"
import { view as pageView } from "./view"

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_parity"),
	pinnedNamespace: null,
	timeZone: "UTC",
}
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const NOW = Date.UTC(2026, 9, 1, 12)
const encodeSourceId = Schema.encodeSync(SourcePublicId)
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)

const source = (index: number, fields: Readonly<Record<string, unknown>> = {}) =>
	Schema.decodeSync(V2Source)({
		id: encodePublicId(PublicIdPrefixes.source, `0199a0e1-0000-7000-8000-00000000000${index}`),
		object: "source",
		name: `Source ${index}`,
		description: null,
		platform: "nodejs",
		kind: "token",
		is_default: false,
		key_prefix: "maple_src_Q7xZa",
		integration_id: null,
		status: "active",
		allowed_signals: null,
		rate_limit_rps: null,
		resource_attributes: [],
		expires_at: null,
		paused_at: null,
		paused_until: null,
		last_used_at: null,
		rolled_at: null,
		created_at: "2026-09-01T12:00:00.000Z",
		updated_at: "2026-09-01T12:00:00.000Z",
		health: { status: "pending", last_data_at: null, problem: null, resources: null },
		...fields,
	})

const defaultSource = source(1, {
	name: "Default",
	platform: "opentelemetry",
	kind: "default",
	is_default: true,
	key_prefix: null,
})

const loaded = (rows: ReadonlyArray<V2Source>): Model => {
	const entered = init({ _tag: "Sources" }, context).model
	return Arr.reduce(
		[
			Message.ReadClock({ nowMs: NOW }),
			Message.CompletedFetchList({ key: entered.list.key ?? "", result: Result.succeed(rows) }),
		],
		entered,
		(model, message) => pageUpdate(model, message).model,
	)
}

const health = (
	status: string,
	lastDataAt: string | null,
	extra: Readonly<Record<string, unknown>> = {},
) => ({
	status,
	last_data_at: lastDataAt,
	problem: null,
	resources: null,
	...extra,
})
const RECEIVING = health("healthy", "2026-10-01T11:56:00.000Z")

const usageOf = (model: Model, data: ReadonlyArray<Readonly<{ source: V2Source; bytes: number }>>): Model =>
	pageUpdate(
		model,
		Message.CompletedFetchUsage({
			key: model.usage.key ?? "",
			result: Result.succeed(
				Schema.decodeSync(V2SourceUsageSummary)({
					object: "source_usage_summary",
					window_start: "2026-09-30T13:00:00.000Z",
					window_end: "2026-10-01T12:00:00.000Z",
					data: Arr.map(data, ({ source: row, bytes }) => ({
						source_id: encodeSourceId(row.id),
						spans: 1200,
						logs: 300,
						metrics: 0,
						bytes,
					})),
				}),
			),
		}),
	).model

describe("sources list", () => {
	test("entry reads the clock and the list", () => {
		expect(names(init({ _tag: "Sources" }, context).commands)).toEqual(
			expect.arrayContaining(["ReadSourcesClock", "FetchSourcesList", "FetchSourcesUsage"]),
		)
	})

	test("the default source alone shows the empty state", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded([defaultSource])),
			expectView(role("link", { name: "Default" })).toExist(),
			expectView(text("Nothing sent with an org ingest key lately")).toExist(),
			expectView(text("Connect your first source")).toExist(),
			expectView(label("Search sources")).not.toExist(),
		)
	})

	test("a member without sources:manage reads the list without the connect actions", () => {
		const paused = source(2, { name: "Billing", status: "paused", health: health("paused", null) })
		const member = pageUpdate(
			loaded([defaultSource, paused]),
			Message.CompletedReadGrants({ grants: [] }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(member),
			expectView(role("link", { name: "Billing" })).toExist(),
			expectView(role("link", { name: "Connect source" })).not.toExist(),
			expectView(role("button", { name: /^Resume/ })).not.toExist(),
		)
	})

	test("an added source hides the empty state, and its name links to its page", () => {
		const added = source(2, { health: RECEIVING })
		scene(
			{ update: pageUpdate, view },
			given(loaded([added, defaultSource])),
			expectView(text("Connect your first source")).not.toExist(),
			expectView(role("heading", { name: /^Receiving/ })).toExist(),
			expectView(role("link", { name: "Source 2" })).toHaveAttr("href", sourceHref(added)),
			// A name cut off by a narrow list is still readable on hover.
			expectView(role("link", { name: "Source 2" })).toHaveAttr("title", "Source 2"),
		)
	})

	test("a failure shows the error state and retry refreshes; a stale answer is dropped", () => {
		const entered = init({ _tag: "Sources" }, context).model
		const stale = pageUpdate(
			entered,
			Message.CompletedFetchList({ key: "other", result: Result.succeed([]) }),
		).model
		expect(stale.list).toEqual(entered.list)
		const failed = Arr.reduce(
			[
				Message.ReadClock({ nowMs: NOW }),
				Message.CompletedFetchList({
					key: entered.list.key ?? "",
					result: Result.fail(toLoadFailure(new Error("boom"))),
				}),
			],
			entered,
			(model, message) => pageUpdate(model, message).model,
		)
		scene(
			{ update: pageUpdate, view },
			given(failed),
			expectView(text("Couldn't load sources")).toExist(),
		)
		expect(names(pageUpdate(failed, Message.ClickedRetry()).commands)).toEqual(["FetchSourcesList"])
	})
})

describe("the list's groups", () => {
	const checkout = source(2, { name: "Checkout", health: RECEIVING })
	const storefront = source(3, { name: "Storefront", platform: "browser", health: RECEIVING })
	const cluster = source(4, {
		name: "prod-eu",
		platform: "kubernetes",
		health: health("stale", "2026-10-01T09:00:00.000Z"),
	})
	const cloudflare = source(5, {
		name: "Cloudflare acme",
		platform: "cloudflare",
		kind: "integration",
		key_prefix: null,
		health: health("failing", null, { problem: "Token revoked", resources: { total: 3, unhealthy: 1 } }),
	})
	const billing = source(6, { name: "Billing", status: "paused", health: health("paused", null) })
	const staging = source(7, { name: "Staging" })
	const rows = [defaultSource, checkout, storefront, cluster, cloudflare, billing, staging]
	const namesOf = (group: ReadonlyArray<V2Source>) => Arr.map(group, (row) => row.name)

	test("sources to fix lead worst first, sending ones rank by what they stored, the rest wait", () => {
		const usage = new Map([
			[checkout.id, { spans: 0, logs: 0, metrics: 0, bytes: 1_000 }],
			[storefront.id, { spans: 0, logs: 0, metrics: 0, bytes: 9_000 }],
		])
		const groups = groupSources(rows, usage)
		expect(namesOf(groups.attention)).toEqual(["Cloudflare acme", "prod-eu"])
		expect(namesOf(groups.receiving)).toEqual(["Storefront", "Checkout"])
		// An unused Default source is not a fault: it waits with the paused and the new.
		expect(namesOf(groups.idle)).toEqual(["Billing", "Default", "Staging"])
		expect(namesOf(groupSources(rows, null).receiving)).toEqual(["Checkout", "Storefront"])
	})

	test("a source to fix says why and links to where it is fixed", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(rows)),
			expectView(role("heading", { name: /^Needs attention/ })).toExist(),
			expectView(text(/Failing · 1 of 3 unhealthy · Token revoked/)).toExist(),
			expectView(role("link", { name: "Review connection: Cloudflare acme" })).toHaveAttr(
				"href",
				sourceHref(cloudflare, "connection"),
			),
			expectView(text(/No recent data · last data 3h ago/)).toExist(),
			expectView(role("link", { name: "Check setup: prod-eu" })).toHaveAttr(
				"href",
				sourceHref(cluster, "setup"),
			),
			expectView(role("link", { name: "Finish setup: Staging" })).toHaveAttr(
				"href",
				sourceHref(staging, "setup"),
			),
		)
	})

	test("a healthy list has no group for sources to fix", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded([defaultSource, checkout])),
			expectView(role("heading", { name: /^Needs attention/ })).not.toExist(),
			expectView(role("link", { name: "Checkout" })).toExist(),
		)
	})

	test("a source named after its platform says what it collects instead of repeating the name", () => {
		const named = source(8, {
			name: "Cloudflare",
			platform: "cloudflare",
			kind: "integration",
			key_prefix: null,
			health: RECEIVING,
		})
		scene(
			{ update: pageUpdate, view },
			given(loaded([defaultSource, checkout, named])),
			expectView(text(/^Zone and Workers analytics/)).toExist(),
			expectView(text(/^Node\.js/)).toExist(),
		)
	})

	test("each sending source shows what it stored, and the org total leaves out deleted sources", () => {
		const model = loaded(rows)
		const deleted = source(9, { name: "Deleted" })
		scene(
			{ update: pageUpdate, view },
			given(
				usageOf(model, [
					{ source: checkout, bytes: 2_000_000 },
					{ source: storefront, bytes: 600_000 },
					{ source: deleted, bytes: 9_000_000 },
				]),
			),
			expectView(text("2.0 MB")).toExist(),
			expectView(text("600 KB")).toExist(),
			expectView(text("2.6 MB")).toExist(),
		)
	})

	test("search narrows every group by name or platform, and says when nothing matches", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(rows)),
			type(label("Search sources"), "kubernetes"),
			expectView(role("link", { name: "prod-eu" })).toExist(),
			expectView(role("link", { name: "Checkout" })).not.toExist(),
			expectView(role("heading", { name: /^Receiving/ })).not.toExist(),
			type(label("Search sources"), "nothing like this"),
			expectView(text("No sources match")).toExist(),
			click(role("button", { name: "Clear search" })),
			expectView(role("link", { name: "Checkout" })).toExist(),
		)
	})

	test("a source the gateway refuses links to its rules, for those who can change them", () => {
		const expired = source(8, {
			name: "Expired",
			status: "expired",
			expires_at: "2026-09-30T12:00:00.000Z",
			health: health("disconnected", null, { problem: "The token expired; senders get 401" }),
		})
		const model = loaded([defaultSource, expired])
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(text(/Disconnected · The token expired/)).toExist(),
			expectView(role("link", { name: "Review rules: Expired" })).toHaveAttr(
				"href",
				sourceHref(expired, "settings"),
			),
		)
		scene(
			{ update: pageUpdate, view },
			given(pageUpdate(model, Message.CompletedReadGrants({ grants: [] })).model),
			expectView(role("link", { name: /^Review rules/ })).not.toExist(),
		)
	})

	test("a Default source the gateway refuses still says why", () => {
		const refused = source(1, {
			name: "Default",
			platform: "opentelemetry",
			kind: "default",
			is_default: true,
			key_prefix: null,
			health: health("failing", "2026-10-01T11:00:00.000Z", { problem: "Over the ingest quota" }),
		})
		scene(
			{ update: pageUpdate, view },
			given(loaded([refused, checkout])),
			expectView(role("heading", { name: /^Needs attention/ })).not.toExist(),
			expectView(text(/Failing · Over the ingest quota/)).toExist(),
		)
	})

	test("Resume on a paused row resumes it in place, toasts, and reads the list again", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(rows)),
			click(role("button", { name: "Resume: Billing" })),
			Command.resolve(ResumeSource, Message.CompletedResume({ result: Result.succeed(billing) })),
			expectOutMessage(
				PageOutMessage.RequestedToast({
					type: "success",
					title: "Source resumed. Takes effect within a minute.",
					description: "",
				}),
			),
			// The list is read again; this answer carries an old key, so the model keeps waiting.
			Command.resolve(
				FetchSourcesList,
				Message.CompletedFetchList({ key: "superseded", result: Result.succeed(rows) }),
			),
		)
	})

	test("a resume in flight holds the other rows' Resume, and a refusal frees them", () => {
		const other = source(9, { name: "Other", status: "paused", health: health("paused", null) })
		const clicked = pageUpdate(loaded([...rows, other]), Message.ClickedResume({ id: billing.id }))
		expect(names(clicked.commands)).toEqual(["ResumeSource"])
		scene(
			{ update: pageUpdate, view },
			given(clicked.model),
			expectView(role("button", { name: "Resume: Other" })).toBeDisabled(),
		)
		expect(pageUpdate(clicked.model, Message.ClickedResume({ id: other.id })).commands).toBeUndefined()
		const refused = pageUpdate(
			clicked.model,
			Message.CompletedResume({ result: Result.fail(toLoadFailure(new Error("boom"))) }),
		)
		expect(refused.outMessage).toMatchObject({ _tag: "RequestedToast", type: "error" })
		scene(
			{ update: pageUpdate, view },
			given(refused.model),
			expectView(role("button", { name: "Resume: Other" })).toBeEnabled(),
		)
	})

	test("a resume reads the list again even while an earlier read is in flight", () => {
		const refreshing = pageUpdate(loaded(rows), Message.ClickedRetry())
		expect(names(refreshing.commands)).toEqual(["FetchSourcesList"])
		const resumed = pageUpdate(
			{ ...refreshing.model, resuming: billing.id },
			Message.CompletedResume({ result: Result.succeed(billing) }),
		)
		expect(names(resumed.commands)).toEqual(["FetchSourcesList"])
		expect(resumed.model.list.key).not.toBe(refreshing.model.list.key)
	})
})
