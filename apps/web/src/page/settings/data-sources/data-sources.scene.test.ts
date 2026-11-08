import { it } from "@effect/vitest"
import {
	encodePublicId,
	MapleApiV2,
	PublicIdPrefixes,
	V2DataSource,
	V2DataSourceCatalog,
} from "@maple/domain/http/v2"
import { Array as Arr, Effect, Layer, Option, Ref, Result, Schema } from "effect"
import { HttpClient, HttpClientResponse, UrlParams } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { AsyncData } from "foldkit"
import { expect as expectView, scene, given, role, selector, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { MapleApiV2Client } from "../../../platform/api-clients"
import { listSources } from "./command"
import { clerkInstanceOf, draftErrors } from "./draft"
import { Message, type Model } from "./model"
import { init, update } from "./update"
import { view as tabView } from "./view"
import { visibleErrors } from "./view-form"

const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)

const source = Schema.decodeSync(V2DataSource)({
	id: encodePublicId(PublicIdPrefixes.dataSource, "6f1c2a4e-8d3b-4c7a-9e21-3b5d7f9a1c2e"),
	object: "data_source",
	name: "shop-prod",
	kind: "clickhouse",
	query_language: "sql:clickhouse",
	description: "Production storefront database",
	environment: "production",
	tags: ["shop"],
	agent_access: true,
	agent_pii: false,
	connection: { type: "clickhouse", url: "https://ch.example.com:8443", user: "reader", database: "shop" },
	has_secret: true,
	secret_hint: "9f2c",
	status: "error",
	last_checked_at: "2026-11-08T12:00:00.000Z",
	last_error: "connection refused",
	catalog_refreshed_at: null,
	catalog_error: null,
	catalog_entry_count: 0,
	created_at: "2026-11-08T12:00:00.000Z",
	updated_at: "2026-11-08T12:00:00.000Z",
})

const view = withViewInputs(tabView, {
	canManage: true,
	nowMs: Date.parse("2026-11-08T12:00:00Z"),
	timeZone: "UTC",
})()

const loaded = (sources: ReadonlyArray<V2DataSource>): Model =>
	update(init().model, Message.CompletedFetchSources({ result: Result.succeed(sources) })).model

const step = (model: Model, ...messages: ReadonlyArray<Message>): Model =>
	Arr.reduce(messages, model, (current, message) => update(current, message).model)

const type = (field: "name" | "description" | "url" | "user" | "password" | "secretKey", value: string) =>
	Message.ChangedField({ field, value })

describe("data sources tab", () => {
	test("reads the list on entry and shows the empty state's list when there is none", () => {
		expect(names(init().commands)).toEqual(["FetchDataSources"])
		const empty = loaded([])
		expect(AsyncData.getOrElse(empty.sources, () => null)).toEqual([])
		expect(empty.screen._tag).toBe("List")
	})

	test("connect goes through the kind picker into an empty form", () => {
		const model = step(loaded([source]), Message.ClickedConnect(), Message.ClickedKind({ kind: "clerk" }))
		expect(model.screen).toEqual({ _tag: "Form", kind: "clerk", editing: null })
		expect(model.draft.name).toBe("")
	})

	test("a submit without a description or with a bad slug sends nothing and names both fields", () => {
		const form = step(loaded([]), Message.ClickedConnect(), Message.ClickedKind({ kind: "clickhouse" }))
		expect(visibleErrors(form, "clickhouse", false)).toEqual({})
		const filled = step(
			form,
			type("name", "Shop Prod"),
			type("url", "https://ch.example.com"),
			type("user", "reader"),
		)
		const submitted = update(filled, Message.ClickedSubmit())
		expect(names(submitted.commands)).toEqual([])
		const errors = visibleErrors(submitted.model, "clickhouse", false)
		expect(errors.name).toContain("lowercase")
		expect(errors.description).toContain("Assistants read it")
	})

	test("a valid ClickHouse form creates the source with the password and nothing blank", () => {
		const form = step(
			loaded([]),
			Message.ClickedKind({ kind: "clickhouse" }),
			type("name", "shop-prod"),
			type("description", "  Orders and payments "),
			type("url", "https://ch.example.com:8443"),
			type("user", "reader"),
			type("password", "s3cret"),
		)
		const submitted = update(form, Message.ClickedSubmit())
		expect(submitted.commands?.[0]).toMatchObject({
			name: "CreateDataSource",
			args: {
				payload: {
					name: "shop-prod",
					description: "Orders and payments",
					connection: {
						type: "clickhouse",
						url: "https://ch.example.com:8443",
						user: "reader",
						database: "default",
						password: "s3cret",
					},
				},
			},
		})
		expect(submitted.model.isSaving).toBe(true)
	})

	test("a Clerk key names its instance, and editing keeps the stored key when left blank", () => {
		expect(clerkInstanceOf("sk_live_abc")).toBe("production")
		expect(clerkInstanceOf("sk_test_abc")).toBe("development")
		expect(clerkInstanceOf("pk_live_abc")).toBeNull()
		const draft = { ...init().model.draft, name: "clerk-prod", description: "Users", secretKey: "" }
		expect(draftErrors(draft, "clerk", false).secretKey).toContain("sk_live_")
		expect(draftErrors(draft, "clerk", true).secretKey).toBeUndefined()
	})

	test("an edit without a new password sends no connection", () => {
		const form = step(
			loaded([source]),
			Message.ClickedEdit({ id: source.id }),
			type("description", "Orders only"),
		)
		const submitted = update(form, Message.ClickedSubmit())
		expect(submitted.commands?.[0]).toMatchObject({ name: "UpdateDataSource" })
		expect(submitted.commands?.[0]).not.toHaveProperty("args.payload.connection")
	})

	test("a failed connection keeps the form open with the source's message, a taken name lands on the field", () => {
		const form = step(loaded([]), Message.ClickedKind({ kind: "clickhouse" }))
		const failure = {
			_tag: "@maple/http/data-sources/DataSourceInvalidError",
			type: "invalid_request_error",
			code: "data_source_invalid",
			title: "Invalid data source",
			message: "Could not connect: connection refused",
			retryable: false,
			recovery: "fix_request",
			param: "connection",
		} as const
		const refused = update(form, Message.CompletedSave({ result: Result.fail(failure) })).model
		expect(refused.screen._tag).toBe("Form")
		expect(refused.saveError?.message).toBe("Could not connect: connection refused")
		const taken = update(
			form,
			Message.CompletedSave({
				result: Result.fail({ ...failure, message: "Name taken", param: "name" }),
			}),
		)
		expect(visibleErrors(taken.model, "clickhouse", false).name).toBe("Name taken")
	})

	test("opening a source reads its catalog, and a saved source opens with a toast", () => {
		expect(names(update(loaded([source]), Message.ClickedOpen({ id: source.id })).commands)).toEqual([
			"FetchDataSourceCatalog",
		])
		const saved = update(
			step(loaded([]), Message.ClickedKind({ kind: "clickhouse" })),
			Message.CompletedSave({ result: Result.succeed({ ...source, warnings: [] }) }),
		)
		expect(saved.model.screen).toEqual({ _tag: "Detail", id: source.id })
		expect(saved.outMessage).toMatchObject({ title: "Connected shop-prod" })
	})

	test("a connect whose test warns shows the warning on the source it opens", () => {
		const form = step(loaded([]), Message.ClickedConnect(), Message.ClickedKind({ kind: "clickhouse" }))
		const saved = update(
			form,
			Message.CompletedSave({
				result: Result.succeed({ ...source, warnings: ["This user can write"] }),
			}),
		).model
		expect(saved.screen).toEqual({ _tag: "Detail", id: source.id })
		scene(
			{ update, view },
			given(saved),
			expectView(text("Connected, with a warning")).toExist(),
			expectView(text("This user can write")).toExist(),
		)
	})

	test("an opened catalog entry lists a field's sample values", () => {
		const catalog = Schema.decodeSync(V2DataSourceCatalog)({
			object: "data_source_catalog",
			source_id: source.id,
			refreshed_at: null,
			error: null,
			entries: [
				{
					object: "data_source_catalog_entry",
					name: "shop.payments",
					kind: "table",
					exposed: true,
					note: null,
					row_estimate: null,
					time_field: null,
					detected_time_field: null,
					fields: [
						{
							name: "status",
							type: "string",
							native_type: "LowCardinality(String)",
							note: null,
							pii: false,
							sample_values: ["paid", "refunded", "failed"],
						},
					],
				},
			],
		})
		const opened = step(
			loaded([source]),
			Message.ClickedOpen({ id: source.id }),
			Message.CompletedFetchCatalog({ id: source.id, result: Result.succeed(catalog) }),
			Message.ClickedEditEntry({ name: "shop.payments" }),
		)
		scene({ update, view }, given(opened), expectView(text("e.g. paid, refunded, failed")).toExist())
	})

	test("a catalog that arrives after the admin opened another source is dropped", () => {
		const other = Schema.decodeSync(V2DataSource)({
			...Schema.encodeSync(V2DataSource)(source),
			id: encodePublicId(PublicIdPrefixes.dataSource, "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"),
			name: "clerk-dev",
		})
		const stale = Schema.decodeSync(V2DataSourceCatalog)({
			object: "data_source_catalog",
			source_id: source.id,
			refreshed_at: null,
			error: null,
			entries: [],
		})
		const model = step(
			loaded([source, other]),
			Message.ClickedOpen({ id: source.id }),
			Message.ClickedOpen({ id: other.id }),
			Message.CompletedFetchCatalog({ id: source.id, result: Result.succeed(stale) }),
		)
		expect(Option.isNone(AsyncData.getData(model.catalog))).toBe(true)
	})

	describe("catalog curation", () => {
		const payments = (curated: { note: string | null; time_field: string | null }) =>
			Schema.decodeSync(V2DataSourceCatalog)({
				object: "data_source_catalog",
				source_id: source.id,
				refreshed_at: null,
				error: null,
				entries: [
					{
						object: "data_source_catalog_entry",
						name: "shop.payments",
						kind: "table",
						exposed: true,
						row_estimate: null,
						detected_time_field: "created_at",
						...curated,
						fields: [
							{
								name: "created_at",
								type: "timestamp",
								native_type: null,
								note: null,
								pii: false,
								sample_values: [],
							},
							{
								name: "paid_at",
								type: "timestamp",
								native_type: null,
								note: null,
								pii: false,
								sample_values: [],
							},
						],
					},
				],
			})
		const editing = (catalog: V2DataSourceCatalog) =>
			step(
				loaded([source]),
				Message.ClickedOpen({ id: source.id }),
				Message.CompletedFetchCatalog({ id: source.id, result: Result.succeed(catalog) }),
				Message.ClickedEditEntry({ name: "shop.payments" }),
			)
		const reported = payments({ note: "Amounts in cents", time_field: "created_at" })

		test("clearing the note and choosing no time field sends empty strings, which hide the detected ones", () => {
			const opened = editing(reported)
			expect(opened.entryDraft?.timeField).toBeNull()
			scene({ update, view }, given(opened), expectView(text("Detected (created_at)")).toExist())
			const saved = update(
				step(
					opened,
					Message.ChangedEntryNote({ value: "  " }),
					Message.ChangedEntryTimeField({ value: "" }),
				),
				Message.ClickedSaveEntry(),
			)
			expect(saved.commands?.[0]).toMatchObject({
				name: "UpdateDataSourceCatalogEntry",
				args: { payload: { note: "", time_field: "" } },
			})
		})

		test("choosing detected sends null, and an entry set to none opens on none", () => {
			const hidden = editing(payments({ note: null, time_field: null }))
			expect(hidden.entryDraft?.timeField).toBe("")
			const saved = update(
				step(hidden, Message.ChangedEntryTimeField({ value: null })),
				Message.ClickedSaveEntry(),
			)
			expect(saved.commands?.[0]).toMatchObject({ args: { payload: { time_field: null } } })
			expect(saved.commands?.[0]).not.toHaveProperty("args.payload.note")
		})

		test("a failed save keeps the edits open with the error, and a retry that lands closes the editor", () => {
			const saving = update(
				step(editing(reported), Message.ChangedEntryNote({ value: "One row per attempt" })),
				Message.ClickedSaveEntry(),
			).model
			expect(saving.entryDraft?.note).toBe("One row per attempt")
			const failure = {
				_tag: "@maple/http/data-sources/DataSourceStorageUnavailableError",
				type: "api_error",
				code: "data_sources_unavailable",
				title: "Data sources temporarily unavailable",
				message: "The database did not answer",
				retryable: true,
				recovery: "retry",
			} as const
			const failed = update(
				saving,
				Message.CompletedUpdateEntry({
					name: "shop.payments",
					fromEditor: true,
					result: Result.fail(failure),
				}),
			)
			expect(failed.outMessage).toBeUndefined()
			expect(failed.model.entryDraft?.note).toBe("One row per attempt")
			scene(
				{ update, view },
				given(failed.model),
				expectView(text("Could not save the notes")).toExist(),
				expectView(text("The database did not answer")).toExist(),
			)
			const retried = update(failed.model, Message.ClickedSaveEntry())
			expect(names(retried.commands)).toEqual(["UpdateDataSourceCatalogEntry"])
			const entry = payments({ note: "One row per attempt", time_field: "created_at" }).entries[0]!
			const landed = update(
				retried.model,
				Message.CompletedUpdateEntry({
					name: "shop.payments",
					fromEditor: true,
					result: Result.succeed(entry),
				}),
			).model
			expect(landed.entryDraft).toBeNull()
			expect(landed.entryError).toBeNull()
		})

		test("while one entry is edited, another row cannot open and replace its unsaved notes", () => {
			const two = Schema.decodeSync(V2DataSourceCatalog)({
				...Schema.encodeSync(V2DataSourceCatalog)(reported),
				entries: [
					...Schema.encodeSync(V2DataSourceCatalog)(reported).entries,
					{ ...Schema.encodeSync(V2DataSourceCatalog)(reported).entries[0]!, name: "shop.orders" },
				],
			})
			const typed = step(editing(two), Message.ChangedEntryNote({ value: "Unsaved" }))
			const clicked = step(typed, Message.ClickedEditEntry({ name: "shop.orders" }))
			expect(clicked.entryDraft).toMatchObject({ name: "shop.payments", note: "Unsaved" })
			scene(
				{ update, view },
				given(typed),
				expectView(role("button", { name: "Fields and notes" })).toBeDisabled(),
				expectView(role("button", { name: "Close" })).toBeEnabled(),
			)
		})

		test("the time field picker announces its hint", () => {
			scene(
				{ update, view },
				given(editing(reported)),
				expectView(selector('[id="catalog-shop.payments-time"]')).toHaveAttr(
					"aria-describedby",
					"catalog-shop.payments-time-description",
				),
			)
		})
	})

	test("an empty catalog says so while it refreshes too", () => {
		const empty = Schema.decodeSync(V2DataSourceCatalog)({
			object: "data_source_catalog",
			source_id: source.id,
			refreshed_at: null,
			error: null,
			entries: [],
		})
		const refreshing = step(
			loaded([source]),
			Message.ClickedOpen({ id: source.id }),
			Message.CompletedFetchCatalog({ id: source.id, result: Result.succeed(empty) }),
			Message.ClickedRefreshCatalog(),
			Message.CompletedRefreshCatalog({ id: source.id, result: Result.succeed(source) }),
		)
		expect(AsyncData.isRefreshing(refreshing.catalog)).toBe(true)
		scene(
			{ update, view },
			given(refreshing),
			expectView(text(/No tables or resources found yet/)).toExist(),
		)
	})

	test("a refresh answer for a source the admin left neither blocks nor toasts over the open one", () => {
		const other = Schema.decodeSync(V2DataSource)({
			...Schema.encodeSync(V2DataSource)(source),
			id: encodePublicId(PublicIdPrefixes.dataSource, "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e"),
			name: "clerk-dev",
		})
		const onOther = step(
			loaded([source, other]),
			Message.ClickedOpen({ id: source.id }),
			Message.ClickedRefreshCatalog(),
			Message.ClickedBack(),
			Message.ClickedOpen({ id: other.id }),
		)
		const refreshOther = update(onOther, Message.ClickedRefreshCatalog())
		expect(names(refreshOther.commands)).toEqual(["RefreshDataSourceCatalog"])
		const late = update(
			refreshOther.model,
			Message.CompletedRefreshCatalog({ id: source.id, result: Result.succeed(source) }),
		)
		expect(late.outMessage).toBeUndefined()
		expect(names(late.commands)).toEqual([])
		expect(late.model.refreshingId).toBe(other.id)
	})

	test("the description announces its hint, and its error once one shows", () => {
		const form = step(loaded([]), Message.ClickedKind({ kind: "clickhouse" }))
		scene(
			{ update, view },
			given(form),
			expectView(selector("#data-source-description")).toHaveAttr(
				"aria-describedby",
				"data-source-description-description",
			),
		)
		scene(
			{ update, view },
			given(step(form, Message.ClickedSubmit())),
			expectView(selector("#data-source-description")).toHaveAttr(
				"aria-describedby",
				"data-source-description-description data-source-description-error",
			),
		)
	})
})

it.effect("the list reads every page of sources, following next_cursor", () =>
	Effect.gen(function* () {
		const cursors = yield* Ref.make<ReadonlyArray<string | null>>([])
		const encode = Schema.encodeSync(V2DataSource)
		const second = Schema.decodeSync(V2DataSource)({
			...encode(source),
			id: encodePublicId(PublicIdPrefixes.dataSource, "7a2d3b5f-9e4c-4d8b-8f32-4c6e8a0b2d3f"),
			name: "shop-eu",
		})
		const pages = [
			{ data: [encode(source)], has_more: true, next_cursor: "page-2" },
			{ data: [encode(second)], has_more: false, next_cursor: null },
		]
		const http = HttpClient.make((request) =>
			Ref.modify(cursors, (seen) => [
				seen.length,
				[...seen, Option.getOrNull(UrlParams.getFirst(request.urlParams, "cursor"))],
			]).pipe(
				Effect.map((index) =>
					HttpClientResponse.fromWeb(
						request,
						Response.json({ object: "list", ...pages[Math.min(index, pages.length - 1)] }),
					),
				),
			),
		)
		const client = Layer.effect(
			MapleApiV2Client,
			HttpApiClient.make(MapleApiV2, { baseUrl: "https://api.test" }),
		).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, http)))
		const sources = yield* listSources.pipe(Effect.provide(client))
		expect(Arr.map(sources, (row) => row.name)).toEqual(["shop-prod", "shop-eu"])
		expect(yield* Ref.get(cursors)).toEqual([null, "page-2"])
	}),
)
