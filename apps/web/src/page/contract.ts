import { DashboardWidgetSchema } from "@maple/domain/http"
import type { OrgId } from "@maple/domain"
import type { InfraSurfaceLiteral } from "@maple/domain/http"
import { Array, Option, Schema, Stream } from "effect"
import { Command, Submodel, Subscription, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import type { IntegrationFlags } from "../data/infra-surfaces"
import type { Resources } from "../platform/resources"
import type { AppRoute, RouteTag } from "../route"
import type { BreadcrumbEntry } from "../shell"
import { ToastType } from "../ui/toast"

/** The page contract: every routed page is a Submodel registered once in `registry.ts`. See s8-pages.md. */

// CONTEXT

/** Root-owned state every page reads; never copied into a page Model. */
export interface PageContext {
	readonly orgId: OrgId
	/** `useGlobalNamespace()`: the org-global namespace pin, applied to queries before keying. */
	readonly pinnedNamespace: string | null
	/** `useTimezonePreference().effectiveTimezone`. */
	readonly timeZone: string
	/** `useInfraSurfaces()` as the shell reads it; absent off the shell (a public page). */
	readonly infra?: ShellInfraSurfaces
}

/** The sidebar's last-hour presence probe (`null` until it answers) and the integration statuses. */
export interface ShellInfraSurfaces {
	readonly presence: ReadonlyArray<InfraSurfaceLiteral> | null
	/** The probe failed: `presence` stays `null` for good, so readers stop waiting on it. */
	readonly isPresenceFailed: boolean
	readonly integrations: IntegrationFlags
}

export interface PageViewInputs {
	readonly context: PageContext
	/** `useIsMobile()` (below `md`), for the few layouts that branch on it in JSX (`/chat`). */
	readonly isMobile?: boolean
	/** `useMediaQuery("max-sm")`, likewise (the analytics chart's narrow margin). */
	readonly isBelowSm?: boolean
	/** `useMediaQuery("max-lg")`, likewise (the templates panel becomes a sheet). */
	readonly isBelowLg?: boolean
}

/** What a page's Subscriptions see: its own Model plus the context. */
export interface PageSubscriptionInput<Model> {
	readonly model: Model
	readonly context: PageContext
}

/** A toast action the root runs itself, whichever page is open (`retryOrgCollections`). */
/**
 * A toast action the root runs itself, so it outlives the page that raised it: a reconnect, or
 * a dashboard's Undo (the user may have left the board inside the toast's 6 s).
 */
export const RootToastAction = Schema.Union([
	Schema.TaggedStruct("ReconnectOrgCollections", {}),
	Schema.TaggedStruct("RestoreDashboardWidgets", {
		orgId: Schema.String,
		dashboardId: Schema.String,
		widgets: Schema.Array(DashboardWidgetSchema),
	}),
])
export type RootToastAction = typeof RootToastAction.Type

/** Facts a page reports to the root; the root owns the URL. */
export const PageOutMessage = defineMessageUnion({
	/** `navigate({ search })` / `<Link>`: the root pushes (or replaces) the URL, which re-enters the route. */
	RequestedNavigation: {
		url: Schema.String,
		isReplace: Schema.Boolean,
		/** A toast raised with the navigation (`navigate(...)` then `toastManager.add(...)`). */
		toast: Schema.optionalKey(
			Schema.Struct({ type: ToastType, title: Schema.String, description: Schema.String }),
		),
		/** A second toast after the first (a Perses import's "Imported with N warnings"). */
		followUpToast: Schema.optionalKey(
			Schema.Struct({ type: ToastType, title: Schema.String, description: Schema.String }),
		),
		/** A confirmed checkout's URL cleanup: the root re-reads the app's customer too. */
		refreshesCustomer: Schema.optionalKey(Schema.Boolean),
	},
	/** The org-global namespace pin (the shell's org menu owns it): set, or cleared with `None`. */
	RequestedNamespacePin: { maybeNamespace: Schema.Option(Schema.String) },
	/** A page's own `SidebarTrigger` (`/chat` renders its header without the shell's top bar). */
	RequestedSidebarToggle: {},
	/**
	 * `useInfraSurfaces()` in the page: the sidebar's presence probe and integration statuses. The
	 * shell owns those reads; below `md` its sidebar is unmounted, so the page is what asks for them.
	 */
	RequestedInfraSurfaces: {},
	/** `retryOrgCollections` / `handleCollectionStuck`: recreate the org's synced collections. */
	RequestedReconnectOrgCollections: {},
	/** A billing change in a page: the root re-reads the app's customer (plan gate, quota banners). */
	RequestedCustomerRefresh: {
		toast: Schema.optionalKey(
			Schema.Struct({ type: ToastType, title: Schema.String, description: Schema.String }),
		),
	},
	/**
	 * `toastManager.add`: the root shows it. `action` is the page's own Message for the action
	 * button (`actionProps`); the root sends it back to the page that is open when it is clicked.
	 */
	RequestedToast: {
		type: ToastType,
		title: Schema.String,
		description: Schema.String,
		timeoutMs: Schema.optionalKey(Schema.NullOr(Schema.Number)),
		action: Schema.optionalKey(
			Schema.NullOr(Schema.Struct({ label: Schema.String, message: Schema.Unknown })),
		),
		/** An action button the root handles (`action` wins when both are set). */
		rootAction: Schema.optionalKey(Schema.Struct({ label: Schema.String, action: RootToastAction })),
	},
})
export type PageOutMessage = typeof PageOutMessage.Type

export type PageReturn<Model, Message> = Update.ReturnWithOutMessage<
	Model,
	Message,
	PageOutMessage,
	Resources
>

/** A `preload`: the named fetch Commands of a step the page would take anyway (its `init`, a window load). */
export const pickCommands = <Model, Message>(
	result: PageReturn<Model, Message>,
	names: ReadonlyArray<string>,
): ReadonlyArray<Command.Command<Message, never, Resources>> =>
	(result.commands ?? []).filter((command) => names.includes(command.name))

type RouteOf<Tags extends RouteTag> = Extract<AppRoute, { readonly _tag: Tags }>

// SPEC (what a page module provides)

export interface PageSpec<Tags extends RouteTag, Model, Message> {
	/** The routes this page renders. */
	readonly routes: ReadonlyArray<Tags>
	/** The instance survives a navigation while this stays equal (default: the route tag). */
	readonly key?: (route: RouteOf<Tags>) => string
	readonly init: (route: RouteOf<Tags>, context: PageContext) => PageReturn<Model, Message>
	/**
	 * The requests warmed on link intent: the same fetch Commands
	 * `init` goes on to send, keyed alike, so the root seeds them into the new instance (s8 "Preload").
	 */
	readonly preload?: (
		route: RouteOf<Tags>,
		context: PageContext,
		nowMs: number,
	) => ReadonlyArray<Command.Command<Message, never, Resources>>
	readonly update: (model: Model, message: Message, context: PageContext) => PageReturn<Model, Message>
	/** Same instance, new route: the search params changed (filters, window). */
	readonly routeChanged?: (
		model: Model,
		route: RouteOf<Tags>,
		context: PageContext,
	) => PageReturn<Model, Message>
	/**
	 * Makes a page revivable: coming back restores the instance it left, last data on screen. Resets
	 * what was in flight when it was parked and re-resolves its window the way entry does.
	 */
	readonly revive?: (model: Model, route: RouteOf<Tags>, context: PageContext) => PageReturn<Model, Message>
	/** The namespace pin or time zone changed (an org change builds a new instance). */
	readonly contextChanged?: (model: Model, context: PageContext) => PageReturn<Model, Message>
	readonly view: Submodel.View<Model, Message, PageViewInputs>
	readonly subscriptions?: Subscription.Subscriptions<PageSubscriptionInput<Model>, Message, Resources>
	/** `DashboardPage`'s `breadcrumbs`. */
	readonly breadcrumbs: (model: Model) => ReadonlyArray<BreadcrumbEntry>
	/** `DashboardPage`'s `topbarActions`: the page's own controls after the shell's top-bar buttons. */
	readonly topbarActions?: Submodel.View<Model, Message, PageViewInputs>
	/**
	 * `useBlocker`: while this holds, a link or Back that leaves the page asks first. The root
	 * keeps the page and hands it `blockedNavigation` with where the user was going.
	 */
	readonly isBlockingNavigation?: (model: Model) => boolean
	readonly blockedNavigation?: (model: Model, url: string, context: PageContext) => PageReturn<Model, Message>
}

// ERASED PAGE (what the registry and root consume)

/** Preload Commands' Messages are stamped for no instance: the root drops them (their answer is cached). */
export const PRELOAD_INSTANCE = -1

export interface PageSlotBase {
	readonly _tag: string
	readonly key: string
	readonly orgId: string
	/** Bumped by the root on every instance build: A -> B -> A is a second instance of A. */
	readonly instance: number
}
/** A page Message stamped with the instance (slot key, org and build number) it was produced for. */
export interface PageMessageBase {
	readonly _tag: string
	readonly key: string
	readonly orgId: string
	readonly instance: number
}
/** The root as page Subscriptions see it. */
export interface PageHost {
	readonly page: PageSlotBase | null
	readonly context: PageContext | null
}

export interface PageStep<Slot, Wrapped> {
	readonly slot: Slot
	readonly commands: ReadonlyArray<Command.Command<Wrapped, never, Resources>>
	readonly outMessage: Option.Option<PageOutMessage>
}

/**
 * The page lives in the root Model as `{ _tag: id, key, orgId, model }`, its Messages as
 * `{ _tag: id, key, orgId, message }`: an older instance's late Messages are dropped centrally.
 */
export const definePage = <
	const Id extends string,
	Tags extends RouteTag,
	ModelSchema extends Schema.Top,
	MessageSchema extends Schema.Top,
>(
	id: Id,
	schemas: { readonly Model: ModelSchema; readonly Message: MessageSchema },
	spec: PageSpec<Tags, ModelSchema["Type"], MessageSchema["Type"]>,
) => {
	type Model = ModelSchema["Type"]
	type Message = MessageSchema["Type"]
	const Slot = Schema.TaggedStruct(id, {
		key: Schema.String,
		orgId: Schema.String,
		instance: Schema.Number,
		model: schemas.Model,
	})
	const Wrapped = Schema.TaggedStruct(id, {
		key: Schema.String,
		orgId: Schema.String,
		instance: Schema.Number,
		message: schemas.Message,
	})
	type SlotType = {
		readonly _tag: Id
		readonly key: string
		readonly orgId: string
		readonly instance: number
		readonly model: Model
	}
	type WrappedType = {
		readonly _tag: Id
		readonly key: string
		readonly orgId: string
		readonly instance: number
		readonly message: Message
	}

	// Ids are unique across the registry, so a matching tag is this page's slot or Message.
	const isOwnSlot = (slot: PageSlotBase): slot is SlotType => slot._tag === id
	const isOwnMessage = (message: PageMessageBase): message is WrappedType => message._tag === id
	/** The Message was produced by this very instance, not an older one of the same page. */
	const isForInstance = (slot: PageSlotBase, message: PageMessageBase) =>
		message.key === slot.key && message.orgId === slot.orgId && message.instance === slot.instance
	const ownsRoute = (route: AppRoute): route is RouteOf<Tags> =>
		Array.some(spec.routes, (tag) => tag === route._tag)
	const wrapFor =
		(key: string, orgId: string, instance: number) =>
		(message: Message): WrappedType => ({ _tag: id, key, orgId, instance, message })
	const keyOf = (route: RouteOf<Tags>) => (spec.key ? spec.key(route) : route._tag)

	const isOwnPageMessage = Schema.is(schemas.Message)
	/** A toast's action is the page's own Message; it travels wrapped, like every page Message. */
	const wrapOut =
		(wrap: (message: Message) => WrappedType) =>
		(out: PageOutMessage): PageOutMessage =>
			out._tag === "RequestedToast" &&
			out.action !== null &&
			out.action !== undefined &&
			isOwnPageMessage(out.action.message)
				? { ...out, action: { ...out.action, message: wrap(out.action.message) } }
				: out

	const step = (
		key: string,
		instance: number,
		context: PageContext,
		result: PageReturn<Model, Message>,
	): PageStep<SlotType, WrappedType> => {
		const wrap = wrapFor(key, context.orgId, instance)
		return {
			slot: { _tag: id, key, orgId: context.orgId, instance, model: result.model },
			commands: Command.mapMessages(result.commands ?? [], wrap),
			outMessage: Option.map(Option.fromNullishOr(result.outMessage), wrapOut(wrap)),
		}
	}

	/**
	 * Each Subscription restarts per instance and stamps its Messages with that instance's key and
	 * org, so a Message queued by an older instance's stream is dropped like a late Command result.
	 */
	const stamped = Subscription.make<PageHost, WrappedType, Resources>()((entry) =>
		Object.fromEntries(
			Object.entries(spec.subscriptions ?? {}).map(([name, inner]) => [
				name,
				entry(
					{
						maybeInstance: Schema.Option(
							Schema.Struct({
								key: Schema.String,
								orgId: Schema.String,
								instance: Schema.Number,
								inner: inner.dependenciesSchema,
							}),
						),
					},
					{
						modelToDependencies: (host) => ({
							maybeInstance:
								host.page !== null && host.context !== null && isOwnSlot(host.page)
									? Option.some({
											key: host.page.key,
											orgId: host.page.orgId,
											instance: host.page.instance,
											inner: inner.modelToDependencies({
												model: host.page.model,
												context: host.context,
											}),
										})
									: Option.none(),
						}),
						dependenciesToStream: ({ maybeInstance }) =>
							Option.match(maybeInstance, {
								onNone: () => Stream.empty,
								onSome: ({ key, orgId, instance, inner: dependencies }) =>
									Stream.map(
										inner.dependenciesToStream(dependencies, () => dependencies),
										wrapFor(key, orgId, instance),
									),
							}),
					},
				),
			]),
		),
	)

	return {
		id,
		Slot,
		Wrapped,
		keyOf: (route: AppRoute): Option.Option<string> =>
			ownsRoute(route) ? Option.some(keyOf(route)) : Option.none(),
		init: (route: AppRoute, context: PageContext, instance: number) =>
			ownsRoute(route)
				? Option.some(step(keyOf(route), instance, context, spec.init(route, context)))
				: Option.none<PageStep<SlotType, WrappedType>>(),
		/** The route's preload Commands, wrapped; `None` when the page has none or does not own the route. */
		preload: (route: AppRoute, context: PageContext, nowMs: number) =>
			ownsRoute(route) && spec.preload
				? Option.some(
						Command.mapMessages(
							spec.preload(route, context, nowMs),
							wrapFor(keyOf(route), context.orgId, PRELOAD_INSTANCE),
						),
					)
				: Option.none<ReadonlyArray<Command.Command<WrappedType, never, Resources>>>(),
		update: (slot: PageSlotBase, message: PageMessageBase, context: PageContext) =>
			isOwnSlot(slot) && isOwnMessage(message) && isForInstance(slot, message)
				? Option.some(step(slot.key, slot.instance, context, spec.update(slot.model, message.message, context)))
				: Option.none<PageStep<SlotType, WrappedType>>(),
		routeChanged: (slot: PageSlotBase, route: AppRoute, context: PageContext) =>
			isOwnSlot(slot) && ownsRoute(route) && spec.routeChanged
				? Option.some(step(slot.key, slot.instance, context, spec.routeChanged(slot.model, route, context)))
				: Option.none<PageStep<SlotType, WrappedType>>(),
		isRevivable: spec.revive !== undefined,
		/** A parked instance of this route's page, back as `instance`; `None` if it cannot be. */
		revive: (slot: PageSlotBase, route: AppRoute, context: PageContext, instance: number) => {
			const revive = spec.revive
			if (!isOwnSlot(slot) || !ownsRoute(route) || revive === undefined)
				return Option.none<PageStep<SlotType, WrappedType>>()
			if (slot.key !== keyOf(route) || slot.orgId !== context.orgId)
				return Option.none<PageStep<SlotType, WrappedType>>()
			return Option.some(step(slot.key, instance, context, revive(slot.model, route, context)))
		},
		/** A navigation away from this instance, held: the page's confirm step, or `None` if it allows it. */
		blockedNavigation: (slot: PageSlotBase, url: string, context: PageContext) =>
			isOwnSlot(slot) &&
			spec.isBlockingNavigation !== undefined &&
			spec.blockedNavigation !== undefined &&
			spec.isBlockingNavigation(slot.model)
				? Option.some(step(slot.key, slot.instance, context, spec.blockedNavigation(slot.model, url, context)))
				: Option.none<PageStep<SlotType, WrappedType>>(),
		contextChanged: (slot: PageSlotBase, context: PageContext) =>
			isOwnSlot(slot) && spec.contextChanged
				? Option.some(step(slot.key, slot.instance, context, spec.contextChanged(slot.model, context)))
				: Option.none<PageStep<SlotType, WrappedType>>(),
		breadcrumbs: (slot: PageSlotBase): ReadonlyArray<BreadcrumbEntry> =>
			isOwnSlot(slot) ? spec.breadcrumbs(slot.model) : [],
		/** The root embeds this; it renders the page's own view under its own boundary. */
		hostView: Submodel.defineView<PageSlotBase, WrappedType, PageViewInputs>((slot, inputs, h) =>
			isOwnSlot(slot)
				? h.submodel({
						slotId: id,
						model: slot.model,
						view: spec.view,
						viewInputs: {
							context: inputs.context,
							isMobile: inputs.isMobile ?? false,
							isBelowSm: inputs.isBelowSm ?? false,
							isBelowLg: inputs.isBelowLg ?? false,
						},
						toParentMessage: wrapFor(slot.key, slot.orgId, slot.instance),
					})
				: null,
		),
		/** The page's top-bar actions, embedded by the shell's top bar; nothing for most pages. */
		hostTopbarActions: Submodel.defineView<PageSlotBase, WrappedType, PageViewInputs>(
			(slot, inputs, h) => {
				const actions = spec.topbarActions
				return isOwnSlot(slot) && actions !== undefined
					? h.submodel({
							slotId: `${id}:topbar`,
							model: slot.model,
							view: actions,
							viewInputs: {
								context: inputs.context,
								isMobile: inputs.isMobile ?? false,
								isBelowSm: inputs.isBelowSm ?? false,
								isBelowLg: inputs.isBelowLg ?? false,
							},
							toParentMessage: wrapFor(slot.key, slot.orgId, slot.instance),
						})
					: null
			},
		),
		/** Keys are prefixed with the page id: Subscription keys share one namespace. */
		subscriptions: Object.fromEntries(
			Object.entries(stamped).map(([key, entry]) => [`${id}.${key}`, entry]),
		),
	}
}
