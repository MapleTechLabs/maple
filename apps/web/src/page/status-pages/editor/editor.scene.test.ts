import { statusPageOrgKey } from "@maple/domain/status-page"
import * as Animation from "@foldkit/ui/animation"
import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import {
	StatusPageComponentPublicId,
	type StatusPageConfig,
	StatusPagePreviewParams,
	StatusPagePublicId,
	type V2StatusPage,
	type V2StatusPageCustomDomain,
} from "@maple/domain/http/v2"
import { DEFAULT_STATUS_PAGE_THEME } from "@maple/domain/status-page"
import { flow, Option, Order, Result, Schema, Array as Arr, String as Str } from "effect"
import {
	type AnyCommand,
	type SceneSimulation,
	all,
	attr,
	change,
	Command,
	click,
	expect as expectView,
	expectAll,
	find,
	findAll,
	given,
	inside,
	keydown,
	Mount,
	role,
	scene,
	selector,
	submit,
	tap,
	text,
	type,
	withViewInputs,
	within,
} from "foldkit/scene"
import { AsyncData } from "foldkit"
import { describe, expect, test } from "vitest"
import * as Dialog from "@maple/views/ui/dialog"
import { ColorPickerMessage, MountColorPicker } from "@maple/views/ui/color-picker"
import { MountDialog } from "@maple/views/ui/dialog"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { StatusPageSlugTakenError } from "@maple/domain/http"
import { PageOutMessage, type PageContext } from "../../contract"
import { statusPageHref, statusPagesHref } from "../shared/commands"
import { selectionOf } from "../shared/preview"
import { ORG } from "../../kit/alert-test-rows"
import { downMonitor, httpMonitor } from "../../kit/uptime/test-monitors"
import {
	component,
	componentId,
	incident,
	incidentId,
	updateId,
	statusPage,
	statusPageConfig,
} from "../shared/test-pages"
import * as Combobox from "@maple/views/ui/combobox"
import { groupPickerValue } from "../shared/group-picker"
import { PickerMessage } from "../shared/picker"
import {
	CheckCustomDomain,
	FetchComponents,
	FetchEditorPreview,
	FetchPage,
	FocusEditorElement,
	ReadEditorClock,
	RemoveCustomDomain,
	RemovePassword,
	ReorderComponents,
	RevealOpenComponent,
	SaveVisibility,
	SetCustomDomain,
	WaitEditorPreview,
} from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { init, routeChanged, update } from "./update"
import { groupedOrder } from "../shared/component-order"
import { componentGripId, groupGripId } from "./update-components"
import { customDomainOf } from "./update-domain"
import { canvasDocument } from "./view-canvas"
import { maintenanceDurationMs } from "./view-incidents"
import { type Focused, popupOwnsEscape } from "./subscription"
import { removeComponentCopy, view as pageView } from "./view"

const KEY = statusPageOrgKey(ORG)

const ADMIN = Policy.grantsOf(["org:admin"])
const MEMBER = Policy.grantsOf(["org:member"])

const orgId = Schema.decodeSync(OrgId)(ORG)
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)
const PUBLIC_ID = Schema.encodeSync(StatusPagePublicId)(statusPage().id)

type Fixture = Readonly<{
	tab?: string
	section?: string
	page?: V2StatusPage
	grants?: ReadonlyArray<Policy.Permission>
	components?: ReturnType<typeof component>[]
	incidents?: ReturnType<typeof incident>[]
	monitorsFail?: boolean
	componentsFail?: boolean
	/** The config read's document; by default the page and its components. */
	config?: StatusPageConfig
	configFail?: boolean
	/** The custom domain read; by default none set on a deployment that offers them. */
	customDomain?: V2StatusPageCustomDomain
}>

/** The custom domain read as the API answers it. */
const customDomain = (fields: Partial<V2StatusPageCustomDomain> = {}): V2StatusPageCustomDomain => ({
	object: "status_page_custom_domain",
	page_id: statusPage().id,
	available: true,
	cname_target: "status-domains.maple.dev",
	hostname: null,
	status: null,
	dns_records: [],
	last_error: null,
	last_checked_at: null,
	activated_at: null,
	created_at: null,
	...fields,
})

const pendingDomain = customDomain({
	hostname: "status.acme.com",
	status: "pending_dns",
	dns_records: [
		{ type: "CNAME", name: "status.acme.com", value: "status-domains.maple.dev", purpose: "routing" },
		{
			type: "TXT",
			name: "_cf-custom-hostname.status.acme.com",
			value: "4d0b9f6e-owner",
			purpose: "ownership",
		},
	],
	last_error: "custom hostname does not CNAME to this zone.",
	created_at: "2026-10-01T12:00:00.000Z",
})

/** A new claim: nothing is set up until its ownership record is found. */
const unprovenDomain = customDomain({
	hostname: "status.acme.com",
	status: "pending_dns",
	dns_records: [
		{ type: "CNAME", name: "status.acme.com", value: "status-domains.maple.dev", purpose: "routing" },
		{
			type: "TXT",
			name: "_maple-challenge.status.acme.com",
			value: "maple-status-page=1c2ba8fdad86fbbe9cdd85449b0e85c6",
			purpose: "ownership",
		},
	],
	created_at: "2026-10-01T12:00:00.000Z",
})

const loaded = (fixture: Fixture = {}): Model => {
	const entered = init(
		{
			_tag: "StatusPage",
			pageId: PUBLIC_ID,
			search: { view: fixture.tab, section: fixture.section },
		},
		context,
	).model
	return Arr.reduce(
		[
			Message.ReadClock({ nowMs: Date.UTC(2026, 9, 1, 12) }),
			Message.CompletedFetchSession({ orgId: ORG, grants: fixture.grants ?? ADMIN }),
			Message.CompletedFetchPage({
				key: entered.page.key ?? "",
				result: Result.succeed(fixture.page ?? statusPage()),
			}),
			Message.CompletedFetchComponents({
				key: entered.components.key ?? "",
				result: fixture.componentsFail
					? Result.fail(toLoadFailure(new Error("components unavailable")))
					: Result.succeed(fixture.components ?? [component(1), component(2), component(3)]),
			}),
			Message.CompletedFetchIncidents({
				key: entered.incidents.key ?? "",
				result: Result.succeed(fixture.incidents ?? []),
			}),
			Message.CompletedFetchMonitors({
				key: entered.monitors.key ?? "",
				result: fixture.monitorsFail
					? Result.fail(toLoadFailure(new Error("monitors unavailable")))
					: Result.succeed([httpMonitor(), downMonitor()]),
			}),
			Message.CompletedFetchCustomDomain({
				key: entered.customDomain.key ?? "",
				result: Result.succeed(fixture.customDomain ?? customDomain()),
			}),
			// Only Settings > Advanced reads the config.
			...(entered.config.key === null
				? []
				: [
						Message.CompletedFetchConfig({
							key: entered.config.key,
							result: fixture.configFail
								? Result.fail(toLoadFailure(new Error("config unavailable")))
								: Result.succeed(
										fixture.config ??
											statusPageConfig(
												fixture.page ?? statusPage(),
												fixture.components ?? [
													component(1),
													component(2),
													component(3),
												],
											),
									),
						}),
					]),
		],
		entered,
		(model, message) => pageUpdate(model, message).model,
	)
}

describe("status page editor", () => {
	test("entering reads the page, its components, incidents and the monitors", () => {
		const entered = init({ _tag: "StatusPage", pageId: PUBLIC_ID, search: {} }, context)
		const sent = names(entered.commands)
		expect(sent).toContain("FetchStatusPage")
		expect(sent).toContain("FetchStatusPageComponents")
		expect(sent).toContain("FetchStatusPageIncidents")
		expect(sent).toContain("FetchStatusPageMonitors")
	})

	test("fresh page and incident reads re-read the clock, so relative times never run ahead", () => {
		const entered = init({ _tag: "StatusPage", pageId: PUBLIC_ID, search: {} }, context).model
		const afterPage = pageUpdate(
			entered,
			Message.CompletedFetchPage({ key: entered.page.key ?? "", result: Result.succeed(statusPage()) }),
		)
		const afterIncidents = pageUpdate(
			entered,
			Message.CompletedFetchIncidents({ key: entered.incidents.key ?? "", result: Result.succeed([]) }),
		)
		expect(names(afterPage.commands)).toContain("ReadStatusPageClock")
		expect(names(afterIncidents.commands)).toContain("ReadStatusPageClock")
	})

	test("the preview reads monitor history even when the page lands after the components' debounce", () => {
		const entered = init({ _tag: "StatusPage", pageId: PUBLIC_ID, search: {} }, context).model
		const settle = (model: Model) =>
			pageUpdate(model, Message.ElapsedPreviewDebounce({ generation: model.previewGeneration }))
		const withComponents = pageUpdate(
			entered,
			Message.CompletedFetchComponents({
				key: entered.components.key ?? "",
				result: Result.succeed([component(1)]),
			}),
		).model
		const early = settle(withComponents)
		expect(names(early.commands)).toEqual([])
		const withPage = pageUpdate(
			early.model,
			Message.CompletedFetchPage({ key: entered.page.key ?? "", result: Result.succeed(statusPage()) }),
		)
		expect(names(withPage.commands)).toContain("WaitStatusPageEditorPreview")
		expect(names(settle(withPage.model).commands)).toEqual(["FetchStatusPageEditorPreview"])
	})

	test("an id that is not a page id shows not found without a read", () => {
		const entered = init({ _tag: "StatusPage", pageId: "nope", search: {} }, context)
		expect(names(entered.commands)).not.toContain("FetchStatusPage")
		scene(
			{ update: pageUpdate, view },
			given(entered.model),
			expectView(text("Status page not found")).toExist(),
		)
	})

	test("the header shows the worst component, here one whose monitor is down", () => {
		const model = loaded({ components: [component(1), component(2, { monitor_id: downMonitor().id })] })
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(role("heading", { name: /^Acme Status\s*Major outage$/u })).toExist(),
		)
	})
})

describe("read failures", () => {
	test("a failed monitors read shows an error, not every component Operational", () => {
		const model = loaded({
			components: [component(1, { monitor_id: downMonitor().id })],
			monitorsFail: true,
		})
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(text("Couldn't load the page's components")).toExist(),
			expectView(role("heading", { name: /^Acme Status$/u })).toExist(),
			expectView(text("Operational")).not.toExist(),
		)
	})
})

const MONITORS = { tab: "settings", section: "monitors" } as const

/** The `srcdoc` of the frame titled `title`; "" without one. */
const srcdocOf =
	(title: string) =>
	(html: Parameters<ReturnType<typeof find>>[0]): string =>
		Option.getOrElse(
			Option.flatMap(find(`maple-preview-frame[frame-title="${title}"]`)(html), attr("srcdoc")),
			() => "",
		)
const APPEARANCE = { tab: "settings", section: "appearance" } as const
const ACCESS = { tab: "settings", section: "basic" } as const
const ADVANCED = { tab: "settings", section: "advanced" } as const
const BASIC = { tab: "settings", section: "basic" } as const

/** Settings > Monitors with one component open. */
const selected = (componentNumber: number, fixture: Fixture = {}) =>
	pageUpdate(
		loaded({ ...MONITORS, ...fixture }),
		Message.ClickedComponent({ componentId: componentId(componentNumber) }),
	).model

const revealed = Mount.resolve(RevealOpenComponent, Message.CompletedFocus())

type ArgsSchema = Schema.Top & { readonly DecodingServices: never }

/** The args of each pending `name` Command. */
const argsOf = <S extends ArgsSchema>(
	commands: ReadonlyArray<AnyCommand>,
	name: string,
	schema: S,
): ReadonlyArray<S["Type"]> =>
	Arr.map(
		Arr.filter(commands, (command) => command.name === name),
		(command) => Schema.decodeSync(schema)(command.args),
	)

const READ_ARGS = Schema.Struct({ key: Schema.String })

type Step = <M, Msg, Out>(simulation: SceneSimulation<M, Msg, Out>) => SceneSimulation<M, Msg, Out>

/** Each pending `name` Command, answered from its args. */
const answerEach =
	<S extends ArgsSchema>(name: string, schema: S, answer: (args: S["Type"]) => Step): Step =>
	(simulation) =>
		Arr.reduce(argsOf(simulation.commands, name, schema), simulation, (current, args) =>
			answer(args)(current),
		)

/**
 * The reorder saves, and what it reads again comes back as saved: the components and the page,
 * then the clock and the preview those reads refresh.
 */
const reorderLands = (rows: ReadonlyArray<ReturnType<typeof component>>): Step =>
	flow(
		Command.resolve(ReorderComponents, Message.CompletedReorder({ result: Result.succeed(rows) })),
		answerEach("FetchStatusPageComponents", READ_ARGS, ({ key }) =>
			Command.resolve(
				FetchComponents,
				Message.CompletedFetchComponents({ key, result: Result.succeed(rows) }),
			),
		),
		answerEach("FetchStatusPage", READ_ARGS, ({ key }) =>
			Command.resolve(
				FetchPage,
				Message.CompletedFetchPage({ key, result: Result.succeed(statusPage()) }),
			),
		),
		Command.resolve(ReadEditorClock, Message.ReadClock({ nowMs: Date.UTC(2026, 9, 1, 12) })),
		answerEach(
			"WaitStatusPageEditorPreview",
			Schema.Struct({ generation: Schema.Number }),
			({ generation }) =>
				Command.resolve(
					WaitEditorPreview({ generation }),
					Message.ElapsedPreviewDebounce({ generation }),
				),
		),
		answerEach(
			"FetchStatusPageEditorPreview",
			Schema.Struct({ generation: Schema.Number, draft: StatusPagePreviewParams }),
			({ generation, draft }) =>
				Command.resolve(
					FetchEditorPreview,
					Message.CompletedFetchPreview({
						generation,
						draft,
						result: Result.fail(toLoadFailure(new Error("preview unavailable"))),
					}),
				),
		),
	)

/** The rows' grips, top to bottom. */
const gripOrder = (html: Parameters<ReturnType<typeof find>>[0]): ReadonlyArray<string> =>
	Arr.getSomes(Arr.map(findAll(html, 'button[aria-label^="Reorder "]'), attr("aria-label")))

describe("components under Settings > Monitors", () => {
	test("a drop moves the row at once and sends nothing until Save, which sends the whole order once", () => {
		const dropped = pageUpdate(
			loaded(MONITORS),
			Message.DroppedComponent({ componentId: componentId(1), index: 2 }),
		)
		expect(dropped.commands ?? []).toEqual([])
		scene(
			{ update: pageUpdate, view },
			given(dropped.model),
			tap(({ html }) =>
				expect(gripOrder(html)).toEqual([
					"Reorder Component 2",
					"Reorder Component 3",
					"Reorder Component 1",
				]),
			),
			expectView(text("Unsaved changes")).toExist(),
			expectView(text("New order")).toExist(),
		)
		const saving = pageUpdate(dropped.model, Message.ClickedSaveMonitors())
		expect(saving.commands).toMatchObject([
			{
				name: "ReorderStatusPageComponents",
				args: { componentIds: [componentId(2), componentId(3), componentId(1)] },
			},
		])
		// One order save at a time: a drop while it is in flight moves nothing.
		expect(
			pageUpdate(saving.model, Message.DroppedComponent({ componentId: componentId(2), index: 0 }))
				.model.pendingOrder,
		).toEqual(saving.model.pendingOrder)
		const done = pageUpdate(saving.model, Message.CompletedReorder({ result: Result.succeed([]) }))
		expect(names(done.commands)).toContain("FetchStatusPageComponents")
		scene(
			{ update: pageUpdate, view },
			given(done.model),
			// Kept as saved until the re-read brings the server's order.
			tap(({ html }) =>
				expect(gripOrder(html)).toEqual([
					"Reorder Component 2",
					"Reorder Component 3",
					"Reorder Component 1",
				]),
			),
			expectView(text("Unsaved changes")).not.toExist(),
		)
	})

	test("a drop on the slot it came from, past the end it is already at, or back where it was saved leaves nothing to save", () => {
		const model = loaded(MONITORS)
		expect(
			pageUpdate(model, Message.DroppedComponent({ componentId: componentId(2), index: 1 })).model,
		).toEqual(model)
		expect(
			pageUpdate(model, Message.DroppedComponent({ componentId: componentId(3), index: 9 })).model,
		).toEqual(model)
		const back = steps(model, [
			Message.DroppedComponent({ componentId: componentId(1), index: 2 }),
			Message.DroppedComponent({ componentId: componentId(1), index: 0 }),
		])
		scene({ update: pageUpdate, view }, given(back), expectView(text("Unsaved changes")).not.toExist())
		expect(pageUpdate(back, Message.ClickedSaveMonitors()).commands ?? []).toEqual([])
	})

	test("Discard puts the saved order back", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(MONITORS)),
			keydown(role("button", { name: "Reorder Component 1" }), "ArrowDown"),
			Command.resolve(FocusEditorElement, Message.CompletedFocus()),
			click(role("button", { name: "Discard" })),
			Command.expectNone(),
			tap(({ html }) =>
				expect(gripOrder(html)).toEqual([
					"Reorder Component 1",
					"Reorder Component 2",
					"Reorder Component 3",
				]),
			),
			expectView(text("Unsaved changes")).not.toExist(),
		)
	})

	test("the page preview follows the unsaved order; the live page keeps the saved one", () => {
		const dropped = pageUpdate(
			loaded(MONITORS),
			Message.DroppedComponent({ componentId: componentId(3), index: 0 }),
		).model
		const page = srcdocOf("Acme Status with these settings")
		/** The components' names in the order a document first mentions them. */
		const namesIn = (document: string) =>
			Arr.sortBy(
				Order.mapInput(Order.Number, (name: string) =>
					Option.getOrElse(Str.indexOf(name)(document), () => -1),
				),
			)(["Component 1", "Component 2", "Component 3"])
		scene(
			{ update: pageUpdate, view },
			given(dropped),
			tap(({ html }) =>
				expect(namesIn(page(html))).toEqual(["Component 3", "Component 1", "Component 2"]),
			),
		)
		expect(namesIn(canvasDocument(dropped, statusPage()))).toEqual([
			"Component 1",
			"Component 2",
			"Component 3",
		])
	})

	test("an unsaved order saves with the open component's edits, each write on its own", () => {
		const both = steps(selected(2), [
			Message.DroppedComponent({ componentId: componentId(2), index: 0 }),
			Message.ChangedComponentField({ field: "name", value: "Payments" }),
		])
		scene({ update: pageUpdate, view }, given(both), expectView(text("New order, Component 2")).toExist())
		const saving = pageUpdate(both, Message.ClickedSaveMonitors())
		expect(saving.commands).toMatchObject([
			{
				name: "ReorderStatusPageComponents",
				args: { componentIds: [componentId(2), componentId(1), componentId(3)] },
			},
			{
				name: "SaveStatusPageComponent",
				args: { componentId: componentId(2), payload: { name: "Payments" } },
			},
		])
		// The component lands; the order is refused and stays pending with why.
		const settled = steps(saving.model, [
			Message.CompletedSaveComponent({ result: Result.succeed(component(2, { name: "Payments" })) }),
			Message.CompletedReorder({ result: Result.fail(toLoadFailure(new Error("refused"))) }),
		])
		scene(
			{ update: pageUpdate, view },
			given(settled),
			expectView(text("Couldn't save the order")).toExist(),
			expectView(text("New order")).toExist(),
			tap(({ html }) =>
				expect(gripOrder(html)).toEqual([
					"Reorder Payments",
					"Reorder Component 1",
					"Reorder Component 3",
				]),
			),
		)
		// Save tries the order again, alone.
		expect(names(pageUpdate(settled, Message.ClickedSaveMonitors()).commands)).toEqual([
			"ReorderStatusPageComponents",
		])
	})

	test("an unsaved order belongs to no row: opening another one or leaving Monitors keeps it without asking", () => {
		const dropped = pageUpdate(
			selected(1),
			Message.DroppedComponent({ componentId: componentId(3), index: 0 }),
		).model
		const opened = pageUpdate(dropped, Message.ClickedComponent({ componentId: componentId(2) })).model
		expect(opened.discardComponentDialog.isOpen).toBe(false)
		expect(opened.panel).toEqual({ _tag: "Component", componentId: componentId(2) })
		const away = routeChanged(opened, { _tag: "StatusPage", pageId: PUBLIC_ID, search: {} }, context)
		const back = routeChanged(
			away.model,
			{ _tag: "StatusPage", pageId: PUBLIC_ID, search: { view: "settings", section: "monitors" } },
			context,
		)
		scene(
			{ update: pageUpdate, view },
			given(back.model),
			expectView(text("New order")).toExist(),
			tap(({ html }) => expect(gripOrder(html)[0]).toBe("Reorder Component 3")),
		)
	})

	test("each row's grip says what it reorders and how; a member sees it locked", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(MONITORS)),
			expectView(role("button", { name: "Reorder Component 1" })).toHaveAccessibleDescription(
				"Drag, or press the up and down arrow keys, to move it within its group.",
			),
		)
		scene(
			{ update: pageUpdate, view },
			given(loaded({ ...MONITORS, grants: MEMBER })),
			expectView(text("Component 1")).toExist(),
			expectView(role("button", { name: "Reorder Component 1" })).toBeDisabled(),
			expectView(role("button", { name: "Reorder Component 1" })).not.toHaveAccessibleDescription(
				"Drag, or press the up and down arrow keys, to move it within its group.",
			),
		)
	})

	test("ArrowDown on a grip moves its row one slot and keeps focus on that grip; Save sends the order", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(MONITORS)),
			keydown(role("button", { name: "Reorder Component 1" }), "ArrowDown"),
			Command.expectExact(FocusEditorElement({ id: componentGripId(componentId(1)) })),
			tap(({ html }) =>
				expect(gripOrder(html)).toEqual([
					"Reorder Component 2",
					"Reorder Component 1",
					"Reorder Component 3",
				]),
			),
			Command.resolve(FocusEditorElement, Message.CompletedFocus()),
			click(role("button", { name: "Save" })),
			Command.expectExact(
				ReorderComponents({
					pageId: statusPage().id,
					componentIds: [componentId(2), componentId(1), componentId(3)],
				}),
			),
			reorderLands([component(2), component(1), component(3)]),
			// The saved order reads back as shown.
			tap(({ html }) =>
				expect(gripOrder(html)).toEqual([
					"Reorder Component 2",
					"Reorder Component 1",
					"Reorder Component 3",
				]),
			),
			expectView(text("Unsaved changes")).not.toExist(),
		)
	})

	test("the first row's grip cannot go up and the last's cannot go down", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded({ ...MONITORS, components: [component(1), component(2)] })),
			keydown(role("button", { name: "Reorder Component 1" }), "ArrowUp"),
			Command.expectNone(),
			keydown(role("button", { name: "Reorder Component 2" }), "ArrowDown"),
			Command.expectNone(),
			tap(({ html }) =>
				expect(gripOrder(html)).toEqual(["Reorder Component 1", "Reorder Component 2"]),
			),
		)
	})

	test("a component opens in its row with its fields, and a second click closes it", () => {
		const target = component(2, { name: "API", group: "Core", manual_status: "degraded" })
		scene(
			{ update: pageUpdate, view },
			given(loaded({ ...MONITORS, components: [component(1), target] })),
			click(role("button", { name: /^API/u })),
			// Expanded in place: nothing scrolls.
			Mount.expectNone(),
			expectView(role("button", { name: /^API/u })).toHaveAttr("aria-expanded", "true"),
			expectView(role("textbox", { name: "Shown as" })).toHaveValue("API"),
			expectView(role("combobox", { name: "Group: Core" })).toExist(),
			expectView(text("Degraded, set under Override status.")).toExist(),
			click(role("button", { name: /^API/u })),
			Command.resolve(FocusEditorElement, Message.CompletedFocus()),
			expectView(role("textbox", { name: "Shown as" })).not.toExist(),
			expectView(role("button", { name: /^API/u })).toHaveAttr("aria-expanded", "false"),
		)
	})

	test("groups list where their first member is, as on the public page, ungrouped ones too", () => {
		// The page opens on an ungrouped component, so "No group" leads.
		const rows = [
			component(1),
			component(2, { group: "Core" }),
			component(3),
			component(4, { group: "Core" }),
		]
		expect(Arr.map(groupedOrder(rows), (row) => row.id)).toEqual([
			componentId(1),
			componentId(3),
			componentId(2),
			componentId(4),
		])
		scene(
			{ update: pageUpdate, view },
			given(loaded({ ...MONITORS, components: rows })),
			expectAll(all.role("list")).toHaveCount(2),
			tap(({ html }) =>
				expect(
					Option.flatMap(find('[aria-label="Components"] ul')(html), attr("aria-label")),
				).toEqual(Option.some("No group")),
			),
			// Each group's last row stops at its end rather than joining the next group.
			keydown(role("button", { name: "Reorder Component 3" }), "ArrowDown"),
			Command.expectNone(),
			keydown(role("button", { name: "Reorder Component 2" }), "ArrowUp"),
			Command.expectNone(),
		)
	})

	test("a drop moves a component within its group and leaves every other where it was", () => {
		const rows = [
			component(1),
			component(2, { group: "Core" }),
			component(3),
			component(4, { group: "Core" }),
		]
		expect(
			pageUpdate(
				steps(loaded({ components: rows }), [
					Message.DroppedComponent({ componentId: componentId(3), index: 0 }),
				]),
				Message.ClickedSaveMonitors(),
			).commands,
		).toMatchObject([
			{
				name: "ReorderStatusPageComponents",
				args: { componentIds: [componentId(3), componentId(2), componentId(1), componentId(4)] },
			},
		])
	})

	test("a group moves with its components, by its grip or the arrow keys, and waits for Save", () => {
		const rows = [
			component(1, { group: "Core" }),
			component(2, { group: "Edge" }),
			component(3, { group: "Core" }),
			component(4),
		]
		const model = loaded({ ...MONITORS, components: rows })
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(role("button", { name: "Reorder group Core" })).toExist(),
			expectView(role("button", { name: "Reorder group No group" })).toExist(),
		)
		const dropped = steps(model, [Message.DroppedGroup({ group: "Edge", index: 0 })])
		expect(pageUpdate(dropped, Message.ClickedSaveMonitors()).commands).toMatchObject([
			{
				name: "ReorderStatusPageComponents",
				args: { componentIds: [componentId(2), componentId(1), componentId(3), componentId(4)] },
			},
		])
		const nudged = pageUpdate(model, Message.PressedMoveGroup({ group: null, offset: -1 }))
		expect(nudged.commands).toMatchObject([
			{ name: "FocusStatusPageEditorElement", args: { id: groupGripId(null) } },
		])
		expect(pageUpdate(nudged.model, Message.ClickedSaveMonitors()).commands).toMatchObject([
			{
				name: "ReorderStatusPageComponents",
				args: { componentIds: [componentId(1), componentId(3), componentId(4), componentId(2)] },
			},
		])
	})

	test("the page preview follows the open component as typed, with no preview of its own", () => {
		const editing = pageUpdate(
			selected(2, { components: [component(1, { group: "Core" }), component(2, { group: "Core" })] }),
			Message.ChangedComponentField({ field: "name", value: "Payments" }),
		).model
		const page = srcdocOf("Acme Status with these settings")
		scene(
			{ update: pageUpdate, view },
			given(editing),
			expectView(
				selector('maple-preview-frame[frame-title="Component 2 as visitors see it"]'),
			).not.toExist(),
			tap(({ html }) => {
				expect(page(html)).toContain("Payments")
				expect(page(html)).toContain("Core")
			}),
		)
	})

	test("a click in the live page opens the component under Monitors and the incident under its tab", () => {
		const model = loaded({ incidents: [incident(1), incident(2, { kind: "maintenance" })] })
		const picked = pageUpdate(
			model,
			Message.ReceivedPreviewSelection({ kind: "component", id: componentId(3) }),
		)
		expect(picked.model.panel).toEqual({ _tag: "Component", componentId: componentId(3) })
		expect(picked.model.componentForm.name).toBe("Component 3")
		expect(picked.outMessage).toMatchObject({
			_tag: "RequestedNavigation",
			url: statusPageHref(statusPage().id, "settings", "monitors"),
		})
		// Landing on Monitors keeps the component open.
		const landed = routeChanged(
			picked.model,
			{ _tag: "StatusPage", pageId: PUBLIC_ID, search: { view: "settings", section: "monitors" } },
			context,
		)
		expect(landed.model.panel).toEqual({ _tag: "Component", componentId: componentId(3) })
		// Opened from the page, its row scrolls into view as it mounts.
		// Once: the reveal's completion drops it, so a later remount of the row stays put.
		scene(
			{ update: pageUpdate, view },
			given(landed.model),
			revealed,
			Mount.expectEnded(RevealOpenComponent),
		)
		const incidentPicked = pageUpdate(
			model,
			Message.ReceivedPreviewSelection({ kind: "incident", id: incidentId(1) }),
		)
		expect(incidentPicked.model.panel).toEqual({ _tag: "Incident", incidentId: incidentId(1) })
		expect(incidentPicked.model.panelSheet.isOpen).toBe(true)
		expect(incidentPicked.outMessage).toMatchObject({ url: statusPageHref(statusPage().id, "incidents") })
		expect(
			pageUpdate(model, Message.ReceivedPreviewSelection({ kind: "incident", id: incidentId(2) }))
				.outMessage,
		).toMatchObject({ url: statusPageHref(statusPage().id, "maintenance") })
		expect(
			pageUpdate(model, Message.ReceivedPreviewSelection({ kind: "component", id: "elsewhere" })).model
				.panel,
		).toBeNull()
	})

	test("a click in a Settings preview opens the component under Monitors, in place when already there, and the incident under its tab", () => {
		const onAppearance = loaded({ tab: "settings", section: "appearance" })
		const picked = pageUpdate(
			onAppearance,
			Message.ReceivedPreviewSelection({ kind: "component", id: componentId(2) }),
		)
		expect(picked.model.panel).toEqual({ _tag: "Component", componentId: componentId(2) })
		expect(picked.outMessage).toMatchObject({
			_tag: "RequestedNavigation",
			url: statusPageHref(statusPage().id, "settings", "monitors"),
		})
		const onMonitors = loaded({ tab: "settings", section: "monitors" })
		const inPlace = pageUpdate(
			onMonitors,
			Message.ReceivedPreviewSelection({ kind: "component", id: componentId(2) }),
		)
		expect(inPlace.model.panel).toEqual({ _tag: "Component", componentId: componentId(2) })
		expect(inPlace.outMessage).toBeUndefined()
		expect(
			pageUpdate(
				loaded({ tab: "settings", section: "monitors", incidents: [incident(1)] }),
				Message.ReceivedPreviewSelection({ kind: "incident", id: incidentId(1) }),
			).outMessage,
		).toMatchObject({ url: statusPageHref(statusPage().id, "incidents") })
	})

	test("a click on the header or footer opens the section that edits it, then reveals the field", () => {
		const clicked = pageUpdate(
			loaded(),
			Message.ReceivedPreviewSelection({ kind: "field", id: "supportUrl" }),
		)
		expect(clicked.outMessage).toMatchObject({
			url: statusPageHref(statusPage().id, "settings", "appearance"),
		})
		const landed = routeChanged(
			clicked.model,
			{ _tag: "StatusPage", pageId: PUBLIC_ID, search: { view: "settings", section: "appearance" } },
			context,
		)
		expect(landed.commands).toContainEqual(
			expect.objectContaining({
				name: "RevealStatusPageEditorField",
				args: { id: "status-page-support" },
			}),
		)
		expect(landed.model.revealFieldId).toBeNull()
		const inPlace = pageUpdate(
			loaded({ tab: "settings", section: "appearance" }),
			Message.ReceivedPreviewSelection({ kind: "field", id: "showPoweredBy" }),
		)
		expect(inPlace.outMessage).toBeUndefined()
		expect(inPlace.commands).toMatchObject([
			{ name: "RevealStatusPageEditorField", args: { id: "status-page-powered-by" } },
		])
		expect(
			pageUpdate(loaded(), Message.ReceivedPreviewSelection({ kind: "field", id: "name" })).outMessage,
		).toMatchObject({ url: statusPageHref(statusPage().id, "settings", "basic") })
		expect(
			pageUpdate(loaded(), Message.ReceivedPreviewSelection({ kind: "field", id: "slug" })).outMessage,
		).toBeUndefined()
	})

	test("a click on a group name opens its first component under Monitors", () => {
		const picked = pageUpdate(
			loaded(),
			Message.ReceivedPreviewSelection({ kind: "group", id: componentId(2) }),
		)
		expect(picked.model.panel).toEqual({ _tag: "Component", componentId: componentId(2) })
		expect(picked.outMessage).toMatchObject({
			url: statusPageHref(statusPage().id, "settings", "monitors"),
		})
	})

	test("switching to a tab that does not show the open component closes it, keeping unsaved edits for Monitors", () => {
		const away = { _tag: "StatusPage", pageId: PUBLIC_ID, search: {} } as const
		expect(routeChanged(selected(1), away, context).model.panel).toBeNull()
		const typed = pageUpdate(
			selected(1),
			Message.ChangedComponentField({ field: "name", value: "Payments" }),
		).model
		const left = routeChanged(typed, away, context)
		expect(left.model.panel).toBeNull()
		expect(names(left.commands)).not.toContain("SaveStatusPageComponent")
		// The live page shows the component as saved while its edits wait.
		expect(canvasDocument(left.model, statusPage())).not.toContain("Payments")
		const back = routeChanged(
			left.model,
			{ _tag: "StatusPage", pageId: PUBLIC_ID, search: { view: "settings", section: "monitors" } },
			context,
		)
		scene(
			{ update: pageUpdate, view },
			given(back.model),
			expectView(role("button", { name: /^Component 1/u })).toHaveAttr("aria-expanded", "true"),
			expectView(role("textbox", { name: "Shown as" })).toHaveValue("Payments"),
			expectView(text("Unsaved changes")).toExist(),
		)
	})

	test("a preview message that is not exactly a selection is ignored", () => {
		expect(selectionOf({ type: "select", kind: "component", id: componentId(1) })).toEqual(
			Option.some({ kind: "component", id: componentId(1) }),
		)
		expect(selectionOf({ type: "navigate", kind: "component", id: componentId(1) })).toEqual(
			Option.none(),
		)
		expect(selectionOf({ type: "select", kind: "page", id: componentId(1) })).toEqual(Option.none())
		expect(selectionOf({ type: "select", kind: "component", id: "<script>" })).toEqual(Option.none())
		expect(selectionOf("select")).toEqual(Option.none())
	})

	test("the live page is a sandboxed frame whose components and incidents can be clicked", () => {
		const model = loaded({ incidents: [incident(1)] })
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(selector("maple-preview-frame")).toHaveAttr("sandbox", "allow-scripts"),
		)
		const document = canvasDocument(model, statusPage())
		expect(document).toContain(`data-incident-id="${incidentId(1)}"`)
		expect(document).toContain(`data-component-id="${componentId(1)}"`)
	})

	test("the preview's subscribe dialog carries the Slack command for the page's public address", () => {
		const withDomain = { ...selected(2), publicBaseUrl: "https://status-pr-7.maple.dev" }
		expect(canvasDocument(withDomain, statusPage())).toContain(
			`value="/feed subscribe https://status-pr-7.maple.dev/s/${KEY}/acme-status/feed.rss"`,
		)
		// Slack fetches the feed itself: without a status domain there is no address to give it.
		expect(canvasDocument({ ...withDomain, publicBaseUrl: "" }, statusPage())).not.toContain(
			"/feed subscribe",
		)
	})

	test("typing raises the save bar and sends nothing; Save sends one PATCH of the whole component", () => {
		scene(
			{ update: pageUpdate, view },
			given(selected(2)),
			expectView(text("Unsaved changes")).not.toExist(),
			type(role("textbox", { name: "Shown as" }), " Payments "),
			Command.expectNone(),
			expectView(text("Unsaved changes")).toExist(),
			expectView(role("button", { name: "Save" })).toBeEnabled(),
		)
		const editing = pageUpdate(
			selected(2),
			Message.ChangedComponentField({ field: "name", value: " Payments " }),
		).model
		const saving = pageUpdate(editing, Message.ClickedSaveMonitors())
		expect(saving.commands).toMatchObject([
			{
				name: "SaveStatusPageComponent",
				args: {
					componentId: componentId(2),
					payload: {
						name: "Payments",
						group: null,
						monitor_id: null,
						manual_status: null,
						show_uptime: true,
					},
				},
			},
		])
		// One save at a time, and nothing to save while the form matches the component.
		expect(pageUpdate(saving.model, Message.ClickedSaveMonitors()).commands ?? []).toEqual([])
		expect(pageUpdate(selected(2), Message.ClickedSaveMonitors()).commands ?? []).toEqual([])
		const saved = pageUpdate(
			saving.model,
			Message.CompletedSaveComponent({ result: Result.succeed(component(2, { name: "Payments" })) }),
		)
		scene(
			{ update: pageUpdate, view },
			given(saved.model),
			expectView(text("Saved")).toExist(),
			expectView(text("Unsaved changes")).not.toExist(),
		)
	})

	test("a component without a name cannot be saved", () => {
		const unnamed = pageUpdate(selected(2), Message.ChangedComponentField({ field: "name", value: " " }))
		scene(
			{ update: pageUpdate, view },
			given(unnamed.model),
			expectView(text("Add a name.")).toExist(),
			expectView(role("button", { name: "Save" })).toBeDisabled(),
		)
		expect(pageUpdate(unnamed.model, Message.ClickedSaveMonitors()).commands ?? []).toEqual([])
	})

	test("Discard puts the saved values back", () => {
		scene(
			{ update: pageUpdate, view },
			given(selected(2)),
			type(role("textbox", { name: "Shown as" }), "Payments"),
			click(role("button", { name: "Discard" })),
			Command.expectNone(),
			expectView(role("textbox", { name: "Shown as" })).toHaveValue("Component 2"),
			expectView(text("Unsaved changes")).not.toExist(),
		)
	})

	test("a description typed in the panel shows in the preview as typed and goes out with Save", () => {
		const editing = pageUpdate(
			selected(2),
			Message.ChangedComponentField({ field: "description", value: " Card payments and payouts " }),
		)
		expect(canvasDocument(editing.model, statusPage())).toContain("Card payments and payouts")
		expect(pageUpdate(editing.model, Message.ClickedSaveMonitors()).commands).toMatchObject([
			{
				name: "SaveStatusPageComponent",
				args: { componentId: componentId(2), payload: { description: "Card payments and payouts" } },
			},
		])
		scene(
			{ update: pageUpdate, view },
			given(editing.model),
			expectView(role("textbox", { name: "Description" })).toHaveValue(" Card payments and payouts "),
		)
	})

	test("Group is a dropdown: pick one of the page's groups, or type a name and create it; it waits for Save", () => {
		const rows = [component(1, { group: "Core" }), component(2, { group: "Edge" }), component(3)]
		const picker = (message: Combobox.Message) => Message.GotGroupPickerMessage({ message })
		const opened = steps(selected(3, { components: rows }), [
			picker(Combobox.Message.ClickedTriggerOf({ items: [] })),
		])
		scene(
			{ update: pageUpdate, view },
			given(opened),
			comboMounted,
			expectView(role("option", { name: "No group" })).toExist(),
			expectView(role("option", { name: "Core" })).toExist(),
			expectView(role("option", { name: "Edge" })).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(steps(opened, [picker(Combobox.Message.ChangedInput({ value: "Pay" }))])),
			comboMounted,
			expectView(role("option", { name: 'Create "Pay"' })).toExist(),
			expectView(role("option", { name: "Core" })).not.toExist(),
		)
		const picked = steps(opened, [
			picker(Combobox.Message.ClickedItem({ value: groupPickerValue.group("Edge") })),
		])
		expect(picked.groupPicker.isOpen).toBe(false)
		expect(pageUpdate(picked, Message.ClickedSaveMonitors()).commands).toMatchObject([
			{
				name: "SaveStatusPageComponent",
				args: { componentId: componentId(3), payload: { group: "Edge" } },
			},
		])
		const created = steps(opened, [
			picker(Combobox.Message.ChangedInput({ value: " Payments " })),
			picker(Combobox.Message.ClickedItem({ value: groupPickerValue.create("Payments") })),
		])
		// The pick leaves the field on the group, with nothing typed in its search.
		expect(created.groupPicker.inputValue).toBe("")
		scene(
			{ update: pageUpdate, view },
			given(steps(created, [picker(Combobox.Message.ClickedTriggerOf({ items: [] }))])),
			comboMounted,
			expectView(role("option", { name: "Payments" })).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(created),
			// Still mounted while it fades out.
			comboMounted,
			expectView(role("combobox", { name: "Group: Payments" })).toExist(),
			expectView(text("Unsaved changes")).toExist(),
		)
	})

	test("a failed save keeps the edits and says so in the panel, and Save tries again", () => {
		const monitor = downMonitor()
		const picked = pageUpdate(
			selected(1),
			Message.ChangedComponentField({ field: "monitorId", value: monitor.id }),
		)
		expect(picked.commands ?? []).toEqual([])
		const saving = pageUpdate(picked.model, Message.ClickedSaveMonitors())
		expect(saving.commands).toMatchObject([
			{ name: "SaveStatusPageComponent", args: { payload: { monitor_id: monitor.id } } },
		])
		const failed = pageUpdate(
			saving.model,
			Message.CompletedSaveComponent({ result: Result.fail(toLoadFailure(new Error("refused"))) }),
		).model
		expect(failed.componentForm.monitorId).toBe(monitor.id)
		scene(
			{ update: pageUpdate, view },
			given(failed),
			expectView(text("Not saved")).toExist(),
			expectView(text("Couldn't save the component")).toExist(),
			expectView(text("Unsaved changes")).toExist(),
			expectView(role("button", { name: "Save" })).toBeEnabled(),
		)
		expect(pageUpdate(failed, Message.ClickedSaveMonitors()).commands).toMatchObject([
			{ name: "SaveStatusPageComponent", args: { payload: { monitor_id: monitor.id } } },
		])
	})

	test("a component without a monitor shows its stored uptime setting, disabled, and says why", () => {
		scene(
			{ update: pageUpdate, view },
			given(selected(1)),
			expectView(role("switch", { name: "Show uptime bars" })).toBeChecked(),
			expectView(role("switch", { name: "Show uptime bars" })).toBeDisabled(),
			expectView(text("Uptime bars need a monitor.")).toExist(),
		)
	})

	test("the remove confirm names the monitor only when there is one, and the draft wording for drafts", () => {
		expect(removeComponentCopy(statusPage(), component(1, { monitor_id: httpMonitor().id }))).toBe(
			"Visitors stop seeing it within a minute. Its monitor keeps running.",
		)
		expect(removeComponentCopy(statusPage(), component(1))).toBe(
			"Visitors stop seeing it within a minute.",
		)
		expect(removeComponentCopy(statusPage({ draft: true }), component(1))).toBe(
			"It leaves the draft; visitors never see it.",
		)
	})

	test("Escape closes the panel, and with unsaved edits asks first", () => {
		expect(pageUpdate(selected(1), Message.PressedEscape()).model.panel).toBeNull()
		const editing = pageUpdate(
			selected(2),
			Message.ChangedComponentField({ field: "name", value: "Payments" }),
		).model
		const asked = pageUpdate(editing, Message.PressedEscape())
		expect(asked.model.panel).toEqual({ _tag: "Component", componentId: componentId(2) })
		expect(asked.model.discardComponentDialog.isOpen).toBe(true)
		expect(names(asked.commands)).not.toContain("SaveStatusPageComponent")
		const discarded = pageUpdate(asked.model, Message.ClickedConfirmDiscardComponent())
		expect(discarded.model.panel).toBeNull()
		expect(names(discarded.commands)).not.toContain("SaveStatusPageComponent")
	})

	test("opening another component with unsaved edits asks first, and Keep editing stays on them", () => {
		const typed = pageUpdate(
			selected(1),
			Message.ChangedComponentField({ field: "name", value: "Payments" }),
		).model
		const asked = pageUpdate(typed, Message.ClickedComponent({ componentId: componentId(2) }))
		expect(names(asked.commands)).not.toContain("SaveStatusPageComponent")
		scene(
			{ update: pageUpdate, view },
			given(asked.model),
			mounted,
			expectView(role("alertdialog", { name: "Discard changes to Component 1?" })).toExist(),
			expectView(within(role("alertdialog"), role("button", { name: "Keep editing" }))).toExist(),
		)
		const kept = pageUpdate(
			asked.model,
			Message.GotDiscardComponentDialogMessage({ message: Dialog.Message.ClickedClose() }),
		).model
		expect(kept.discardComponentDialog.isOpen).toBe(false)
		scene(
			{ update: pageUpdate, view },
			given(kept),
			mounted,
			expectView(role("button", { name: /^Component 1/u })).toHaveAttr("aria-expanded", "true"),
			expectView(role("button", { name: /^Component 2/u })).toHaveAttr("aria-expanded", "false"),
			expectView(role("textbox", { name: "Shown as" })).toHaveValue("Payments"),
		)
	})

	test("Discard changes drops the edits and opens the other component", () => {
		const asked = steps(selected(1), [
			Message.ChangedComponentField({ field: "name", value: "Payments" }),
			Message.ClickedComponent({ componentId: componentId(2) }),
		])
		const discarded = pageUpdate(asked, Message.ClickedConfirmDiscardComponent())
		expect(names(discarded.commands)).not.toContain("SaveStatusPageComponent")
		expect(discarded.model.panel).toEqual({ _tag: "Component", componentId: componentId(2) })
		expect(discarded.model.componentForm.name).toBe("Component 2")
		// Component 1 opens again as saved.
		const reopened = pageUpdate(
			discarded.model,
			Message.ClickedComponent({ componentId: componentId(1) }),
		).model
		expect(reopened.componentForm.name).toBe("Component 1")
	})

	test("Add monitors with unsaved edits asks first, and opens once they are discarded", () => {
		const asked = steps(selected(1), [
			Message.ChangedComponentField({ field: "group", value: "Core" }),
			Message.ClickedAddComponent(),
		])
		expect(asked.panel?._tag).toBe("Component")
		expect(asked.discardComponentDialog.isOpen).toBe(true)
		expect(pageUpdate(asked, Message.ClickedConfirmDiscardComponent()).model.panel?._tag).toBe("Add")
	})

	test("edits being saved are not offered for discarding", () => {
		const saving = steps(selected(1), [
			Message.ChangedComponentField({ field: "name", value: "Payments" }),
			Message.ClickedSaveMonitors(),
		])
		const switched = pageUpdate(saving, Message.ClickedComponent({ componentId: componentId(2) })).model
		expect(switched.discardComponentDialog.isOpen).toBe(false)
		expect(switched.panel).toEqual({ _tag: "Component", componentId: componentId(2) })
		// Typed after Save, they are.
		const typedAfter = pageUpdate(
			pageUpdate(saving, Message.ChangedComponentField({ field: "name", value: "Payments API" })).model,
			Message.ClickedComponent({ componentId: componentId(2) }),
		).model
		expect(typedAfter.discardComponentDialog.isOpen).toBe(true)
	})

	test("removing a component asks first, then deletes it once", () => {
		const asking = pageUpdate(
			selected(2),
			Message.ClickedDeleteComponent({ componentId: componentId(2) }),
		)
		expect(asking.model.confirmDeleteComponentId).toBe(componentId(2))
		expect(asking.model.deleteComponentDialog.isOpen).toBe(true)
		expect(names(asking.commands)).not.toContain("DeleteStatusPageComponent")
		const deleting = pageUpdate(asking.model, Message.ClickedConfirmDeleteComponent())
		expect(deleting.commands).toMatchObject([
			{ name: "DeleteStatusPageComponent", args: { componentId: componentId(2) } },
		])
		expect(pageUpdate(deleting.model, Message.ClickedConfirmDeleteComponent()).commands ?? []).toEqual([])
	})

	test("Add component offers the monitors not on the page yet and adds the picked ones", () => {
		const monitor = downMonitor()
		const opened = pageUpdate(
			loaded({ components: [component(1, { monitor_id: httpMonitor().id })] }),
			Message.ClickedAddComponent(),
		).model
		expect(Arr.map(opened.addPicker.rows, (row) => row.monitorId)).toEqual([monitor.id])
		const picked = pageUpdate(
			opened,
			Message.GotAddPickerMessage({ message: PickerMessage.ToggledRow({ key: `m:${monitor.id}` }) }),
		).model
		expect(pageUpdate(picked, Message.ClickedSubmitAdd()).commands).toMatchObject([
			{
				name: "AddStatusPageComponents",
				args: { components: [{ name: monitor.name, monitor_id: monitor.id }] },
			},
		])
	})

	test("a monitor created from a URL goes onto the page at once, unless that Add panel closed meanwhile", () => {
		const monitor = downMonitor()
		const adding = pageUpdate(loaded(), Message.ClickedAddComponent()).model
		const created = Message.CompletedCreateMonitor({
			session: adding.addSession,
			result: Result.succeed(monitor),
		})
		expect(pageUpdate(adding, created).commands).toMatchObject([
			{
				name: "AddStatusPageComponents",
				args: { components: [{ name: monitor.name, monitor_id: monitor.id }] },
			},
			{ name: "TrackStatusPageEditorMonitorCreated", args: { kind: monitor.kind } },
		])
		const closed = pageUpdate(
			adding,
			Message.GotPanelSheetMessage({ message: Dialog.Message.ClickedClose() }),
		).model
		expect(names(pageUpdate(closed, created).commands)).not.toContain("AddStatusPageComponents")
		// Reopened before the first monitor arrived: the new panel's picker stays its own.
		const reopened = pageUpdate(closed, Message.ClickedAddComponent()).model
		const late = pageUpdate(reopened, created)
		expect(names(late.commands)).not.toContain("AddStatusPageComponents")
		expect(late.model.addPicker).toEqual(reopened.addPicker)
		// And a late add from the first panel does not close the reopened one.
		const settled = pageUpdate(
			reopened,
			Message.CompletedAddComponents({ session: adding.addSession, result: Result.succeed([]) }),
		)
		expect(settled.model.panel).toEqual(reopened.panel)
	})

	test("the Add panel is locked while a pasted URL is being monitored", () => {
		const adding = pageUpdate(loaded(), Message.ClickedAddComponent()).model
		scene(
			{ update: pageUpdate, view },
			given({ ...adding, addPicker: { ...adding.addPicker, isCreatingMonitor: true } }),
			mounted,
			expectView(role("button", { name: "Add a component without a monitor" })).toBeDisabled(),
			expectView(role("button", { name: "Add component" })).toBeDisabled(),
		)
	})

	test("Add does not reopen while an earlier add is still saving", () => {
		const saving = { ...loaded(), isAddingComponents: true }
		expect(pageUpdate(saving, Message.ClickedAddComponent()).model.panel).toBeNull()
	})

	test("a failed add closes the panel, so a retry cannot add the components that did land twice", () => {
		const adding = pageUpdate(loaded(), Message.ClickedAddComponent()).model
		const failed = pageUpdate(
			{ ...adding, isAddingComponents: true },
			Message.CompletedAddComponents({
				session: adding.addSession,
				result: Result.fail(toLoadFailure(new Error("second create refused"))),
			}),
		)
		expect(failed.model.panel).toBeNull()
		expect(failed.model.isAddingComponents).toBe(false)
		expect(failed.outMessage).toMatchObject({ _tag: "RequestedToast", type: "error" })
	})

	test("members see the page and its components with every control to change them locked", () => {
		scene(
			{ update: pageUpdate, view },
			given(selected(1, { grants: MEMBER })),
			expectView(text("Component 1")).toExist(),
			expectView(role("button", { name: "Add monitor" })).not.toExist(),
			expectView(role("button", { name: "Reorder Component 1" })).toBeDisabled(),
			expectView(role("button", { name: "Remove from page" })).toBeDisabled(),
			expectView(role("textbox", { name: "Shown as" })).toBeDisabled(),
			expectView(text("Only org admins and engineers can change components.")).toExist(),
		)
		expect(
			pageUpdate(selected(1, { grants: MEMBER }), Message.ClickedAddComponent()).model.panel?._tag,
		).toBe("Component")
	})
})

const steps = (model: Model, messages: ReadonlyArray<Message>, ctx: PageContext = context) =>
	Arr.reduce(messages, model, (current, message) => update(current, message, ctx).model)

const mounted = Mount.resolve(MountDialog, Dialog.Message.CompletedMountDialog())
const comboMounted = Mount.resolve(Combobox.MountCombobox, Combobox.Message.CompletedMountCombobox())

/** The Appearance section's colour pickers, mounted: the accent alone in Auto, all five in Light or Dark. */
const pickersMounted = (count: number) =>
	Mount.resolveAll(
		...Arr.makeBy(
			count,
			() => [MountColorPicker, ColorPickerMessage.CompletedMountColorPicker()] as const,
		),
	)

/** The reviewed message as the public page's markup renders it; the incident's sheet is a dialog too. */
const updateBodyOf = find('[role="dialog"]:not(#status-page-panel-popup) [data-slot="update-body"]')
const messageHtml = (html: Parameters<typeof updateBodyOf>[0]): string =>
	Option.getOrElse(Option.flatMap(updateBodyOf(html), attr("innerHTML")), () => "")

const shown = (row: ReturnType<typeof incident>) =>
	pageUpdate(loaded({ incidents: [row] }), Message.ClickedIncident({ incidentId: row.id })).model

describe("posting an incident", () => {
	test("switching between incident and maintenance keeps what was typed", () => {
		const typed = steps(loaded(), [
			Message.ClickedNewIncident({ kind: "incident" }),
			Message.ChangedIncidentField({ field: "title", value: "Database upgrade" }),
			Message.ChangedIncidentField({ field: "body", value: "Planned work." }),
		])
		const switched = pageUpdate(typed, Message.ChangedIncidentKind({ kind: "maintenance" })).model
		expect(switched.incidentForm).toMatchObject({
			kind: "maintenance",
			title: "Database upgrade",
			body: "Planned work.",
			status: "scheduled",
			impact: "none",
			componentIds: typed.incidentForm.componentIds,
		})
	})

	test("Post incident opens a dialog on its write step, with the affected components picked", () => {
		const model = loaded({ components: [component(1), component(2, { monitor_id: downMonitor().id })] })
		const opened = pageUpdate(model, Message.ClickedNewIncident({ kind: "incident" })).model
		expect(opened.composeDialog.isOpen).toBe(true)
		expect(opened.incidentForm.impact).toBe("critical")
		scene(
			{ update: pageUpdate, view },
			given(opened),
			mounted,
			expectView(role("dialog", { name: "Post incident" })).toExist(),
			expectView(role("listitem", { name: "Write" })).toHaveAttr("aria-current", "step"),
			expectView(role("listitem", { name: "Review" })).not.toHaveAttr("aria-current", "step"),
			expectView(role("textbox", { name: "Title" })).toExist(),
			expectView(role("checkbox", { name: "Component 2" })).toBeChecked(),
			expectView(role("checkbox", { name: "Component 1" })).not.toBeChecked(),
		)
	})

	test("Review waits for a title and a message, and names what is missing", () => {
		const opened = pageUpdate(loaded(), Message.ClickedNewIncident({ kind: "incident" })).model
		expect(pageUpdate(opened, Message.SubmittedIncidentWrite()).model.composeStep).toBe("write")
		scene(
			{ update: pageUpdate, view },
			given(opened),
			mounted,
			expectView(text("Add a title.")).toExist(),
			expectView(role("button", { name: "Review" })).toBeDisabled(),
			type(role("textbox", { name: "Title" }), "Elevated API errors"),
			expectView(text("Write the first update.")).toExist(),
			type(role("textbox", { name: "Message" }), "Looking into it."),
			expectView(text("Nothing is public until you confirm on the next step.")).toExist(),
			expectView(role("button", { name: "Review" })).toBeEnabled(),
		)
	})

	const reviewing = () =>
		steps(loaded(), [
			Message.ClickedNewIncident({ kind: "incident" }),
			Message.ChangedIncidentField({ field: "title", value: "Slow checkout" }),
			Message.ChangedIncidentField({ field: "impact", value: "critical" }),
			Message.ToggledIncidentComponent({ componentId: componentId(2) }),
			Message.ChangedIncidentField({ field: "body", value: "**Checkout** is slow." }),
			Message.SubmittedIncidentWrite(),
		])

	test("the review shows the post as the page renders it and what visitors see change", () => {
		const model = reviewing()
		expect(model.composeStep).toBe("review")
		scene(
			{ update: pageUpdate, view },
			given(model),
			mounted,
			expectView(role("dialog", { name: "Review before publishing" })).toExist(),
			inside(
				role("region", { name: "On the page" }),
				expectView(text("Slow checkout")).toExist(),
				expectView(text("Affects Component 2 · Posted just now")).toExist(),
			),
			tap(({ html }) => expect(messageHtml(html)).toBe("<p><strong>Checkout</strong> is slow.</p>")),
			inside(
				role("region", { name: "What changes when you publish" }),
				expectAll(all.role("listitem")).toHaveCount(2),
				expectView(text("Page banner")).toExist(),
				expectView(text("Component 2")).toExist(),
				expectAll(all.text("Major outage")).toHaveCount(2),
				expectView(text("Component 1")).not.toExist(),
			),
		)
	})

	test("Publish creates the incident as reviewed, then the dialog closes on the incident's panel", () => {
		const publishing = pageUpdate(reviewing(), Message.SubmittedIncident({ isPublished: true }))
		expect(publishing.commands).toMatchObject([
			{
				name: "CreateStatusPageIncident",
				args: {
					payload: {
						kind: "incident",
						title: "Slow checkout",
						impact: "critical",
						status: "investigating",
						component_ids: [componentId(2)],
						body: "**Checkout** is slow.",
						published: true,
					},
				},
			},
		])
		expect(
			pageUpdate(publishing.model, Message.SubmittedIncident({ isPublished: true })).commands ?? [],
		).toEqual([])
		const created = pageUpdate(
			publishing.model,
			Message.CompletedCreateIncident({ result: Result.succeed(incident(2)) }),
		)
		expect(created.model.composeDialog.isOpen).toBe(false)
		expect(created.model.panel).toEqual({ _tag: "Incident", incidentId: incidentId(2) })
		expect(names(created.commands)).toContain("FetchStatusPageIncidents")
		expect(created.outMessage).toMatchObject({ _tag: "RequestedToast", title: "Incident published" })
		// With no incident list loaded to put it in, the sheet still shows the new incident.
		const unloaded = {
			...publishing.model,
			incidents: { ...publishing.model.incidents, data: AsyncData.Loading() },
		}
		const shownAnyway = pageUpdate(
			unloaded,
			Message.CompletedCreateIncident({ result: Result.succeed(incident(2)) }),
		)
		expect(shownAnyway.model.sheetIncident?.id).toBe(incidentId(2))
	})

	test("Save as draft sends the same incident unpublished", () => {
		expect(
			pageUpdate(reviewing(), Message.SubmittedIncident({ isPublished: false })).commands,
		).toMatchObject([
			{
				name: "CreateStatusPageIncident",
				args: { payload: { title: "Slow checkout", published: false } },
			},
		])
	})

	test("Back returns to the write step with everything as typed", () => {
		const back = pageUpdate(reviewing(), Message.ClickedIncidentBack()).model
		expect(back.composeStep).toBe("write")
		scene(
			{ update: pageUpdate, view },
			given(back),
			mounted,
			expectView(role("textbox", { name: "Title" })).toHaveValue("Slow checkout"),
			expectView(role("textbox", { name: "Message" })).toHaveValue("**Checkout** is slow."),
			expectView(role("checkbox", { name: "Component 2" })).toBeChecked(),
		)
	})

	test("a refused create stays on the review with the reason", () => {
		const refused = pageUpdate(
			pageUpdate(reviewing(), Message.SubmittedIncident({ isPublished: true })).model,
			Message.CompletedCreateIncident({
				result: Result.fail(toLoadFailure(new Error("create refused"))),
			}),
		).model
		expect(refused.composeDialog.isOpen).toBe(true)
		scene(
			{ update: pageUpdate, view },
			given(refused),
			mounted,
			expectView(text("Couldn't open the incident")).toExist(),
			expectView(role("button", { name: "Publish" })).toBeEnabled(),
		)
	})

	test("the dialog cannot be dismissed while the incident is being created", () => {
		const creating = pageUpdate(reviewing(), Message.SubmittedIncident({ isPublished: true })).model
		const dismissed = pageUpdate(
			creating,
			Message.GotComposeDialogMessage({ message: Dialog.Message.PressedEscape() }),
		).model
		expect(dismissed.composeDialog.isOpen).toBe(true)
	})

	test("maintenance needs a window that ends after it starts, read in the viewer's zone", () => {
		const zoned: PageContext = { ...context, timeZone: "Europe/Berlin" }
		const filled = steps(
			loaded(),
			[
				Message.ClickedNewIncident({ kind: "maintenance" }),
				Message.ChangedIncidentField({ field: "title", value: "Database upgrade" }),
				Message.ChangedIncidentField({ field: "body", value: "Brief read-only periods." }),
				Message.ChangedIncidentField({ field: "scheduledStart", value: "2026-10-30T22:00" }),
				Message.ChangedIncidentField({ field: "scheduledEnd", value: "2026-10-30T21:00" }),
				Message.SubmittedIncidentWrite(),
			],
			zoned,
		)
		expect(filled.composeStep).toBe("write")
		const fixed = steps(
			filled,
			[
				Message.ChangedIncidentField({ field: "scheduledEnd", value: "2026-10-31T01:00" }),
				Message.SubmittedIncidentWrite(),
			],
			zoned,
		)
		expect(update(fixed, Message.SubmittedIncident({ isPublished: true }), zoned).commands).toMatchObject(
			[
				{
					name: "CreateStatusPageIncident",
					args: {
						payload: {
							kind: "maintenance",
							status: "scheduled",
							scheduled_start: "2026-10-30T21:00:00.000Z",
							scheduled_end: "2026-10-31T00:00:00.000Z",
						},
					},
				},
			],
		)
	})

	test("future maintenance is scheduled, and changes nothing on the page yet", () => {
		const model = steps(loaded(), [
			Message.ClickedNewIncident({ kind: "maintenance" }),
			Message.ChangedIncidentField({ field: "title", value: "Database upgrade" }),
			Message.ChangedIncidentField({ field: "body", value: "Brief read-only periods." }),
			Message.ToggledIncidentComponent({ componentId: componentId(1) }),
			Message.ChangedIncidentField({ field: "scheduledStart", value: "2026-10-30T22:00" }),
			Message.ChangedIncidentField({ field: "scheduledEnd", value: "2026-10-30T23:00" }),
			Message.SubmittedIncidentWrite(),
		])
		scene(
			{ update: pageUpdate, view },
			given(model),
			mounted,
			expectView(text("Nothing on the page changes")).toExist(),
			expectView(role("button", { name: "Schedule" })).toExist(),
		)
	})

	test("maintenance takes its status from its window, so the dialog asks for none", () => {
		const written = (start: string, end: string) =>
			steps(loaded(), [
				Message.ClickedNewIncident({ kind: "maintenance" }),
				Message.ChangedIncidentField({ field: "title", value: "Database upgrade" }),
				Message.ChangedIncidentField({ field: "body", value: "Read-only for a few minutes." }),
				Message.ChangedIncidentField({ field: "scheduledStart", value: start }),
				Message.ChangedIncidentField({ field: "scheduledEnd", value: end }),
			])
		scene(
			{ update: pageUpdate, view },
			given(written("2026-10-01T13:00", "2026-10-01T14:00")),
			mounted,
			expectView(role("combobox", { name: "Status" })).not.toExist(),
		)
		const post = (model: Model) =>
			pageUpdate(
				pageUpdate(model, Message.SubmittedIncidentWrite()).model,
				Message.SubmittedIncident({ isPublished: true }),
			).commands
		// The clock reads 12:00.
		expect(post(written("2026-10-01T13:00", "2026-10-01T14:00"))).toMatchObject([
			{ name: "CreateStatusPageIncident", args: { payload: { status: "scheduled" } } },
		])
		expect(post(written("2026-10-01T11:00", "2026-10-01T14:00"))).toMatchObject([
			{ name: "CreateStatusPageIncident", args: { payload: { status: "in_progress" } } },
		])
		const over = written("2026-10-01T10:00", "2026-10-01T11:00")
		expect(post(over) ?? []).toEqual([])
		scene(
			{ update: pageUpdate, view },
			given(over),
			mounted,
			expectView(text("The maintenance must end in the future.")).toExist(),
		)
	})

	test("maintenance can stay in progress past its window: the choice, the review and the post", () => {
		const writing = steps(loaded(), [
			Message.ClickedNewIncident({ kind: "maintenance" }),
			Message.ChangedIncidentField({ field: "title", value: "Index rebuild" }),
			Message.ChangedIncidentField({ field: "body", value: "Rebuilding indexes." }),
			Message.ChangedIncidentField({ field: "scheduledStart", value: "2026-10-30T22:00" }),
			Message.ChangedIncidentField({ field: "scheduledEnd", value: "2026-10-30T23:00" }),
		])
		scene(
			{ update: pageUpdate, view },
			given(writing),
			mounted,
			expectView(role("radio", { name: "Complete automatically" })).toBeChecked(),
			expectView(
				role("radio", { name: "Keep it in progress until someone completes it" }),
			).not.toBeChecked(),
		)
		const reviewed = steps(writing, [
			Message.ChangedIncidentAutoComplete({ autoComplete: false }),
			Message.SubmittedIncidentWrite(),
		])
		scene(
			{ update: pageUpdate, view },
			given(reviewed),
			mounted,
			expectView(
				text(
					"Starts Oct 30, 22:00 and ends Oct 30, 23:00 (UTC). It moves to In progress at the start on its own and stays there past the end until someone completes it.",
				),
			).toExist(),
		)
		expect(pageUpdate(reviewed, Message.SubmittedIncident({ isPublished: true })).commands).toMatchObject(
			[{ name: "CreateStatusPageIncident", args: { payload: { auto_complete: false } } }],
		)
	})

	test("an incident can be backdated: the review says when it started and the post carries it", () => {
		const written = steps(loaded(), [
			Message.ClickedNewIncident({ kind: "incident" }),
			Message.ChangedIncidentField({ field: "title", value: "Elevated errors" }),
			Message.ChangedIncidentField({ field: "body", value: "Looking into it." }),
		])
		// The clock reads 12:00: a start after it is refused before Review, as the API would.
		const future = steps(written, [
			Message.ChangedIncidentField({ field: "startedAt", value: "2026-10-01T12:30" }),
			Message.SubmittedIncidentWrite(),
		])
		expect(future.composeStep).toBe("write")
		scene(
			{ update: pageUpdate, view },
			given(future),
			mounted,
			expectView(text("It can't start in the future.")).toExist(),
			expectView(role("button", { name: "Review" })).toBeDisabled(),
		)
		const reviewed = steps(future, [
			Message.ChangedIncidentField({ field: "startedAt", value: "2026-10-01T09:05" }),
			Message.SubmittedIncidentWrite(),
		])
		scene(
			{ update: pageUpdate, view },
			given(reviewed),
			mounted,
			inside(
				role("region", { name: "On the page" }),
				expectView(text(/Started Oct 1, 09:05/u)).toExist(),
			),
		)
		expect(pageUpdate(reviewed, Message.SubmittedIncident({ isPublished: true })).commands).toMatchObject(
			[
				{
					name: "CreateStatusPageIncident",
					args: { payload: { started_at: "2026-10-01T09:05:00.000Z" } },
				},
			],
		)
	})

	test("the maintenance review says it starts and completes on its own", () => {
		const reviewed = steps(loaded(), [
			Message.ClickedNewIncident({ kind: "maintenance" }),
			Message.ChangedIncidentField({ field: "title", value: "Database upgrade" }),
			Message.ChangedIncidentField({ field: "body", value: "Brief read-only periods." }),
			Message.ChangedIncidentField({ field: "scheduledStart", value: "2026-10-30T22:00" }),
			Message.ChangedIncidentField({ field: "scheduledEnd", value: "2026-10-31T01:00" }),
			Message.SubmittedIncidentWrite(),
		])
		scene(
			{ update: pageUpdate, view },
			given(reviewed),
			mounted,
			inside(
				role("region", { name: "Schedule" }),
				expectView(
					text(
						"Starts Oct 30, 22:00 and ends Oct 31, 01:00 (UTC). It moves to In progress at the start and to Completed at the end on its own; subscribers see both updates.",
					),
				).toExist(),
			),
		)
	})

	test("a first update over 20,000 characters keeps Review shut and says so", () => {
		const long = steps(loaded(), [
			Message.ClickedNewIncident({ kind: "incident" }),
			Message.ChangedIncidentField({ field: "title", value: "Elevated errors" }),
			Message.ChangedIncidentField({ field: "body", value: Str.repeat(20_001)("x") }),
		])
		expect(pageUpdate(long, Message.SubmittedIncidentWrite()).model.composeStep).toBe("write")
		scene(
			{ update: pageUpdate, view },
			given(long),
			mounted,
			expectAll(all.text("Keep it under 20,000 characters (20,001 now).")).toHaveCount(2),
			expectView(role("button", { name: "Review" })).toBeDisabled(),
		)
	})

	test("the write step lists what is missing for maintenance", () => {
		const opened = pageUpdate(loaded(), Message.ClickedNewIncident({ kind: "maintenance" })).model
		scene(
			{ update: pageUpdate, view },
			given(opened),
			mounted,
			type(role("textbox", { name: "Title" }), "Database upgrade"),
			type(role("textbox", { name: "Message" }), "Brief read-only periods."),
			expectView(text("Set when the maintenance starts and ends.")).toExist(),
			expectView(role("button", { name: "Review" })).toBeDisabled(),
		)
	})
})

describe("posting an update", () => {
	test("an open incident carries its actions, and a draft can be published", () => {
		const model = pageUpdate(
			loaded({
				incidents: [
					incident(1, { published: false }),
					incident(2, { status: "resolved", title: "Old outage" }),
				],
			}),
			Message.ClickedIncident({ incidentId: incidentId(1) }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(model),
			mounted,
			expectView(text("Draft, not public")).toExist(),
			expectView(role("button", { name: "Publish" })).toExist(),
			expectView(role("button", { name: "Resolve" })).toExist(),
		)
		expect(
			pageUpdate(model, Message.ClickedPublishIncident({ incidentId: incidentId(1) })).commands,
		).toMatchObject([{ name: "PublishStatusPageIncident", args: { incidentId: incidentId(1) } }])
	})

	test("Post update opens a dialog with the status one step along, and Review needs a message", () => {
		const opened = pageUpdate(
			loaded({ incidents: [incident(1, { status: "identified" })] }),
			Message.ClickedPostUpdate({ incidentId: incidentId(1), isResolving: false }),
		).model
		expect(opened.updateDialog.isOpen).toBe(true)
		expect(opened.updateForm).toMatchObject({ _tag: "Writing", form: { status: "monitoring" } })
		expect(pageUpdate(opened, Message.SubmittedUpdateWrite()).model.updateForm._tag).toBe("Writing")
		scene(
			{ update: pageUpdate, view },
			given(opened),
			mounted,
			mounted,
			expectView(role("dialog", { name: "Post update" })).toExist(),
			// The last update reads as the page renders it.
			tap(({ html }) =>
				expect(messageHtml(html)).toBe("<p>We are looking into elevated error rates.</p>"),
			),
			expectView(role("button", { name: "Monitoring" })).toHaveAttr("aria-pressed", "true"),
			expectView(role("button", { name: "Review" })).toBeDisabled(),
			type(role("textbox", { name: "Message" }), "A fix is rolling out."),
			expectView(role("button", { name: "Review" })).toBeEnabled(),
		)
	})

	const resolving = () =>
		steps(loaded({ incidents: [incident(1, { impact: "major" })] }), [
			Message.ClickedPostUpdate({ incidentId: incidentId(1), isResolving: true }),
			Message.SubmittedUpdateWrite(),
		])

	test("resolving reviews the components going back to operational, then posts the closing message", () => {
		const model = resolving()
		scene(
			{ update: pageUpdate, view },
			given(model),
			mounted,
			mounted,
			inside(role("region", { name: "On the page" }), expectView(text("Resolved")).toExist()),
			tap(({ html }) => expect(messageHtml(html)).toBe("<p>This incident has been resolved.</p>")),
			inside(
				role("region", { name: "What changes" }),
				expectAll(all.role("listitem")).toHaveCount(2),
				expectView(text("Page banner")).toExist(),
				expectView(text("Component 1")).toExist(),
				expectAll(all.text("Partial outage")).toHaveCount(2),
			),
		)
		const posting = pageUpdate(model, Message.SubmittedUpdate())
		expect(posting.commands).toMatchObject([
			{
				name: "PostStatusPageIncidentUpdate",
				args: {
					incidentId: incidentId(1),
					payload: { status: "resolved", body: "This incident has been resolved." },
				},
			},
		])
		const posted = pageUpdate(
			posting.model,
			Message.CompletedPostUpdate({ result: Result.succeed(incident(1, { status: "resolved" })) }),
		)
		expect(posted.model.updateDialog.isOpen).toBe(false)
		expect(posted.outMessage).toMatchObject({ _tag: "RequestedToast", title: "Incident resolved" })
	})

	test("a typed time re-reads the clock, so it is checked against the time it was typed", () => {
		const opened = pageUpdate(
			loaded({ incidents: [incident(1)] }),
			Message.ClickedPostUpdate({ incidentId: incidentId(1), isResolving: true }),
		).model
		const typed = pageUpdate(
			opened,
			Message.ChangedUpdateField({ field: "endedAt", value: "2026-10-01T11:58" }),
		)
		expect(names(typed.commands)).toEqual(["ReadStatusPageClock"])
	})

	test("resolving can say when it ended, but not in the future", () => {
		const opened = pageUpdate(
			loaded({ incidents: [incident(1)] }),
			Message.ClickedPostUpdate({ incidentId: incidentId(1), isResolving: true }),
		).model
		const late = steps(opened, [
			Message.ChangedUpdateField({ field: "endedAt", value: "2026-10-01T12:30" }),
			Message.SubmittedUpdateWrite(),
		])
		expect(late.updateForm._tag).toBe("Writing")
		scene(
			{ update: pageUpdate, view },
			given(late),
			mounted,
			mounted,
			expectView(text("It can't end in the future.")).toExist(),
			expectView(role("button", { name: "Review" })).toBeDisabled(),
		)
		// A clock read after the typed minute lets it through.
		const later = steps(late, [
			Message.ReadClock({ nowMs: Date.UTC(2026, 9, 1, 12, 31) }),
			Message.SubmittedUpdateWrite(),
		])
		expect(later.updateForm._tag).toBe("Reviewing")
	})

	test("resolving can say when it ended, but not before the incident started", () => {
		const opened = pageUpdate(
			loaded({ incidents: [incident(1)] }),
			Message.ClickedPostUpdate({ incidentId: incidentId(1), isResolving: true }),
		).model
		const early = steps(opened, [
			Message.ChangedUpdateField({ field: "endedAt", value: "2026-10-01T11:45" }),
			Message.SubmittedUpdateWrite(),
		])
		expect(early.updateForm._tag).toBe("Writing")
		scene(
			{ update: pageUpdate, view },
			given(early),
			mounted,
			mounted,
			expectView(text("It can't end before it started.")).toExist(),
			expectView(role("button", { name: "Review" })).toBeDisabled(),
		)
		const reviewed = steps(early, [
			Message.ChangedUpdateField({ field: "endedAt", value: "2026-10-01T11:58" }),
			Message.SubmittedUpdateWrite(),
		])
		expect(pageUpdate(reviewed, Message.SubmittedUpdate()).commands).toMatchObject([
			{
				name: "PostStatusPageIncidentUpdate",
				args: { payload: { status: "resolved", resolved_at: "2026-10-01T11:58:00.000Z" } },
			},
		])
	})

	test("an update that does not close the incident has no end time to set", () => {
		const opened = pageUpdate(
			loaded({ incidents: [incident(1)] }),
			Message.ClickedPostUpdate({ incidentId: incidentId(1), isResolving: false }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(opened),
			mounted,
			mounted,
			expectView(role("textbox", { name: "Ended" })).not.toExist(),
		)
	})

	test("Back keeps the message, and a failed post stays on the review with the reason", () => {
		const back = pageUpdate(resolving(), Message.ClickedUpdateBack()).model
		expect(back.updateForm).toMatchObject({
			_tag: "Writing",
			form: { status: "resolved", body: "This incident has been resolved." },
		})
		const failed = steps(back, [
			Message.SubmittedUpdateWrite(),
			Message.SubmittedUpdate(),
			Message.CompletedPostUpdate({ result: Result.fail(toLoadFailure(new Error("unreachable"))) }),
		])
		expect(failed.updateDialog.isOpen).toBe(true)
		scene(
			{ update: pageUpdate, view },
			given(failed),
			mounted,
			mounted,
			expectView(text("Couldn't post the update")).toExist(),
			expectView(role("button", { name: "Publish update" })).toBeEnabled(),
		)
	})

	test("Change title, impact, times or components opens Edit details over the update, which keeps its message", () => {
		const typed = steps(loaded({ incidents: [incident(1, { title: "Elevated errors" })] }), [
			Message.ClickedPostUpdate({ incidentId: incidentId(1), isResolving: false }),
			Message.ChangedUpdateField({ field: "body", value: "Still looking." }),
		])
		const editing = pageUpdate(typed, Message.ClickedEditIncident({ incidentId: incidentId(1) })).model
		expect(editing.editIncidentDialog.isOpen).toBe(true)
		expect(editing.updateDialog.isOpen).toBe(true)
		expect(editing.updateForm).toMatchObject({ _tag: "Writing", form: { body: "Still looking." } })
		scene(
			{ update: pageUpdate, view },
			given(typed),
			mounted,
			mounted,
			expectView(role("button", { name: "Change title, impact, times or components" })).toHaveHandler(
				"click",
			),
		)
		scene(
			{ update: pageUpdate, view },
			given(editing),
			mounted,
			mounted,
			mounted,
			expectView(role("dialog", { name: "Post update" })).toExist(),
			expectView(role("dialog", { name: "Edit details" })).toExist(),
			expectView(role("textbox", { name: "Title" })).toHaveValue("Elevated errors"),
		)
	})
})

describe("editing an incident's details", () => {
	test("Edit details opens the saved title, impact and components in a dialog", () => {
		const opened = pageUpdate(
			shown(incident(1, { title: "Elevated errors" })),
			Message.ClickedEditIncident({ incidentId: incidentId(1) }),
		).model
		expect(opened.editIncidentDialog.isOpen).toBe(true)
		scene(
			{ update: pageUpdate, view },
			given(opened),
			mounted,
			mounted,
			expectView(role("textbox", { name: "Title" })).toHaveValue("Elevated errors"),
			expectView(role("checkbox", { name: "Component 1" })).toBeChecked(),
			expectView(role("checkbox", { name: "Component 2" })).not.toBeChecked(),
		)
	})

	test("saving an edit sends the trimmed title, the impact and the components once, and posts no update", () => {
		const edited = steps(shown(incident(1)), [
			Message.ClickedEditIncident({ incidentId: incidentId(1) }),
			Message.ChangedIncidentEditField({ field: "title", value: " Checkout errors " }),
			Message.ChangedIncidentEditField({ field: "impact", value: "critical" }),
			Message.ToggledIncidentEditComponent({ componentId: componentId(2) }),
		])
		const saving = pageUpdate(edited, Message.SubmittedIncidentEdit())
		expect(saving.commands).toMatchObject([
			{
				name: "SaveStatusPageIncident",
				args: {
					incidentId: incidentId(1),
					payload: {
						title: "Checkout errors",
						impact: "critical",
						component_ids: [componentId(1), componentId(2)],
					},
				},
			},
		])
		expect(pageUpdate(saving.model, Message.SubmittedIncidentEdit()).commands ?? []).toEqual([])
		const saved = pageUpdate(
			saving.model,
			Message.CompletedSaveIncident({
				result: Result.succeed(incident(1, { title: "Checkout errors", impact: "critical" })),
			}),
		)
		expect(saved.model.editIncidentDialog.isOpen).toBe(false)
		expect(names(saved.commands)).not.toContain("PostStatusPageIncidentUpdate")
		expect(saved.outMessage).toMatchObject({ _tag: "RequestedToast", type: "success" })
	})

	test("an edit with no title is not sent, and a refused save keeps what was typed with the reason", () => {
		const opened = pageUpdate(
			shown(incident(1)),
			Message.ClickedEditIncident({ incidentId: incidentId(1) }),
		).model
		const blank = pageUpdate(
			opened,
			Message.ChangedIncidentEditField({ field: "title", value: "  " }),
		).model
		expect(pageUpdate(blank, Message.SubmittedIncidentEdit()).commands ?? []).toEqual([])
		const refused = steps(opened, [
			Message.ChangedIncidentEditField({ field: "title", value: "Checkout errors" }),
			Message.SubmittedIncidentEdit(),
			Message.CompletedSaveIncident({ result: Result.fail(toLoadFailure(new Error("save refused"))) }),
		])
		expect(refused.incidentEdit?.title).toBe("Checkout errors")
		expect(refused.editIncidentDialog.isOpen).toBe(true)
		scene(
			{ update: pageUpdate, view },
			given(refused),
			mounted,
			mounted,
			expectView(text("Couldn't save the changes")).toExist(),
			expectView(role("button", { name: "Save changes" })).toBeEnabled(),
		)
	})

	test("maintenance has no impact to edit, so its save sends none", () => {
		const opened = pageUpdate(
			shown(
				incident(1, {
					kind: "maintenance",
					status: "scheduled",
					impact: "none",
					scheduled_start: "1970-01-01T01:10:00.000Z",
					scheduled_end: "1970-01-01T02:10:00.000Z",
				}),
			),
			Message.ClickedEditIncident({ incidentId: incidentId(1) }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(opened),
			mounted,
			mounted,
			expectView(role("textbox", { name: "Title" })).toExist(),
			expectView(role("combobox", { name: "Impact" })).not.toExist(),
		)
		const sent = pageUpdate(opened, Message.SubmittedIncidentEdit()).commands ?? []
		expect(sent).toMatchObject([{ name: "SaveStatusPageIncident" }])
		expect(sent[0]?.args?.payload).not.toHaveProperty("impact")
	})

	const maintenance = incident(1, {
		kind: "maintenance",
		status: "scheduled",
		impact: "none",
		scheduled_start: "1970-01-01T01:10:00.000Z",
		scheduled_end: "1970-01-01T02:10:00.000Z",
	})

	test("a maintenance window is edited in the viewer's zone, sending only the bound that changed", () => {
		const zoned: PageContext = { ...context, timeZone: "Europe/Berlin" }
		const opened = update(
			shown(maintenance),
			Message.ClickedEditIncident({ incidentId: incidentId(1) }),
			zoned,
		).model
		expect(opened.incidentEdit).toMatchObject({ start: "1970-01-01T02:10", end: "1970-01-01T03:10" })
		const inverted = steps(
			opened,
			[Message.ChangedIncidentEditField({ field: "end", value: "1970-01-01T02:00" })],
			zoned,
		)
		expect(update(inverted, Message.SubmittedIncidentEdit(), zoned).commands ?? []).toEqual([])
		const extended = steps(
			inverted,
			[Message.ChangedIncidentEditField({ field: "end", value: "1970-01-01T04:00" })],
			zoned,
		)
		const sent = update(extended, Message.SubmittedIncidentEdit(), zoned).commands ?? []
		expect(sent[0]?.args?.payload).toMatchObject({ scheduled_end: "1970-01-01T03:00:00.000Z" })
		expect(sent[0]?.args?.payload).not.toHaveProperty("scheduled_start")
	})

	test("completed maintenance offers no window to edit", () => {
		const opened = pageUpdate(
			shown({ ...maintenance, status: "completed", resolved_at: "1970-01-01T02:10:00.000Z" }),
			Message.ClickedEditIncident({ incidentId: incidentId(1) }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(opened),
			mounted,
			mounted,
			expectView(role("textbox", { name: "Starts" })).not.toExist(),
			expectView(role("textbox", { name: "Ends" })).not.toExist(),
		)
	})

	test("an incident's start and end can't move into the future", () => {
		const opened = pageUpdate(
			shown(incident(1, { status: "resolved", resolved_at: "2026-10-01T11:55:00.000Z" })),
			Message.ClickedEditIncident({ incidentId: incidentId(1) }),
		).model
		const lateEnd = pageUpdate(
			opened,
			Message.ChangedIncidentEditField({ field: "end", value: "2026-10-01T12:30" }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(lateEnd),
			mounted,
			mounted,
			expectView(text("It can't end in the future.")).toExist(),
			expectView(role("button", { name: "Save changes" })).toBeDisabled(),
		)
		expect(pageUpdate(lateEnd, Message.SubmittedIncidentEdit()).commands ?? []).toEqual([])
		const lateStart = pageUpdate(
			opened,
			Message.ChangedIncidentEditField({ field: "start", value: "2026-10-02T09:00" }),
		).model
		expect(pageUpdate(lateStart, Message.SubmittedIncidentEdit()).commands ?? []).toEqual([])
		scene(
			{ update: pageUpdate, view },
			given(lateStart),
			mounted,
			mounted,
			expectView(text("It can't start in the future.")).toExist(),
		)
	})

	test("a resolved incident's start and end can be corrected, but not out of order", () => {
		const opened = pageUpdate(
			shown(incident(1, { status: "resolved", resolved_at: "2026-10-01T11:55:00.000Z" })),
			Message.ClickedEditIncident({ incidentId: incidentId(1) }),
		).model
		const inverted = pageUpdate(
			opened,
			Message.ChangedIncidentEditField({ field: "start", value: "2026-10-01T11:57" }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(inverted),
			mounted,
			mounted,
			expectView(text("It can't end before it started.")).toExist(),
			expectView(role("button", { name: "Save changes" })).toBeDisabled(),
		)
		const corrected = pageUpdate(
			inverted,
			Message.ChangedIncidentEditField({ field: "start", value: "2026-10-01T11:40" }),
		).model
		const sent = pageUpdate(corrected, Message.SubmittedIncidentEdit()).commands ?? []
		expect(sent[0]?.args?.payload).toMatchObject({ started_at: "2026-10-01T11:40:00.000Z" })
		expect(sent[0]?.args?.payload).not.toHaveProperty("resolved_at")
	})
})

describe("deleting an incident", () => {
	test("deleting an incident asks first, deletes it once and closes its panel", () => {
		const asking = pageUpdate(
			shown(incident(1, { status: "resolved" })),
			Message.ClickedDeleteIncident({ incidentId: incidentId(1) }),
		)
		expect(asking.model.confirmDeleteIncidentId).toBe(incidentId(1))
		expect(asking.model.deleteIncidentDialog.isOpen).toBe(true)
		expect(names(asking.commands)).not.toContain("DeleteStatusPageIncident")
		const deleting = pageUpdate(asking.model, Message.ClickedConfirmDeleteIncident())
		expect(deleting.commands).toMatchObject([
			{ name: "DeleteStatusPageIncident", args: { incidentId: incidentId(1) } },
		])
		expect(pageUpdate(deleting.model, Message.ClickedConfirmDeleteIncident()).commands ?? []).toEqual([])
		const deleted = pageUpdate(
			deleting.model,
			Message.CompletedDeleteIncident({ result: Result.succeed(undefined) }),
		)
		expect(deleted.model.panel).toBeNull()
		expect(deleted.model.deleteIncidentDialog.isOpen).toBe(false)
		expect(names(deleted.commands)).toContain("FetchStatusPageIncidents")
	})

	test("a delete that fails leaves the incident open in the panel and says why", () => {
		const deleting = pageUpdate(
			pageUpdate(shown(incident(1)), Message.ClickedDeleteIncident({ incidentId: incidentId(1) }))
				.model,
			Message.ClickedConfirmDeleteIncident(),
		).model
		const failed = pageUpdate(
			deleting,
			Message.CompletedDeleteIncident({
				result: Result.fail(toLoadFailure(new Error("delete refused"))),
			}),
		)
		expect(failed.model.panel).toEqual({ _tag: "Incident", incidentId: incidentId(1) })
		expect(failed.model.isDeletingIncident).toBe(false)
		expect(failed.outMessage).toMatchObject({ _tag: "RequestedToast", type: "error" })
	})
})

describe("an update in flight", () => {
	const posting = () =>
		steps(
			loaded({
				incidents: [incident(1, { status: "identified" }), incident(2, { status: "identified" })],
			}),
			[
				Message.ClickedPostUpdate({ incidentId: incidentId(1), isResolving: false }),
				Message.ChangedUpdateField({ field: "body", value: "Fixed." }),
				Message.SubmittedUpdateWrite(),
				Message.SubmittedUpdate(),
			],
		)

	test("edits, closing and another incident's Post update wait, and a failure keeps the text", () => {
		const held = steps(posting(), [
			Message.ChangedUpdateField({ field: "body", value: "Other" }),
			Message.ClickedUpdateBack(),
			Message.GotUpdateDialogMessage({ message: Dialog.Message.ClickedClose() }),
			Message.ClickedPostUpdate({ incidentId: incidentId(2), isResolving: false }),
		])
		expect(held.updateDialog.isOpen).toBe(true)
		expect(held.updateForm).toMatchObject({
			_tag: "Posting",
			form: { incidentId: incidentId(1), body: "Fixed." },
		})
		const failed = pageUpdate(
			held,
			Message.CompletedPostUpdate({ result: Result.fail(toLoadFailure(new Error("unreachable"))) }),
		).model
		expect(failed.updateForm).toMatchObject({ _tag: "Failed", form: { body: "Fixed." } })
	})

	test("a success closes the dialog and reads the incidents again", () => {
		const done = pageUpdate(
			posting(),
			Message.CompletedPostUpdate({ result: Result.succeed(incident(1)) }),
		)
		expect(done.model.updateDialog.isOpen).toBe(false)
		expect(names(done.commands)).toContain("FetchStatusPageIncidents")
		expect(done.outMessage).toMatchObject({ _tag: "RequestedToast", type: "success" })
	})
})

describe("header", () => {
	test("Incidents leads with Declare incident and Maintenance with Schedule maintenance", () => {
		const declaring = pageUpdate(
			loaded({ tab: "incidents" }),
			Message.ClickedNewIncident({ kind: "incident" }),
		)
		expect(declaring.model.incidentForm.kind).toBe("incident")
		scene(
			{ update: pageUpdate, view },
			given(loaded({ tab: "incidents" })),
			expectView(role("button", { name: "Declare incident" })).toExist(),
			expectView(role("link", { name: "Open page" })).not.toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(loaded({ tab: "maintenance" })),
			expectView(role("button", { name: "Schedule maintenance" })).toExist(),
			expectView(text("No maintenance yet")).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(loaded()),
			expectView(role("button", { name: "Declare incident" })).not.toExist(),
			expectView(role("link", { name: "Live page" })).toHaveAttr("aria-current", "page"),
		)
	})

	test("an empty Incidents or Maintenance tab explains it, links the docs and offers one button to post", () => {
		for (const [tab, title, action, kind] of [
			["incidents", "No incidents yet", "Declare incident", "incident"],
			["maintenance", "No maintenance yet", "Schedule maintenance", "maintenance"],
		] as const) {
			scene(
				{ update: pageUpdate, view },
				given(
					loaded({
						tab,
						incidents: [incident(1, { kind: kind === "incident" ? "maintenance" : "incident" })],
					}),
				),
				expectView(text(title)).toExist(),
				expectView(role("link", { name: "Read the docs" })).toHaveAttr(
					"href",
					"https://maple.dev/docs/alerting/status-pages#incidents-and-maintenance-notices",
				),
				expectView(role("button", { name: action })).toExist(),
				expectView(role("table")).not.toExist(),
			)
		}
		scene(
			{ update: pageUpdate, view },
			given(loaded({ tab: "incidents", incidents: [incident(1)] })),
			expectView(text("No incidents yet")).not.toExist(),
			expectView(role("button", { name: "Declare incident" })).toExist(),
		)
	})

	test("the Incidents tab counts open incidents and lists them apart from resolved ones", () => {
		const model = loaded({
			tab: "incidents",
			incidents: [
				incident(1, { title: "Elevated errors" }),
				incident(2, {
					title: "Old outage",
					status: "resolved",
					resolved_at: "2026-09-30T12:00:00.000Z",
				}),
				incident(3, { kind: "maintenance", title: "Database upgrade" }),
			],
		})
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(role("link", { name: /^Incidents\s*1$/u })).toHaveAttr("aria-current", "page"),
			inside(role("table", { name: "Active" }), expectView(text("Elevated errors")).toExist()),
			inside(role("table", { name: "Resolved" }), expectView(text("Old outage")).toExist()),
			expectView(text("Database upgrade")).not.toExist(),
			click(role("button", { name: "Elevated errors" })),
			mounted,
			Command.resolve(
				Animation.WaitForPaint,
				Animation.Message.CompletedWaitForPaint({ generation: 1 }),
			),
			Command.resolve(
				Animation.WaitForAnimationSettled,
				Animation.Message.EndedAnimation({ generation: 1 }),
			),
			expectView(role("dialog", { name: "Elevated errors" })).toExist(),
			expectView(role("button", { name: "Post update" })).toExist(),
		)
	})

	test("the Maintenance tab lists what is in progress, how each ends, and completes one over time", () => {
		const model = loaded({
			tab: "maintenance",
			incidents: [
				incident(1, {
					kind: "maintenance",
					title: "Index rebuild",
					status: "in_progress",
					impact: "none",
					auto_complete: false,
					scheduled_start: "2026-10-01T08:00:00.000Z",
					scheduled_end: "2026-10-01T10:00:00.000Z",
				}),
				incident(2, {
					kind: "maintenance",
					title: "Database upgrade",
					status: "scheduled",
					impact: "none",
					scheduled_start: "2026-10-03T02:00:00.000Z",
					scheduled_end: "2026-10-03T03:00:00.000Z",
				}),
			],
		})
		scene(
			{ update: pageUpdate, view },
			given(model),
			inside(
				role("table", { name: "In progress" }),
				expectView(text("Index rebuild")).toExist(),
				expectView(text("You complete it")).toExist(),
				expectView(text("2h over")).toExist(),
			),
			inside(
				role("table", { name: "Upcoming" }),
				expectView(text("Database upgrade")).toExist(),
				expectView(text("Auto-complete")).toExist(),
			),
		)
		const reopened = loaded({
			tab: "maintenance",
			incidents: [
				incident(3, {
					kind: "maintenance",
					title: "Reopened upgrade",
					status: "completed",
					impact: "none",
					resolved_at: "2026-10-01T11:00:00.000Z",
					updates: [
						{
							id: updateId(3),
							status: "completed",
							body: "Done.",
							source: "dashboard",
							created_at: "2026-10-01T11:00:00.000Z",
						},
						{
							id: updateId(2),
							status: "in_progress",
							body: "Back on it.",
							source: "dashboard",
							created_at: "2026-10-01T10:30:00.000Z",
						},
						{
							id: updateId(1),
							status: "completed",
							body: "The scheduled maintenance is complete.",
							source: "auto",
							created_at: "2026-10-01T10:00:00.000Z",
						},
					],
				}),
			],
		})
		scene(
			{ update: pageUpdate, view },
			given(reopened),
			inside(role("table", { name: "Completed" }), expectView(text("Manually")).toExist()),
		)
		scene(
			{ update: pageUpdate, view },
			given(model),
			inside(
				role("table", { name: "In progress" }),
				expectView(role("button", { name: "Complete" })).toExist(),
			),
		)
		// Without the post grant the overrun still shows, with Complete locked.
		const withoutPost = { ...model, grants: [] }
		scene(
			{ update: pageUpdate, view },
			given(withoutPost),
			inside(
				role("table", { name: "In progress" }),
				expectView(text("2h over")).toExist(),
				expectView(role("button", { name: "Complete" })).toBeDisabled(),
			),
		)
		const completing = pageUpdate(
			model,
			Message.ClickedPostUpdate({ incidentId: incidentId(1), isResolving: true }),
		).model
		expect(completing.updateDialog.isOpen).toBe(true)
		expect(completing.updateForm).toMatchObject({ form: { status: "completed" } })
	})

	test("closing the incident's sheet closes the incident", () => {
		const open = pageUpdate(
			loaded({ tab: "incidents", incidents: [incident(1)] }),
			Message.ClickedIncident({ incidentId: incidentId(1) }),
		).model
		expect(open.panelSheet.isOpen).toBe(true)
		const closed = pageUpdate(
			open,
			Message.GotPanelSheetMessage({ message: Dialog.Message.ClickedClose() }),
		).model
		expect(closed.panel).toBeNull()
		expect(closed.panelSheet.isOpen).toBe(false)
	})

	test("old Appearance and JSON links open those Settings sections", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded({ tab: "appearance" })),
			pickersMounted(1),
			expectView(role("link", { name: "Settings" })).toHaveAttr("aria-current", "page"),
			expectView(role("link", { name: "Appearance" })).toHaveAttr("aria-current", "page"),
		)
		expect(
			names(
				init({ _tag: "StatusPage", pageId: PUBLIC_ID, search: { view: "json" } }, context).commands,
			),
		).toContain("FetchStatusPageConfig")
	})

	test("the header has no open button: the menu opens the public page or the dev preview", () => {
		const pick = (model: Model, value: string) =>
			pageUpdate(
				model,
				Message.GotPageMenuMessage({
					message: { _tag: "ClickedItem", index: 0, item: { kind: "Item", value } },
				}),
			)
		const published = { ...loaded(), publicBaseUrl: "https://status-pages.maple.dev" }
		scene(
			{ update: pageUpdate, view },
			given(published),
			expectView(role("link", { name: "Open page" })).not.toExist(),
			expectView(role("link", { name: "Open public page" })).not.toExist(),
		)
		expect(pick(published, "open-public").commands?.at(-1)).toMatchObject({
			name: "OpenStatusPublicPage",
			args: { url: `https://status-pages.maple.dev/s/${KEY}/acme-status` },
		})
		const internal = {
			...loaded({ page: statusPage({ visibility: "internal" }) }),
			publicBaseUrl: "https://status-pages.maple.dev",
		}
		expect(names(pick(internal, "open-public").commands)).not.toContain("OpenStatusPublicPage")
		const draft = {
			...loaded({ page: statusPage({ draft: true, published_at: null }) }),
			publicBaseUrl: "https://status-pages.maple.dev",
		}
		expect(names(pick(draft, "open-public").commands)).not.toContain("OpenStatusPublicPage")
		for (const model of [published, internal, draft])
			expect(pick(model, "open-preview").outMessage).toEqual(
				PageOutMessage.RequestedNavigation({
					url: `/status-pages/${PUBLIC_ID}/view`,
					isReplace: false,
				}),
			)
	})
})

describe("drafts", () => {
	test("a draft page says it is not public and offers Publish, which goes to the live screen", () => {
		const model = loaded({ page: statusPage({ draft: true, published_at: null }) })
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(text("Draft, not public")).toExist(),
			expectView(text("Draft. Nothing is public until you publish.")).toExist(),
			expectView(text("This page is a draft")).toExist(),
			expectView(role("button", { name: "Publish page" })).toExist(),
		)
		const publishing = pageUpdate(model, Message.ClickedPublish())
		expect(names(publishing.commands)).toEqual(["PublishStatusPage"])
		const done = pageUpdate(
			publishing.model,
			Message.CompletedPublish({
				result: Result.succeed({
					id: statusPage().id,
					object: "status_page.publish_result",
					outcome: "published",
					revision: 4,
				}),
			}),
		)
		expect(done.outMessage).toMatchObject({
			_tag: "RequestedNavigation",
			url: `/status-pages/${PUBLIC_ID}?view=live`,
		})
	})
})

describe("live screen", () => {
	const live = (publicBaseUrl: string): Model => ({ ...loaded({ tab: "live" }), publicBaseUrl })

	test("a draft reached by link says it is not public, not that it is live", () => {
		scene(
			{ update: pageUpdate, view },
			given({
				...loaded({ tab: "live", page: statusPage({ draft: true }) }),
				publicBaseUrl: "https://status-pr-7.maple.dev",
			}),
			expectView(role("heading", { name: "Acme Status is not public yet" })).toExist(),
			expectView(role("heading", { name: "Acme Status is live" })).not.toExist(),
			// The publisher skips a draft, so its address would not resolve: no link to open.
			expectView(role("link", { name: "Open" })).not.toExist(),
			expectView(
				role("link", { name: `https://status-pr-7.maple.dev/s/${KEY}/acme-status` }),
			).not.toExist(),
		)
	})

	test("with a status domain: the full address to copy and open, and the next steps", () => {
		scene(
			{ update: pageUpdate, view },
			given(live("https://status-pr-7.maple.dev")),
			expectView(role("heading", { name: "Acme Status is live" })).toExist(),
			expectView(selector("#status-page-public-url")).toHaveValue(
				`https://status-pr-7.maple.dev/s/${KEY}/acme-status`,
			),
			expectView(role("link", { name: "Open public page" })).toHaveAttr(
				"href",
				`https://status-pr-7.maple.dev/s/${KEY}/acme-status`,
			),
			expectView(role("button", { name: "Copy public address" })).toExist(),
			expectView(role("button", { name: "Get break-glass token" })).toExist(),
			expectView(role("link", { name: "Page JSON" })).toHaveAttr(
				"href",
				`/status-pages/${PUBLIC_ID}?view=settings&section=advanced`,
			),
		)
	})

	test("without a status domain: a note in place of the address, no link, and publishing still works", () => {
		const model = live("")
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(text("Public address appears once a status domain is configured")).toExist(),
			expectView(selector("#status-page-public-url")).not.toExist(),
			expectView(role("link", { name: "Open public page" })).not.toExist(),
			expectView(role("link", { name: /\/s\/[0-9a-f]{12}\/acme-status/u })).not.toExist(),
			expectView(role("button", { name: "Get break-glass token" })).toExist(),
		)
		const draft = {
			...loaded({ page: statusPage({ draft: true, published_at: null }) }),
			publicBaseUrl: "",
		}
		expect(names(pageUpdate(draft, Message.ClickedPublish()).commands)).toEqual(["PublishStatusPage"])
	})

	test("the header links the public page once a status domain is set", () => {
		scene(
			{ update: pageUpdate, view },
			given({ ...loaded(), publicBaseUrl: "https://status-pr-7.maple.dev" }),
			expectView(
				role("link", { name: `https://status-pr-7.maple.dev/s/${KEY}/acme-status` }),
			).toHaveAttr("href", `https://status-pr-7.maple.dev/s/${KEY}/acme-status`),
		)
		scene(
			{ update: pageUpdate, view },
			given({ ...loaded(), publicBaseUrl: "" }),
			expectView(text("Public address appears once a status domain is configured")).toExist(),
		)
	})

	test("an internal page is live for members in Maple: no public address and no break-glass token", () => {
		scene(
			{ update: pageUpdate, view },
			given({
				...loaded({ tab: "live", page: statusPage({ visibility: "internal" }) }),
				publicBaseUrl: "https://status-pr-7.maple.dev",
			}),
			expectView(role("heading", { name: "Acme Status is live" })).toExist(),
			expectView(text("Only members of this organization can read it, in Maple.")).toExist(),
			expectView(text(/Visitors can read it now/u)).not.toExist(),
			expectView(selector("#status-page-public-url")).not.toExist(),
			expectView(role("link", { name: /\/s\/[0-9a-f]{12}\/acme-status/u })).not.toExist(),
			expectView(role("link", { name: "Open dev preview" })).toHaveAttr(
				"href",
				`/status-pages/${PUBLIC_ID}/view`,
			),
			expectView(role("button", { name: "Get break-glass token" })).not.toExist(),
		)
	})

	test("an engineer edits the page but cannot issue a break-glass token", () => {
		const engineer = {
			...live("https://status-pr-7.maple.dev"),
			grants: Policy.grantsOf(["org:engineer"]),
		}
		scene(
			{ update: pageUpdate, view },
			given(engineer),
			expectView(role("button", { name: "Get break-glass token" })).not.toExist(),
		)
		expect(names(pageUpdate(engineer, Message.ClickedRotateToken()).commands)).toEqual([])
	})

	test("Get break-glass token issues one at once and shows it once", () => {
		const issuing = pageUpdate(loaded({ tab: "live" }), Message.ClickedRotateToken())
		expect(names(issuing.commands)).toEqual(["RotateStatusPageBreakGlassToken"])
	})
})

describe("settings", () => {
	test("an edit raises the save bar, and a bad color blocks the save", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(APPEARANCE)),
			pickersMounted(1),
			expectView(text("Unsaved changes")).not.toExist(),
			type(role("textbox", { name: "Accent" }), "teal"),
			expectView(text("Unsaved changes")).toExist(),
			expectView(text("Use a hex color like #1a2b3c.")).toExist(),
			expectView(role("button", { name: "Save" })).toBeDisabled(),
		)
	})

	test("a bad field in Basic settings blocks the save on Appearance too, and the bar names its section", () => {
		const edited = pageUpdate(
			loaded({ tab: "settings" }),
			Message.ChangedSetting({ field: "name", value: " " }),
		).model
		scene(
			{ update: pageUpdate, view },
			given({ ...edited, search: { view: "settings", section: "appearance" } }),
			pickersMounted(1),
			expectView(text("Fix the fields marked in Basic settings.")).toExist(),
			expectView(role("button", { name: "Save" })).toBeDisabled(),
		)
	})

	test("a footer link must use https before the settings save", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded({ tab: "settings", section: "appearance" })),
			pickersMounted(1),
			type(role("textbox", { name: "Terms of service URL" }), "http://acme.example/terms"),
			expectView(text("Use an https URL.")).toExist(),
			expectView(role("button", { name: "Save" })).toBeDisabled(),
		)
	})

	test("saving sends every field and settles once the page matches", () => {
		const edited = Arr.reduce(
			[
				Message.ChangedThemeColor({ field: "accent", value: "#1A2B3C" }),
				Message.PickedThemePreset({ preset: "paper" }),
				Message.ChangedSetting({ field: "autoIncidents", value: "publish" }),
				Message.ToggledPoweredBy(),
				Message.ChangedSetting({ field: "privacyUrl", value: " https://acme.example/privacy " }),
			],
			loaded({ tab: "settings" }),
			(model, message) => pageUpdate(model, message).model,
		)
		const saving = pageUpdate(edited, Message.ClickedSaveSettings())
		expect(saving.commands).toMatchObject([
			{
				name: "SaveStatusPageSettings",
				args: {
					payload: {
						name: "Acme Status",
						slug: "acme-status",
						theme: {
							...DEFAULT_STATUS_PAGE_THEME,
							preset: "paper",
							font: "serif",
							radius: "sm",
							accent: "#1a2b3c",
						},
						show_powered_by: false,
						auto_incidents: "publish",
						website_url: null,
						privacy_url: "https://acme.example/privacy",
						terms_url: null,
					},
				},
			},
		])
		const saved = statusPage({
			theme: {
				...DEFAULT_STATUS_PAGE_THEME,
				preset: "paper",
				font: "serif",
				radius: "sm",
				accent: "#1a2b3c",
			},
			show_powered_by: false,
			auto_incidents: "publish",
			privacy_url: "https://acme.example/privacy",
		})
		const done = pageUpdate(
			saving.model,
			Message.CompletedSaveSettings({ result: Result.succeed(saved) }),
		)
		expect(done.model.settingsEdits).toBeNull()
	})

	test("Auto disables the colour overrides but not the accent", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(APPEARANCE)),
			pickersMounted(1),
			expectView(role("textbox", { name: "Background" })).toBeDisabled(),
			expectView(role("textbox", { name: "Text" })).toBeDisabled(),
			expectView(role("textbox", { name: "Accent" })).toBeEnabled(),
			inside(role("group", { name: "Mode" }), click(role("button", { name: "Dark" }))),
			pickersMounted(4),
			expectView(role("textbox", { name: "Background" })).toBeEnabled(),
		)
	})

	test("an unreadable text colour shows its contrast and blocks the save", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(APPEARANCE)),
			pickersMounted(1),
			inside(role("group", { name: "Mode" }), click(role("button", { name: "Light" }))),
			pickersMounted(4),
			type(role("textbox", { name: "Text" }), "#757575"),
			expectView(
				text("Text on the background has a contrast of 4.49:1; it needs at least 4.5:1."),
			).toExist(),
			expectView(role("button", { name: "Save" })).toBeDisabled(),
		)
	})

	test("the page preview is the page's own renderer, sandboxed, following the unsaved theme", () => {
		const theme = srcdocOf("Acme Status with these settings")
		scene(
			{ update: pageUpdate, view },
			given(loaded(APPEARANCE)),
			pickersMounted(1),
			expectView(
				selector('maple-preview-frame[frame-title="Acme Status with these settings"]'),
			).toHaveAttr("sandbox", "allow-scripts"),
			tap(({ html }) => {
				expect(theme(html)).toContain("Component 1")
				expect(theme(html)).toContain("color-scheme:light;")
			}),
			inside(role("group", { name: "Mode" }), click(role("button", { name: "Dark" }))),
			pickersMounted(4),
			tap(({ html }) => expect(theme(html)).toContain("color-scheme:dark;")),
			type(role("textbox", { name: "Accent" }), "#ff0066"),
			tap(({ html }) => expect(theme(html)).toContain("--link:#ff0066")),
		)
	})

	test("an uploaded favicon is read into the form; a file the API would refuse is not", () => {
		const page = loaded(APPEARANCE)
		const pdf = pageUpdate(
			page,
			Message.PickedBrandingImage({
				field: "faviconUrl",
				files: [new File(["%PDF"], "icon.pdf", { type: "application/pdf" })],
			}),
		)
		expect(pdf.commands ?? []).toEqual([])
		expect(pdf.outMessage).toMatchObject({ _tag: "RequestedToast", title: "Couldn't use that image" })

		const png = pageUpdate(
			page,
			Message.PickedBrandingImage({
				field: "faviconUrl",
				files: [new File(["png"], "icon.png", { type: "image/png" })],
			}),
		)
		expect(names(png.commands)).toEqual(["ReadStatusPageBrandingImage"])
		const done = Message.CompletedReadBrandingImage({
			field: "faviconUrl",
			read: png.model.brandingRead,
			dataUrl: "data:image/png;base64,cG5n",
		})
		const read = pageUpdate(png.model, done).model
		expect(read.settingsEdits?.faviconUrl).toBe("data:image/png;base64,cG5n")
		// Removed while the file was still being read: the late read does not bring it back.
		const removed = pageUpdate(
			png.model,
			Message.ClickedRemoveBrandingImage({ field: "faviconUrl" }),
		).model
		expect(pageUpdate(removed, done).model.settingsEdits?.faviconUrl).toBe("")
		scene(
			{ update: pageUpdate, view },
			given(read),
			pickersMounted(1),
			expectView(role("button", { name: "Change favicon" })).toExist(),
			expectView(role("button", { name: "Save" })).toBeEnabled(),
		)
	})

	test("an image is added from its dialog: a link applies on Use link, a bad one waits", () => {
		const opened = pageUpdate(
			loaded(APPEARANCE),
			Message.ClickedEditBrandingImage({ field: "logoUrl" }),
		).model
		expect(opened.brandingDialog.isOpen).toBe(true)
		scene(
			{ update: pageUpdate, view },
			given(opened),
			mounted,
			pickersMounted(1),
			expectView(role("dialog", { name: "Logo" })).toExist(),
			expectView(role("button", { name: "Upload an image" })).toExist(),
			type(role("textbox", { name: "Link to an image" }), "http://acme.example/logo.svg"),
			expectView(text("Use an https URL.")).toExist(),
			expectView(role("button", { name: "Use link" })).toBeDisabled(),
		)
		const typed = pageUpdate(
			opened,
			Message.ChangedBrandingLink({ value: " https://acme.example/logo.svg " }),
		)
		const applied = pageUpdate(typed.model, Message.SubmittedBrandingLink()).model
		expect(applied.settingsEdits?.logoUrl).toBe("https://acme.example/logo.svg")
		expect(applied.brandingDialog.isOpen).toBe(false)
		// Reopened on a linked image, the dialog starts from its link.
		expect(
			pageUpdate(applied, Message.ClickedEditBrandingImage({ field: "logoUrl" })).model.brandingLink,
		).toBe("https://acme.example/logo.svg")
	})

	test("the branding images preview at once: the logo in the header, the favicon in the tab", () => {
		const header = srcdocOf("Acme Status with these settings")
		const branded = steps(loaded(APPEARANCE), [
			Message.ChangedSetting({ field: "logoUrl", value: "https://acme.example/logo.svg" }),
			Message.ChangedSetting({ field: "logoDarkUrl", value: "https://acme.example/logo-dark.svg" }),
			Message.ChangedSetting({ field: "faviconUrl", value: "https://acme.example/favicon.png" }),
		])
		scene(
			{ update: pageUpdate, view },
			given(branded),
			pickersMounted(1),
			expectView(role("button", { name: "Change logo" })).toExist(),
			tap(({ html }) => {
				expect(header(html)).toContain(`<img src="https://acme.example/logo.svg"`)
				expect(header(html)).toContain(`<link rel="icon" href="https://acme.example/favicon.png">`)
			}),
			inside(role("group", { name: "Mode" }), click(role("button", { name: "Dark" }))),
			pickersMounted(4),
			tap(({ html }) =>
				expect(header(html)).toContain(`<img src="https://acme.example/logo-dark.svg"`),
			),
		)
	})

	test("the sections that shape the page show it beside them, as the unsaved settings render it", () => {
		const page = srcdocOf("Globex with these settings")
		const named = Arr.reduce(
			[
				Message.ChangedSetting({ field: "name", value: "Globex" }),
				Message.ChangedSetting({ field: "description", value: "Live status of Globex" }),
			],
			loaded(BASIC),
			(model, message) => pageUpdate(model, message).model,
		)
		scene(
			{ update: pageUpdate, view },
			given({ ...named, search: { view: "settings", section: "appearance" } }),
			pickersMounted(1),
			tap(({ html }) => {
				expect(page(html)).toContain("<title>Globex status</title>")
				expect(page(html)).toContain("Live status of Globex")
				expect(page(html)).toContain("Component 1")
			}),
		)
		scene(
			{ update: pageUpdate, view },
			given(loaded(ADVANCED)),
			expectView(role("region", { name: "Page preview" })).not.toExist(),
		)
	})

	test("Basic settings show no preview, and say where visitors meet the name as typed", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(BASIC)),
			expectView(role("region", { name: "Page preview" })).not.toExist(),
			type(role("textbox", { name: "Name" }), "Globex"),
			expectView(text(/"Globex status"/u)).toExist(),
		)
	})

	test("Appearance holds the powered-by credit: it leaves the page as toggled", () => {
		const page = srcdocOf("Acme Status with these settings")
		scene(
			{ update: pageUpdate, view },
			given(loaded(APPEARANCE)),
			pickersMounted(1),
			click(role("switch", { name: "Show powered by Maple" })),
			expectView(text("Unsaved changes")).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(loaded(APPEARANCE)),
			pickersMounted(1),
			tap(({ html }) => expect(page(html)).toContain("Powered by")),
		)
		scene(
			{ update: pageUpdate, view },
			given(pageUpdate(loaded(APPEARANCE), Message.ToggledPoweredBy()).model),
			pickersMounted(1),
			tap(({ html }) => expect(page(html)).not.toContain("Powered by")),
		)
	})

	test("a password-protected page, saved or picked, previews the password form visitors meet", () => {
		const gate = (html: Parameters<ReturnType<typeof srcdocOf>>[0]): string =>
			Option.getOrElse(
				Option.flatMap(
					find('iframe[title="The password form visitors see first"]')(html),
					attr("srcdoc"),
				),
				() => "",
			)
		scene(
			{ update: pageUpdate, view },
			given(loaded({ ...ACCESS, page: statusPage({ visibility: "password", has_password: true }) })),
			tap(({ html }) => {
				expect(gate(html)).toContain("This status page is password-protected")
				expect(gate(html)).toContain("Acme Status")
			}),
		)
		scene(
			{ update: pageUpdate, view },
			given(loaded(ACCESS)),
			expectView(selector('iframe[title="The password form visitors see first"]')).not.toExist(),
			// Picking Password-protected previews the form before it is saved.
			change(role("radio", { name: "Password-protected" }), "on"),
			tap(({ html }) => expect(gate(html)).toContain("This status page is password-protected")),
		)
	})

	test("the settings menu links each section and marks the open one", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(MONITORS)),
			inside(
				role("navigation", { name: "Settings sections" }),
				expectView(role("link", { name: "Monitors" })).toHaveAttr("aria-current", "page"),
				expectView(role("link", { name: "Advanced" })).toHaveAttr(
					"href",
					`/status-pages/${PUBLIC_ID}?view=settings&section=advanced`,
				),
			),
		)
	})

	test("a bad branding link is marked on Appearance, and the Settings save bar points there", () => {
		const edited = pageUpdate(
			loaded(APPEARANCE),
			Message.ChangedSetting({ field: "faviconUrl", value: "http://acme.example/favicon.png" }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(edited),
			pickersMounted(1),
			expectView(text("Use an https URL.")).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given({ ...edited, search: { view: "settings" } }),
			expectView(text("Fix the fields marked in Appearance.")).toExist(),
			expectView(role("button", { name: "Save" })).toBeDisabled(),
		)
	})

	test("the live page can show a state the page is not in, and says it is an example", () => {
		const iframeOf = find("maple-preview-frame")
		const srcdoc = (html: Parameters<typeof iframeOf>[0]): string =>
			Option.getOrElse(Option.flatMap(iframeOf(html), attr("srcdoc")), () => "")
		const note = text("Showing an example state. Visitors still see the live page.")
		const pick = (name: string) =>
			inside(role("group", { name: "Preview state" }), click(role("button", { name })))
		scene(
			{ update: pageUpdate, view },
			given(loaded()),
			expectView(note).not.toExist(),
			tap(({ html }) => expect(srcdoc(html)).not.toContain("Example incident")),
			pick("Outage"),
			tap(({ html }) => expect(srcdoc(html)).toContain("Example incident")),
			expectView(note).toExist(),
			// Looking only: the example is not a page edit and posts nothing.
			expectView(text("Unsaved changes")).not.toExist(),
			pick("Maintenance"),
			tap(({ html }) => {
				expect(srcdoc(html)).toContain("Example maintenance")
				expect(srcdoc(html)).not.toContain("Example incident")
			}),
			pick("All clear"),
			tap(({ html }) => expect(srcdoc(html)).not.toContain("Example maintenance")),
			expectView(note).toExist(),
			pick("Live"),
			expectView(note).not.toExist(),
		)
	})

	test("the preview narrows to a phone and back", () => {
		const pick = (name: string) =>
			inside(role("group", { name: "Preview width" }), click(role("button", { name })))
		scene(
			{ update: pageUpdate, view },
			given(loaded()),
			expectView(selector("maple-preview-frame")).toHaveAttr("data-width", "desktop"),
			pick("Mobile"),
			expectView(selector("maple-preview-frame")).toHaveAttr("data-width", "mobile"),
			expectView(text("Unsaved changes")).not.toExist(),
			pick("Desktop"),
			expectView(selector("maple-preview-frame")).toHaveAttr("data-width", "desktop"),
		)
	})

	test("each color has a picker that opens on the color in effect", () => {
		const accent = selector('[data-slot="color-picker-popup"][aria-label="Accent color"]')
		scene(
			{ update: pageUpdate, view },
			given(loaded(APPEARANCE)),
			pickersMounted(1),
			// Empty field: the preset's own colour, the one the placeholder names.
			expectView(accent).toHaveAttr("data-value", "#000000"),
			type(role("textbox", { name: "Accent" }), "#FF0066"),
			expectView(accent).toHaveAttr("data-value", "#ff0066"),
			// Not a hex colour yet: the picker stays on the preset's.
			type(role("textbox", { name: "Accent" }), "teal"),
			expectView(accent).toHaveAttr("data-value", "#000000"),
			// Auto takes the overrides from the preset, so they have nothing to pick.
			expectView(selector('[aria-label="Background color"]')).not.toExist(),
		)
	})

	test("the first break-glass token is issued at once and shown once", () => {
		const issuing = pageUpdate(loaded(ADVANCED), Message.ClickedRotateToken())
		expect(names(issuing.commands)).toEqual(["RotateStatusPageBreakGlassToken"])
		const issued = pageUpdate(
			issuing.model,
			Message.CompletedRotateToken({
				result: Result.succeed({
					id: statusPage().id,
					object: "status_page.break_glass_token",
					token: "mstat_secret_value_123456",
					token_suffix: "123456",
				}),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(issued),
			expectView(selector('[id="status-page-break-glass-token"]')).toHaveValue(
				"mstat_secret_value_123456",
			),
			click(role("button", { name: "Done" })),
			expectView(
				text("Store it outside Maple, in your password manager. It is not shown again."),
			).not.toExist(),
		)
	})

	test("picking who can view sends nothing, and Password-protected waits for a valid password", () => {
		expect(
			pageUpdate(loaded(ACCESS), Message.PickedVisibility({ visibility: "password" })).commands ?? [],
		).toEqual([])
		scene(
			{ update: pageUpdate, view },
			given(loaded(ACCESS)),
			expectView(role("textbox", { name: "Password" })).not.toExist(),
			change(role("radio", { name: "Password-protected" }), "on"),
			expectView(role("radio", { name: "Password-protected" })).toBeChecked(),
			expectView(text("Unsaved changes")).toExist(),
			expectView(text("Type a password for visitors.")).toExist(),
			expectView(role("button", { name: "Save" })).toBeDisabled(),
			type(role("textbox", { name: "Password" }), "short"),
			expectView(text("Use at least 8 characters")).toExist(),
			expectView(role("button", { name: "Save" })).toBeDisabled(),
			type(role("textbox", { name: "Password" }), "correct horse battery"),
			expectView(text("Password-protected, New password")).toExist(),
			expectView(role("button", { name: "Save" })).toBeEnabled(),
			// Back to Public: the field and what was typed in it go, and nothing is left to save.
			change(role("radio", { name: "Public" }), "on"),
			expectView(role("textbox", { name: "Password" })).not.toExist(),
			expectView(text("Unsaved changes")).not.toExist(),
		)
	})

	test("a taken address shows on the field; the hint gives the full link", () => {
		const typed = pageUpdate(
			{ ...loaded(ACCESS), publicBaseUrl: "https://status-pages.maple.dev" },
			Message.ChangedSetting({ field: "slug", value: "taken" }),
		).model
		const refused = pageUpdate(
			pageUpdate(typed, Message.ClickedSaveSettings()).model,
			Message.CompletedSaveSettings({
				result: Result.fail(
					toLoadFailure(new StatusPageSlugTakenError({ slug: "taken", message: "taken" })),
				),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(refused),
			expectView(text("That address is taken. Pick another.")).toExist(),
			type(role("textbox", { name: "Address" }), "free-one"),
			expectView(text("That address is taken. Pick another.")).not.toExist(),
			expectView(
				text(
					/Visitors read the page at https:\/\/status-pages\.maple\.dev\/s\/[0-9a-f]{12}\/free-one\./u,
				),
			).toExist(),
		)
		// Once the address is free and the save goes through, the field no longer calls it taken.
		const saved = pageUpdate(
			pageUpdate(refused, Message.ClickedSaveSettings()).model,
			Message.CompletedSaveSettings({ result: Result.succeed(statusPage({ slug: "taken" })) }),
		).model
		expect(saved.takenSlug).toBeNull()
	})

	test("the Address hint does not tell an internal or draft page's admin that visitors read it", () => {
		for (const [page, expected] of [
			[statusPage({ visibility: "internal" }), /internal pages are not served there/u],
			[statusPage({ draft: true, published_at: null }), /once it is published/u],
		] as const)
			scene(
				{ update: pageUpdate, view },
				given({ ...loaded({ ...ACCESS, page }), publicBaseUrl: "https://status-pages.maple.dev" }),
				expectView(text(expected)).toExist(),
				expectView(text(/Visitors read the page at/u)).not.toExist(),
			)
	})

	test("the Address hint links the saved address of a live page, not an unsaved or unserved one", () => {
		const live = { ...loaded(ACCESS), publicBaseUrl: "https://status-pages.maple.dev" }
		const url = `https://status-pages.maple.dev/s/${KEY}/acme-status`
		scene(
			{ update: pageUpdate, view },
			given(live),
			// The header's address line and the hint.
			expectAll(all.role("link", { name: url })).toHaveCount(2),
			type(role("textbox", { name: "Address" }), "not-saved"),
			expectAll(all.role("link", { name: url })).toHaveCount(1),
			expectView(role("link", { name: /\/s\/[0-9a-f]{12}\/not-saved/u })).not.toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given({
				...loaded({ ...ACCESS, page: statusPage({ visibility: "internal" }) }),
				publicBaseUrl: live.publicBaseUrl,
			}),
			expectView(role("link", { name: url })).not.toExist(),
		)
	})

	test("with the fields and Who can view both edited, one bar saves the fields, then who can view", () => {
		const edited = Arr.reduce(
			[
				Message.ChangedSetting({ field: "name", value: "Acme Cloud" }),
				Message.PickedVisibility({ visibility: "internal" }),
			],
			loaded(ACCESS),
			(model, message) => pageUpdate(model, message).model,
		)
		scene(
			{ update: pageUpdate, view },
			given(edited),
			expectAll(all.role("button", { name: "Save" })).toHaveCount(1),
		)
		const saving = pageUpdate(edited, Message.ClickedSaveBasic())
		expect(names(saving.commands)).toEqual(["SaveStatusPageSettings"])
		const saved = pageUpdate(
			saving.model,
			Message.CompletedSaveSettings({ result: Result.succeed(statusPage({ name: "Acme Cloud" })) }),
		)
		expect(names(saved.commands)).toEqual(["SaveStatusPageVisibility"])
		expect(saved.model.visibilityDraft).toBe("internal")
		const discarded = pageUpdate(edited, Message.ClickedDiscardBasic()).model
		expect(discarded.settingsEdits).toBeNull()
		expect(discarded.visibilityDraft).toBeNull()
	})

	test("Save sends the password before the visibility, and the password never rides a command's args", () => {
		const typed = Arr.reduce(
			[
				Message.PickedVisibility({ visibility: "password" }),
				Message.ChangedPassword({ value: "correct horse battery" }),
			],
			loaded(ACCESS),
			(model, message) => pageUpdate(model, message).model,
		)
		const saving = pageUpdate(typed, Message.ClickedSaveAccess())
		expect(saving.commands).toMatchObject([{ name: "SetStatusPagePassword" }])
		expect(saving.commands?.[0]).not.toHaveProperty("args")
		const failed = pageUpdate(
			saving.model,
			Message.CompletedAccessChange({
				action: "password",
				result: Result.fail(toLoadFailure(new Error("access unavailable"))),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(failed),
			expectView(text("Couldn't change who can view the page")).toExist(),
			expectView(role("radio", { name: "Password-protected" })).toBeChecked(),
			expectView(role("textbox", { name: "Password" })).toHaveValue("correct horse battery"),
			expectView(role("button", { name: "Save" })).toBeEnabled(),
		)
		const passwordSaved = pageUpdate(
			saving.model,
			Message.CompletedAccessChange({
				action: "password",
				result: Result.succeed(statusPage({ has_password: true })),
			}),
		)
		expect(passwordSaved.commands).toMatchObject([
			{ name: "SaveStatusPageVisibility", args: { visibility: "password" } },
		])
		const saved = pageUpdate(
			passwordSaved.model,
			Message.CompletedAccessChange({
				action: "visibility",
				result: Result.succeed(statusPage({ has_password: true, visibility: "password" })),
			}),
		)
		expect(saved.commands ?? []).toEqual([])
		scene(
			{ update: pageUpdate, view },
			given(saved.model),
			expectView(text("Unsaved changes")).not.toExist(),
			expectView(role("radio", { name: "Password-protected" })).toBeChecked(),
			expectView(role("textbox", { name: "Password" })).toHaveValue(""),
			expectView(role("textbox", { name: "Password" })).toHaveAttr(
				"placeholder",
				"Leave empty to keep the current password",
			),
		)
	})

	test("opening a password page removes its password on Save, and Discard puts it back", () => {
		const protectedPage = loaded({
			...ACCESS,
			page: statusPage({ visibility: "password", has_password: true }),
		})
		scene(
			{ update: pageUpdate, view },
			given(protectedPage),
			// A page with a password saves Password-protected without a new one.
			expectView(text("Unsaved changes")).not.toExist(),
			change(role("radio", { name: "Public" }), "on"),
			expectView(text("Public, removes the page password")).toExist(),
			expectView(role("textbox", { name: "Password" })).not.toExist(),
			click(role("button", { name: "Discard" })),
			expectView(role("radio", { name: "Password-protected" })).toBeChecked(),
			expectView(text("Unsaved changes")).not.toExist(),
			change(role("radio", { name: "Public" }), "on"),
			click(role("button", { name: "Save" })),
			Command.expectExact(SaveVisibility({ pageId: statusPage().id, visibility: "public" })),
			Command.resolve(
				SaveVisibility,
				Message.CompletedAccessChange({
					action: "visibility",
					result: Result.succeed(statusPage({ visibility: "public", has_password: true })),
				}),
			),
			Command.expectExact(RemovePassword({ pageId: statusPage().id })),
			Command.resolve(
				RemovePassword,
				Message.CompletedAccessChange({
					action: "removePassword",
					result: Result.succeed(statusPage({ visibility: "public", has_password: false })),
				}),
			),
			Command.expectNone(),
			expectView(text("Unsaved changes")).not.toExist(),
			expectView(role("radio", { name: "Public" })).toBeChecked(),
		)
	})

	test("a page with a custom domain cannot go internal, and only engineers and admins change who can view", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded({ ...ACCESS, customDomain: pendingDomain })),
			expectView(role("radio", { name: "Internal" })).toBeDisabled(),
			expectView(text("Remove the custom domain first.")).toExist(),
		)
		const member = loaded({ ...ACCESS, grants: Policy.grantsOf(["org:member"]) })
		scene(
			{ update: pageUpdate, view },
			given(pageUpdate(member, Message.PickedVisibility({ visibility: "password" })).model),
			expectView(text("Only org admins and engineers can change who can view status pages.")).toExist(),
			expectView(role("radio", { name: "Password-protected" })).toBeDisabled(),
			expectView(role("radio", { name: "Public" })).toBeChecked(),
			expectView(text("Unsaved changes")).not.toExist(),
		)
	})

	test("replacing or revoking an issued token asks first", () => {
		const model = loaded({ ...ADVANCED, page: statusPage({ break_glass_token_suffix: "ABC123" }) })
		const replacing = pageUpdate(model, Message.ClickedRotateToken())
		expect(names(replacing.commands)).not.toContain("RotateStatusPageBreakGlassToken")
		expect(replacing.model.breakGlassDialog.isOpen).toBe(true)
		const revoking = pageUpdate(model, Message.ClickedRevokeToken())
		expect(revoking.model.breakGlassAction).toBe("revoke")
		expect(pageUpdate(revoking.model, Message.ClickedConfirmBreakGlass()).commands).toMatchObject([
			{ name: "RevokeStatusPageBreakGlassToken" },
		])
	})

	test("deleting the page confirms, then returns to the status pages tab", () => {
		const asking = pageUpdate(loaded({ tab: "settings" }), Message.ClickedDeletePage())
		const deleting = pageUpdate(asking.model, Message.ClickedConfirmDeletePage())
		expect(names(deleting.commands)).toEqual(["DeleteStatusPage"])
		const done = pageUpdate(
			deleting.model,
			Message.CompletedDeletePage({ result: Result.succeed(undefined) }),
		)
		expect(done.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: statusPagesHref(),
				isReplace: true,
				toast: { type: "success", title: "Status page deleted", description: "" },
			}),
		)
	})
})

describe("custom domain", () => {
	test("adding a domain sends the hostname as typed, normalized, then shows the DNS records to add", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(BASIC)),
			expectView(role("button", { name: "Add domain" })).toBeDisabled(),
			type(role("textbox", { name: "Hostname" }), " Status.Acme.com "),
			submit(role("form", { name: "Custom domain" })),
			Command.expectExact(SetCustomDomain({ pageId: statusPage().id, hostname: "status.acme.com" })),
			Command.resolve(
				SetCustomDomain,
				Message.CompletedSetCustomDomain({ result: Result.succeed(pendingDomain) }),
			),
			expectView(text("Waiting for DNS")).toExist(),
			expectView(text("status-domains.maple.dev")).toExist(),
			expectView(text("_cf-custom-hostname.status.acme.com")).toExist(),
			expectView(text("custom hostname does not CNAME to this zone.")).toExist(),
			expectView(role("button", { name: "Copy ownership TXT value" })).toExist(),
			expectView(role("button", { name: "Check now" })).toExist(),
		)
	})

	test("a new domain asks for the CNAME and the ownership record, both copyable", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded({ ...BASIC, customDomain: unprovenDomain })),
			expectView(text("Waiting for DNS")).toExist(),
			expectView(text(/Add both records below/u)).toExist(),
			expectView(text(/remove the TXT record once the domain is active/u)).toExist(),
			expectView(text("_maple-challenge.status.acme.com")).toExist(),
			expectView(text("maple-status-page=1c2ba8fdad86fbbe9cdd85449b0e85c6")).toExist(),
			expectView(text("Proves you own the domain (needed until it is active)")).toExist(),
			expectView(role("button", { name: "Copy routing CNAME value" })).toExist(),
			expectView(role("button", { name: "Copy ownership TXT name" })).toExist(),
			expectView(role("button", { name: "Copy ownership TXT value" })).toExist(),
		)
		// Once the record is found, the hostname's own optional record keeps its label.
		scene(
			{ update: pageUpdate, view },
			given(loaded({ ...BASIC, customDomain: pendingDomain })),
			expectView(text(/Add both records below/u)).not.toExist(),
			expectView(text("Proves you own it (optional with the CNAME in place)")).toExist(),
		)
	})

	test("a hostname held by a claim nobody proved shows the record that claims it", () => {
		const message =
			"status.acme.com is held by another status page that has not proved it owns the domain. To claim it, add a TXT record named _maple-challenge.status.acme.com with the value maple-status-page=1c2ba8fdad86fbbe9cdd85449b0e85c6 at your DNS provider, then add the domain again."
		scene(
			{ update: pageUpdate, view },
			given(loaded(BASIC)),
			type(role("textbox", { name: "Hostname" }), "status.acme.com"),
			submit(role("form", { name: "Custom domain" })),
			Command.resolve(
				SetCustomDomain,
				Message.CompletedSetCustomDomain({
					result: Result.fail({
						...toLoadFailure(new Error(message)),
						message,
						retryable: false,
					}),
				}),
			),
			expectView(text(message)).toExist(),
			expectView(role("textbox", { name: "Hostname" })).toHaveAttr("aria-invalid", "true"),
		)
	})

	test("an apex, an IP or a Maple hostname is refused before it is sent", () => {
		for (const hostname of ["acme.com", "10.0.0.1", "status.maple.dev"])
			scene(
				{ update: pageUpdate, view },
				given(loaded(BASIC)),
				type(role("textbox", { name: "Hostname" }), hostname),
				expectView(role("button", { name: "Add domain" })).toBeDisabled(),
				expectView(role("textbox", { name: "Hostname" })).toHaveAttr("aria-invalid", "true"),
			)
	})

	test("Check now asks Cloudflare again and an active domain becomes the page's address", () => {
		const checking = pageUpdate(
			loaded({ ...BASIC, customDomain: pendingDomain }),
			Message.ClickedCheckCustomDomain(),
		)
		expect(checking.commands).toMatchObject([
			{ name: CheckCustomDomain.name, args: { pageId: statusPage().id } },
		])
		const active = customDomain({
			hostname: "status.acme.com",
			status: "active",
			dns_records: [pendingDomain.dns_records[0]!],
		})
		const done = pageUpdate(
			checking.model,
			Message.CompletedCheckCustomDomain({ result: Result.succeed(active) }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(done),
			expectView(text("Active")).toExist(),
			expectView(role("link", { name: "https://status.acme.com" })).toHaveAttr(
				"href",
				"https://status.acme.com",
			),
		)
	})

	test("a failed domain says what went wrong", () => {
		scene(
			{ update: pageUpdate, view },
			given(
				loaded({
					...BASIC,
					customDomain: customDomain({
						hostname: "status.acme.com",
						status: "failed",
						last_error: "The hostname no longer points at Maple. Check its CNAME record.",
					}),
				}),
			),
			expectView(text("Needs attention")).toExist(),
			expectView(text("The hostname no longer points at Maple. Check its CNAME record.")).toExist(),
		)
	})

	test("removing the domain asks first, then removes it once", () => {
		const asking = pageUpdate(
			loaded({ ...BASIC, customDomain: pendingDomain }),
			Message.ClickedRemoveCustomDomain(),
		)
		expect(asking.model.removeCustomDomainDialog.isOpen).toBe(true)
		expect(names(asking.commands)).not.toContain(RemoveCustomDomain.name)
		const removing = pageUpdate(asking.model, Message.ClickedConfirmRemoveCustomDomain())
		expect(removing.commands).toMatchObject([
			{ name: RemoveCustomDomain.name, args: { pageId: statusPage().id } },
		])
		// A second confirm while the first is in flight sends nothing.
		expect(pageUpdate(removing.model, Message.ClickedConfirmRemoveCustomDomain()).commands ?? []).toEqual(
			[],
		)
		// An earlier refused hostname is not shown against the now-empty field.
		const refused = pageUpdate(
			{ ...removing.model, customDomainAction: "set" },
			Message.CompletedSetCustomDomain({ result: Result.fail(toLoadFailure(new Error("taken"))) }),
		).model
		const removed = pageUpdate(
			{ ...refused, customDomainAction: "remove" },
			Message.CompletedRemoveCustomDomain({ result: Result.succeed(customDomain()) }),
		)
		expect(removed.model.customDomainFailure).toBeNull()
		expect(removed.model.removeCustomDomainDialog.isOpen).toBe(false)
		expect(removed.outMessage).toEqual(
			PageOutMessage.RequestedToast({
				type: "success",
				title: "Custom domain removed",
				description: "",
			}),
		)
		expect(Option.getOrNull(customDomainOf(removed.model))?.hostname).toBeNull()
	})

	test("an internal page takes no custom domain, and has no break-glass token to issue", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded({ ...BASIC, page: statusPage({ visibility: "internal" }) })),
			expectView(role("textbox", { name: "Hostname" })).toBeDisabled(),
			expectView(role("button", { name: "Add domain" })).toBeDisabled(),
			expectView(
				text("An internal page has no public address. Make it public or password-protected first."),
			).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(loaded({ ...ADVANCED, page: statusPage({ visibility: "internal" }) })),
			expectView(role("region", { name: "Break-glass token" })).not.toExist(),
			expectView(role("button", { name: "Issue token" })).not.toExist(),
		)
	})

	test("members see the domain and its records with its controls locked", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded({ ...BASIC, grants: MEMBER, customDomain: pendingDomain })),
			expectView(text("_cf-custom-hostname.status.acme.com")).toExist(),
			expectView(role("textbox", { name: "Hostname" })).toBeDisabled(),
			expectView(role("button", { name: "Check now" })).toBeDisabled(),
			expectView(role("button", { name: "Remove" })).toBeDisabled(),
		)
	})

	test("a deployment without custom domains says so instead of the form", () => {
		scene(
			{ update: pageUpdate, view },
			given(
				loaded({
					...BASIC,
					customDomain: customDomain({ available: false, cname_target: null }),
				}),
			),
			expectView(text("Custom domains are unavailable on this Maple deployment.")).toExist(),
			expectView(role("textbox", { name: "Hostname" })).not.toExist(),
		)
	})
})

describe("the JSON editor under Advanced", () => {
	const publicComponentId = (n: number) => Schema.encodeSync(StatusPageComponentPublicId)(componentId(n))
	/** The document the tab shows, as the user would edit it. */
	const documentOf = (components: ReadonlyArray<number>) => ({
		name: "Acme Status",
		slug: "acme-status",
		components: Arr.map(components, (n) => ({ id: publicComponentId(n), name: `Component ${n}` })),
	})
	const editing = (draft: string, fixture: Fixture = {}) =>
		Arr.reduce(
			[Message.ClickedEditJson(), Message.ChangedJson({ value: draft })],
			loaded({ ...ADVANCED, ...fixture }),
			(model, message) => pageUpdate(model, message).model,
		)

	test("shows the page as its config document, with public ids", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(ADVANCED)),
			expectView(role("link", { name: "Live page" })).toHaveAttr("href", `/status-pages/${PUBLIC_ID}`),
			expectView(role("link", { name: "Advanced" })).toHaveAttr("aria-current", "page"),
			expectView(selector("pre")).toContainText('"slug": "acme-status"'),
			expectView(selector("pre")).toContainText(`"id": "${publicComponentId(2)}"`),
			expectView(selector("pre")).toContainText('"auto_incidents": "draft"'),
			expectView(role("button", { name: "Copy config JSON" })).toExist(),
			expectView(text("GET /v2/status_pages/{id}/config")).toExist(),
		)
	})

	test("members read the document but cannot edit it", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded({ ...ADVANCED, grants: MEMBER })),
			expectView(selector("pre")).toContainText('"name": "Acme Status"'),
			expectView(role("button", { name: "Edit JSON" })).toBeDisabled(),
			expectView(role("textbox", { name: "Config JSON" })).not.toExist(),
		)
		const tried = pageUpdate(loaded({ ...ADVANCED, grants: MEMBER }), Message.ClickedEditJson())
		expect(tried.model.jsonEdit).toBeNull()
	})

	test("Edit fills the editor with the current document, and Reset brings it back", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(ADVANCED)),
			click(role("button", { name: "Edit JSON" })),
			expectView(role("textbox", { name: "Config JSON" })).toExist(),
			expectView(text("No changes yet")).toExist(),
			expectView(role("button", { name: "Apply" })).toBeDisabled(),
			type(role("textbox", { name: "Config JSON" }), "{}"),
			expectView(text("Not a valid page config")).toExist(),
			click(role("button", { name: "Reset" })),
			expectView(text("No changes yet")).toExist(),
		)
	})

	test("invalid JSON shows where it breaks and disables Apply", () => {
		scene(
			{ update: pageUpdate, view },
			given(editing('{\n  "name": "Acme",\n  "slug" "acme"\n}')),
			expectView(text("Invalid JSON")).toExist(),
			expectView(text("Line 3, column 10: Expected ':' after the property name")).toExist(),
			expectView(role("button", { name: "Apply" })).toBeDisabled(),
		)
	})

	test("a schema error names the path of the bad field", () => {
		const draft = JSON.stringify({ ...documentOf([1]), components: [{ name: "" }] })
		scene(
			{ update: pageUpdate, view },
			given(editing(draft)),
			expectView(text("Not a valid page config")).toExist(),
			expectView(text(/^components\[0\]\.name: /u)).toExist(),
			expectView(role("button", { name: "Apply" })).toBeDisabled(),
		)
	})

	test("an id from elsewhere is refused before the write", () => {
		const draft = JSON.stringify({
			...documentOf([1]),
			components: [{ id: publicComponentId(9), name: "X" }],
		})
		scene(
			{ update: pageUpdate, view },
			given(editing(draft)),
			expectView(
				text(
					`components[0].id: ${publicComponentId(9)} is not a component of this page. Remove the id to add a new one.`,
				),
			).toExist(),
			expectView(role("button", { name: "Apply" })).toBeDisabled(),
		)
	})

	test("the summary lists a created and a deleted component", () => {
		const draft = JSON.stringify({
			...documentOf([1, 2]),
			components: [...documentOf([1, 2]).components, { name: "Status API" }],
		})
		scene(
			{ update: pageUpdate, view },
			given(editing(draft)),
			expectView(text("Components to create")).toExist(),
			expectView(text("Status API")).toExist(),
			expectView(text("Components to delete")).toExist(),
			expectView(text("Component 3")).toExist(),
			expectView(text("Fields changed")).toExist(),
			expectView(role("button", { name: "Apply" })).toBeEnabled(),
		)
	})

	test("Apply sends one PUT with the decoded config, then re-reads the page and components", () => {
		const draft = JSON.stringify({ ...documentOf([2, 1]), components: documentOf([2, 1]).components })
		const model = editing(draft)
		const applying = pageUpdate(model, Message.ClickedApplyJson())
		expect(applying.commands).toMatchObject([
			{
				name: "ApplyStatusPageConfig",
				args: {
					pageId: statusPage().id,
					config: {
						name: "Acme Status",
						slug: "acme-status",
						components: [
							{ id: componentId(2), name: "Component 2" },
							{ id: componentId(1), name: "Component 1" },
						],
					},
				},
			},
		])
		expect(applying.commands).toHaveLength(1)
		expect(pageUpdate(applying.model, Message.ClickedApplyJson()).commands ?? []).toEqual([])

		const applied = pageUpdate(
			applying.model,
			Message.CompletedApplyJson({
				result: Result.succeed({ name: "Acme Status", slug: "acme-status", components: [] }),
			}),
		)
		expect(applied.model.jsonEdit).toBeNull()
		expect(names(applied.commands)).toContain("FetchStatusPage")
		expect(names(applied.commands)).toContain("FetchStatusPageComponents")
	})

	test("a refused apply shows the server's reason inline and keeps the draft", () => {
		const reason = "Text needs a contrast of 4.5:1"
		const model = editing(JSON.stringify(documentOf([1])))
		const applying = pageUpdate(model, Message.ClickedApplyJson()).model
		const refused = pageUpdate(
			applying,
			Message.CompletedApplyJson({
				result: Result.fail({
					...toLoadFailure(new Error(reason)),
					message: reason,
					retryable: false,
				}),
			}),
		).model
		expect(refused.jsonEdit?.draft).toBe(model.jsonEdit?.draft)
		scene(
			{ update: pageUpdate, view },
			given(refused),
			expectView(text("Couldn't apply the config")).toExist(),
			expectView(text(reason)).toExist(),
		)
	})

	test("the document comes from the config read, so components past the list's first page stay", () => {
		const entered = init(
			{ _tag: "StatusPage", pageId: PUBLIC_ID, search: { view: "settings", section: "advanced" } },
			context,
		)
		expect(names(entered.commands)).toContain("FetchStatusPageConfig")
		const listed = [component(1), component(2)]
		const config = statusPageConfig(statusPage(), [...listed, component(3), component(4)])
		const model = loaded({ ...ADVANCED, components: listed, config })
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(selector("pre")).toContainText(`"id": "${publicComponentId(4)}"`),
			click(role("button", { name: "Edit JSON" })),
			expectView(text("No changes yet")).toExist(),
			expectView(role("button", { name: "Apply" })).toBeDisabled(),
		)
		const dropped = JSON.stringify({ ...documentOf([1, 2, 3]) })
		const editingConfig = Arr.reduce(
			[Message.ClickedEditJson(), Message.ChangedJson({ value: dropped })],
			model,
			(current, message) => pageUpdate(current, message).model,
		)
		scene(
			{ update: pageUpdate, view },
			given(editingConfig),
			expectView(text("Components to delete")).toExist(),
			expectView(text("Component 4")).toExist(),
		)
	})

	test("the tab shows the config read's loading and failure states", () => {
		const entered = init(
			{ _tag: "StatusPage", pageId: PUBLIC_ID, search: { view: "settings", section: "advanced" } },
			context,
		).model
		const pageIn = pageUpdate(
			entered,
			Message.CompletedFetchPage({ key: entered.page.key ?? "", result: Result.succeed(statusPage()) }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(pageIn),
			expectView(selector("pre")).not.toExist(),
			expectView(role("button", { name: "Edit JSON" })).not.toExist(),
		)
		const failed = loaded({ ...ADVANCED, configFail: true })
		scene(
			{ update: pageUpdate, view },
			given(failed),
			expectView(text("Couldn't load the config")).toExist(),
		)
		expect(names(pageUpdate(failed, Message.ClickedRetry()).commands)).toContain("FetchStatusPageConfig")
	})

	test("opening Advanced re-reads the config, since other sections write the page too", () => {
		const onSettings = loaded({ tab: "settings" })
		expect(onSettings.config.key).toBeNull()
		const opened = routeChanged(
			onSettings,
			{ _tag: "StatusPage", pageId: PUBLIC_ID, search: { view: "settings", section: "advanced" } },
			context,
		)
		expect(names(opened.commands)).toContain("FetchStatusPageConfig")
	})

	test("Apply sends the version the document was read with", () => {
		const model = editing(JSON.stringify({ ...documentOf([1, 2]) }), {
			config: {
				...statusPageConfig(statusPage(), [component(1), component(2), component(3)]),
				version: "v7",
			},
		})
		expect(pageUpdate(model, Message.ClickedApplyJson()).commands).toMatchObject([
			{ name: "ApplyStatusPageConfig", args: { ifVersion: "v7" } },
		])
	})

	test("a newer config read while editing does not replace the version the draft was opened from", () => {
		const base = {
			...statusPageConfig(statusPage(), [component(1), component(2), component(3)]),
			version: "v7",
		}
		const draft = editing(JSON.stringify({ ...documentOf([1, 2]) }), { config: base })
		// Someone else's edit lands and the tab re-reads it, mid-edit.
		const reread = pageUpdate(
			draft,
			Message.CompletedFetchConfig({
				key: draft.config.key ?? "",
				result: Result.succeed({ ...base, version: "v8" }),
			}),
		).model
		expect(pageUpdate(reread, Message.ClickedApplyJson()).commands).toMatchObject([
			{ name: "ApplyStatusPageConfig", args: { ifVersion: "v7" } },
		])
	})

	test("a draft that differs only by spacing or colour case is no change", () => {
		const theme = { ...DEFAULT_STATUS_PAGE_THEME, appearance: "light" as const, accent: "#1a2b3c" }
		const page = statusPage({ description: "Live status.", theme })
		const draft = JSON.stringify({
			...documentOf([1, 2, 3]),
			name: " Acme Status ",
			description: " Live status. ",
			auto_incidents: "draft",
			theme: { ...theme, accent: "#1A2B3C" },
			components: Arr.map(documentOf([1, 2, 3]).components, (c) => ({
				...c,
				name: ` ${c.name}`,
				group: " ",
			})),
		})
		scene(
			{ update: pageUpdate, view },
			given(editing(draft, { page })),
			expectView(text("No changes yet")).toExist(),
			expectView(role("button", { name: "Apply" })).toBeDisabled(),
		)
	})

	test("while an apply runs, typing is ignored, the editor is disabled, and Settings cannot save", () => {
		const draft = JSON.stringify(documentOf([1]))
		const applying = pageUpdate(editing(draft), Message.ClickedApplyJson()).model
		expect(applying.isApplyingJson).toBe(true)
		expect(pageUpdate(applying, Message.ChangedJson({ value: "{}" })).model.jsonEdit?.draft).toBe(draft)
		scene(
			{ update: pageUpdate, view },
			given(applying),
			expectView(role("textbox", { name: "Config JSON" })).toBeDisabled(),
		)
		const edited = pageUpdate(
			applying,
			Message.ChangedSetting({ field: "name", value: "Typed meanwhile" }),
		).model
		expect(pageUpdate(edited, Message.ClickedSaveSettings()).commands ?? []).toEqual([])
	})

	test("a successful apply keeps Settings edits typed meanwhile and re-reads incidents and the config", () => {
		const draft = JSON.stringify(documentOf([1]))
		const applying = pageUpdate(editing(draft), Message.ClickedApplyJson()).model
		const typed = pageUpdate(
			applying,
			Message.ChangedSetting({ field: "name", value: "Typed meanwhile" }),
		).model
		const applied = (model: Model) =>
			pageUpdate(
				model,
				Message.CompletedApplyJson({
					result: Result.succeed({ ...documentOf([1]), components: [], version: "v8" }),
				}),
			)
		const kept = applied(typed)
		expect(kept.model.settingsEdits?.name).toBe("Typed meanwhile")
		expect(names(kept.commands)).toEqual(
			expect.arrayContaining(["FetchStatusPageIncidents", "FetchStatusPageConfig"]),
		)
		expect(applied(applying).model.settingsEdits).toBeNull()
	})

	test("a conflict keeps the draft, says why and re-reads the config", () => {
		const reason = "The page's config changed since it was read."
		const applying = pageUpdate(
			editing(JSON.stringify(documentOf([1]))),
			Message.ClickedApplyJson(),
		).model
		const refused = pageUpdate(
			applying,
			Message.CompletedApplyJson({
				result: Result.fail({
					...toLoadFailure(new Error(reason)),
					code: "status_page_conflict",
					message: reason,
					retryable: false,
				}),
			}),
		)
		expect(refused.model.jsonEdit?.draft).toBe(applying.jsonEdit?.draft)
		expect(names(refused.commands)).toEqual(["FetchStatusPageConfig"])
		scene({ update: pageUpdate, view }, given(refused.model), expectView(text(reason)).toExist())
	})

	test("after a conflict the re-read becomes the draft's base, so the next Apply can go through", () => {
		const base = { ...statusPageConfig(statusPage(), [component(1), component(2)]), version: "v7" }
		const draftText = JSON.stringify(documentOf([1]))
		const applying = pageUpdate(editing(draftText, { config: base }), Message.ClickedApplyJson()).model
		const refused = pageUpdate(
			applying,
			Message.CompletedApplyJson({
				result: Result.fail({
					...toLoadFailure(new Error("changed")),
					code: "status_page_conflict",
					message: "changed",
					retryable: false,
				}),
			}),
		).model
		const reread = pageUpdate(
			refused,
			Message.CompletedFetchConfig({
				key: refused.config.key ?? "",
				result: Result.succeed({ ...base, version: "v8" }),
			}),
		).model
		expect(reread.jsonEdit?.draft).toBe(draftText)
		scene({ update: pageUpdate, view }, given(reread), expectView(text("changed")).not.toExist())
		expect(pageUpdate(reread, Message.ClickedApplyJson()).commands).toMatchObject([
			{ name: "ApplyStatusPageConfig", args: { ifVersion: "v8" } },
		])
	})

	test("cancelling after a conflict ends the rebase, so a later draft keeps its own base", () => {
		const base = { ...statusPageConfig(statusPage(), [component(1), component(2)]), version: "v7" }
		const applying = pageUpdate(
			editing(JSON.stringify(documentOf([1])), { config: base }),
			Message.ClickedApplyJson(),
		).model
		const refused = pageUpdate(
			applying,
			Message.CompletedApplyJson({
				result: Result.fail({
					...toLoadFailure(new Error("changed")),
					code: "status_page_conflict",
					message: "changed",
					retryable: false,
				}),
			}),
		).model
		// Cancel before the re-read lands, then start a fresh draft on v7.
		const reopened = Arr.reduce(
			[
				Message.ClickedCancelJson(),
				Message.ClickedEditJson(),
				Message.ChangedJson({ value: JSON.stringify(documentOf([1])) }),
			],
			refused,
			(model, message) => pageUpdate(model, message).model,
		)
		const reread = pageUpdate(
			reopened,
			Message.CompletedFetchConfig({
				key: reopened.config.key ?? "",
				result: Result.succeed({ ...base, version: "v8" }),
			}),
		).model
		expect(pageUpdate(reread, Message.ClickedApplyJson()).commands).toMatchObject([
			{ name: "ApplyStatusPageConfig", args: { ifVersion: "v7" } },
		])
	})

	test("a config read superseded by the conflict re-read does not rebase the draft", () => {
		const base = { ...statusPageConfig(statusPage(), [component(1), component(2)]), version: "v7" }
		const applying = pageUpdate(
			editing(JSON.stringify(documentOf([1])), { config: base }),
			Message.ClickedApplyJson(),
		).model
		const staleKey = applying.config.key ?? ""
		const refused = pageUpdate(
			applying,
			Message.CompletedApplyJson({
				result: Result.fail({
					...toLoadFailure(new Error("changed")),
					code: "status_page_conflict",
					message: "changed",
					retryable: false,
				}),
			}),
		).model
		// The older read lands after the conflict started a new one: it must not become the base.
		const stale = pageUpdate(
			refused,
			Message.CompletedFetchConfig({
				key: staleKey,
				result: Result.succeed({ ...base, version: "v6" }),
			}),
		).model
		const reread = pageUpdate(
			stale,
			Message.CompletedFetchConfig({
				key: refused.config.key ?? "",
				result: Result.succeed({ ...base, version: "v8" }),
			}),
		).model
		expect(pageUpdate(reread, Message.ClickedApplyJson()).commands).toMatchObject([
			{ name: "ApplyStatusPageConfig", args: { ifVersion: "v8" } },
		])
	})

	test("a failed re-read after a conflict leaves the rebase pending for the next good read", () => {
		const base = { ...statusPageConfig(statusPage(), [component(1), component(2)]), version: "v7" }
		const applying = pageUpdate(
			editing(JSON.stringify(documentOf([1])), { config: base }),
			Message.ClickedApplyJson(),
		).model
		const refused = pageUpdate(
			applying,
			Message.CompletedApplyJson({
				result: Result.fail({
					...toLoadFailure(new Error("changed")),
					code: "status_page_conflict",
					message: "changed",
					retryable: false,
				}),
			}),
		).model
		const failed = pageUpdate(
			refused,
			Message.CompletedFetchConfig({
				key: refused.config.key ?? "",
				result: Result.fail(toLoadFailure(new Error("unreachable"))),
			}),
		).model
		const retried = pageUpdate(failed, Message.ClickedRetry()).model
		const reread = pageUpdate(
			retried,
			Message.CompletedFetchConfig({
				key: retried.config.key ?? "",
				result: Result.succeed({ ...base, version: "v8" }),
			}),
		).model
		expect(pageUpdate(reread, Message.ClickedApplyJson()).commands).toMatchObject([
			{ name: "ApplyStatusPageConfig", args: { ifVersion: "v8" } },
		])
	})

	test("unsaved Settings edits block Apply until they are saved or discarded", () => {
		const draft = JSON.stringify(documentOf([1]))
		const dirty = pageUpdate(
			editing(draft),
			Message.ChangedSetting({ field: "name", value: "Edited elsewhere" }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(dirty),
			expectView(text("Unsaved settings")).toExist(),
			expectView(role("button", { name: "Apply" })).toBeDisabled(),
		)
		expect(pageUpdate(dirty, Message.ClickedApplyJson()).commands ?? []).toEqual([])
		const discarded = pageUpdate(dirty, Message.ClickedDiscardSettings()).model
		expect(names(pageUpdate(discarded, Message.ClickedApplyJson()).commands)).toContain(
			"ApplyStatusPageConfig",
		)
	})
})

describe("the sheet, the previews and the reads they wait on", () => {
	test("a closing sheet keeps showing its incident until it has animated out", () => {
		const open = pageUpdate(
			loaded({ tab: "incidents", incidents: [incident(1, { title: "Elevated errors" })] }),
			Message.ClickedIncident({ incidentId: incidentId(1) }),
		).model
		const closing = pageUpdate(
			open,
			Message.GotPanelSheetMessage({ message: Dialog.Message.ClickedClose() }),
		).model
		expect(closing.panel).toBeNull()
		expect(closing.sheetPanel).toEqual({ _tag: "Incident", incidentId: incidentId(1) })
	})

	test("a created incident shows in its sheet at once, before the re-read lands", () => {
		const created = pageUpdate(
			pageUpdate(loaded({ tab: "incidents" }), Message.ClickedNewIncident({ kind: "incident" })).model,
			Message.CompletedCreateIncident({
				result: Result.succeed(incident(2, { title: "Slow checkout" })),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(created),
			mounted,
			mounted,
			expectView(role("dialog", { name: "Slow checkout" })).toExist(),
		)
	})

	test("an incident missing from a failed read says so in its sheet, with a retry", () => {
		const open = pageUpdate(
			loaded({ tab: "incidents", incidents: [incident(1)] }),
			Message.ClickedIncident({ incidentId: incidentId(1) }),
		).model
		const failed = {
			...open,
			incidents: {
				...open.incidents,
				data: AsyncData.Failure({ error: toLoadFailure(new Error("down")) }),
			},
		}
		scene(
			{ update: pageUpdate, view },
			given(failed),
			mounted,
			expectView(text("Couldn't load the incident")).toExist(),
		)
		const reading = { ...open, incidents: { ...open.incidents, data: AsyncData.Loading() } }
		scene(
			{ update: pageUpdate, view },
			given(reading),
			mounted,
			expectView(text("Couldn't load the incident")).not.toExist(),
			inside(
				role("dialog", { name: "Incident" }),
				expectView(selector('[aria-busy="true"]')).toExist(),
			),
		)
	})

	test("the page preview waits for the statuses' reads, and says so when they fail", () => {
		const entered = init(
			{ _tag: "StatusPage", pageId: PUBLIC_ID, search: { view: "settings", section: "appearance" } },
			context,
		).model
		const withPage = pageUpdate(
			entered,
			Message.CompletedFetchPage({ key: entered.page.key ?? "", result: Result.succeed(statusPage()) }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(withPage),
			expectView(
				selector('maple-preview-frame[frame-title="Acme Status with these settings"]'),
			).not.toExist(),
			expectView(role("region", { name: "Page preview" })).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(loaded({ ...APPEARANCE, monitorsFail: true })),
			pickersMounted(1),
			expectView(
				selector('maple-preview-frame[frame-title="Acme Status with these settings"]'),
			).not.toExist(),
			expectView(text("No preview: the page's components didn't load.")).toExist(),
		)
	})

	test("opening a component after a JSON apply renamed an untouched one opens it without asking", () => {
		const opened = selected(1, { components: [component(1, { name: "API" }), component(2)] })
		const advanced = routeChanged(
			opened,
			{ _tag: "StatusPage", pageId: PUBLIC_ID, search: { view: "settings", section: "advanced" } },
			context,
		).model
		// The apply's re-read lands the rename made in the JSON.
		const renamed = pageUpdate(
			advanced,
			Message.CompletedFetchComponents({
				key: advanced.components.key ?? "",
				result: Result.succeed([component(1, { name: "Payments" }), component(2)]),
			}),
		).model
		const back = routeChanged(
			renamed,
			{ _tag: "StatusPage", pageId: PUBLIC_ID, search: { view: "settings", section: "monitors" } },
			context,
		).model
		const other = pageUpdate(back, Message.ClickedComponent({ componentId: componentId(2) })).model
		expect(other.discardComponentDialog.isOpen).toBe(false)
		expect(other.panel).toEqual({ _tag: "Component", componentId: componentId(2) })
	})

	test("Escape closes an expanded component row, but an open popup trigger or list keeps it", () => {
		const focused = (attributes: Readonly<Record<string, string>>, inList = false): Focused => ({
			getAttribute: (name) => attributes[name] ?? null,
			isInside: () => inList,
		})
		expect(popupOwnsEscape(focused({ "aria-expanded": "true" }))).toBe(false)
		expect(popupOwnsEscape(focused({ "aria-expanded": "true", "aria-haspopup": "listbox" }))).toBe(true)
		expect(popupOwnsEscape(focused({ "aria-expanded": "false", "aria-haspopup": "menu" }))).toBe(false)
		expect(popupOwnsEscape(focused({}, true))).toBe(true)
	})

	test("a deleted incident's closing sheet keeps showing it after the re-read drops it", () => {
		const deleting = steps(
			pageUpdate(
				loaded({ tab: "incidents", incidents: [incident(1)] }),
				Message.ClickedIncident({ incidentId: incidentId(1) }),
			).model,
			[
				Message.ClickedDeleteIncident({ incidentId: incidentId(1) }),
				Message.ClickedConfirmDeleteIncident(),
			],
		)
		const deleted = pageUpdate(
			deleting,
			Message.CompletedDeleteIncident({ result: Result.succeed(undefined) }),
		).model
		const reread = pageUpdate(
			deleted,
			Message.CompletedFetchIncidents({ key: deleted.incidents.key ?? "", result: Result.succeed([]) }),
		).model
		expect(reread.panel).toBeNull()
		expect(reread.sheetIncident?.id).toBe(incidentId(1))
	})

	test("completed maintenance lasts from its first In progress update to completion, else its window", () => {
		const done = incident(1, {
			kind: "maintenance",
			status: "completed",
			scheduled_start: "2026-10-01T02:00:00.000Z",
			scheduled_end: "2026-10-01T03:00:00.000Z",
			started_at: "2026-10-01T02:00:00.000Z",
			resolved_at: "2026-10-01T02:24:00.000Z",
			updates: Arr.map(incident(1).updates, (update) => ({
				...update,
				status: "in_progress" as const,
				created_at: "2026-10-01T02:05:00.000Z",
			})),
		})
		expect(maintenanceDurationMs(done)).toBe(19 * 60_000)
		expect(maintenanceDurationMs({ ...done, updates: [] })).toBe(60 * 60_000)
	})

	test("a failed custom domain read can be retried, and Who can view does not offer Internal until it is known", () => {
		const failed = {
			...loaded(BASIC),
			customDomain: {
				key: "custom-domain",
				data: AsyncData.Failure({ error: toLoadFailure(new Error("unreachable")) }),
			},
		}
		scene(
			{ update: pageUpdate, view },
			given(failed),
			expectView(text("Couldn't load the custom domain")).toExist(),
			expectView(role("button", { name: "Try again" })).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given({ ...failed, search: { view: "settings", section: "basic" } }),
			expectView(role("radio", { name: "Internal" })).toBeDisabled(),
			expectView(text("Couldn't check for a custom domain. Try again above.")).toExist(),
		)
	})
})
