import { CreateOrganizationRequest } from "@maple/domain/http"
import { MapleRegion, parseMapleRegion } from "@maple/domain/organization-regions"
import { currentRegion, regionAppUrl } from "../lib/region"
import { Cause, Effect, Layer, Option, Queue, Schema, Stream } from "effect"
import { Block } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { load } from "foldkit/navigation"
import { modifyFields } from "foldkit/struct"
import { MapleInternalApiClient } from "../platform/api-clients"
import { activateOrganization, type ClerkActionError, setActiveOrganization } from "../platform/clerk"
import * as Dialog from "../ui/dialog"
import { DialogBlock } from "../ui/dialog-view"
import { MenuBlock } from "../ui/menu-view"
import * as RadioGroup from "../ui/radio-group"
import { containSearchKeys } from "./namespace-search"

/**
 * The Clerk org switcher menu: the active
 * user's organizations, "Create Organization" (its `CreateOrganizationDialog`), and in the sidebar
 * the namespace submenu. One Block backs the sidebar switcher and the auth screens' buttons.
 */

export const Model = Schema.Struct({
	menu: MenuBlock.Model,
	createDialog: DialogBlock.Model,
	/** The create dialog's "Data region" radio; the picked region lives in `region`. */
	regionRadio: RadioGroup.RadioGroupBlock.Model,
	name: Schema.String,
	/** The data region the new org lives in (only offered with several regions). */
	region: MapleRegion,
	isCreating: Schema.Boolean,
	errorMessage: Schema.NullOr(Schema.String),
	/** The namespace submenu's search query; each opening starts blank. */
	namespaceQuery: Schema.String,
})
export type Model = typeof Model.Type

const initialModel = (id: string): Model => ({
	menu: MenuBlock.init(id).model,
	createDialog: Dialog.initialModel(`${id}-create`, "dialog"),
	regionRadio: RadioGroup.RadioGroupBlock.init().model,
	name: "",
	region: currentRegion,
	isCreating: false,
	errorMessage: null,
	namespaceQuery: "",
})

export const Message = defineMessageUnion({
	ChangedOrganizationName: { value: Schema.String },
	SubmittedCreateOrganization: {},
	SucceededCreateOrganization: { orgId: Schema.String },
	FailedCreateOrganization: { message: Schema.String },
	CompletedSwitchOrganization: {},
	ChangedNamespaceQuery: { value: Schema.String },
	CompletedMountNamespaceSearch: {},
	/** The namespace submenu's popup appeared: its list is read and its search starts blank. */
	OpenedNamespaceSubmenu: {},
	/** Operation: switch to an org the parent picked (`setActive`, then reload or its region). */
	RequestedSwitchOrganization: { orgId: Schema.String, targetUrl: Schema.NullOr(Schema.String) },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
	SelectedOrganization: { orgId: Schema.String },
	SelectedNamespace: { maybeNamespace: Schema.Option(Schema.String) },
	/** The namespace submenu opened: its list is read then (`NamespaceScopeList` mounts). */
	OpenedNamespaces: {},
})
export type OutMessage = typeof OutMessage.Type

/** Entry values: an org, the create row, the namespace submenu and its rows. */
export const ORG_PREFIX = "org:"
export const CREATE_VALUE = "create"
export const NAMESPACE_SUBMENU = "namespace"
export const ALL_NAMESPACES = "*"
export const NAMESPACE_PREFIX = "ns:"

// COMMANDS

/** Where switching to an org lands: its own region's dashboard, else a reload of this one. */
export const switchTargetOf = (organization: {
	readonly homeRegion: "us" | "eu"
	readonly isRegionOpen: boolean
}): string | null =>
	organization.isRegionOpen || organization.homeRegion === currentRegion
		? null
		: (regionAppUrl(organization.homeRegion) ?? null)

/** The create dialog's ending: another region's dashboard for an org created there, else a reload. */
export const createdTargetOf = (
	region: MapleRegion,
	appUrlOf: (region: MapleRegion) => string | undefined = regionAppUrl,
): string | null => (region === currentRegion ? null : (appUrlOf(region) ?? null))

const landOn = (targetUrl: string | null): Effect.Effect<void> =>
	targetUrl === null ? Effect.sync(() => window.location.reload()) : load(`${targetUrl}/`)

/** `setActive`, then a reload of this dashboard or the region's own app. */
export const switchToOrganization = (orgId: string, targetUrl: string | null): Effect.Effect<void> =>
	setActiveOrganization(orgId).pipe(Effect.andThen(landOn(targetUrl)))

/** As `switchToOrganization`, but a refused `setActive` fails instead of reloading onto no org. */
export const openOrganization = (
	orgId: string,
	targetUrl: string | null,
): Effect.Effect<void, ClerkActionError> =>
	activateOrganization(orgId).pipe(Effect.andThen(landOn(targetUrl)))

export const ClerkOrgSwitcherDefinition = Block.makeDefinition("ClerkOrgSwitcher", {
	Model,
	Message,
	OutMessage,
})
const { makeNoopStep, makeFieldsStep, makeOutMessageStep } = ClerkOrgSwitcherDefinition

/** `switchOrganization` / the create dialog's ending: `setActive`, then reload or the region's app. */
export const SwitchOrganization = ClerkOrgSwitcherDefinition.makeCommand("SwitchOrganization", {
	args: { orgId: Schema.String, targetUrl: Schema.NullOr(Schema.String) },
	messages: [Message.CompletedSwitchOrganization],
	handler: function* () {
		return ({ orgId, targetUrl }) =>
			switchToOrganization(orgId, targetUrl).pipe(Effect.as(Message.CompletedSwitchOrganization()))
	},
})

export class OrganizationCreateError extends Schema.TaggedError<OrganizationCreateError>()(
	"@maple/web/OrganizationCreateError",
	{ message: Schema.String, cause: Schema.Defect() },
) {}

/** `organizationCreation.create`: the new org's id; it starts life with its region set. */
export const createOrganization = (
	name: string,
	region: MapleRegion,
): Effect.Effect<string, OrganizationCreateError, MapleInternalApiClient> =>
	Effect.gen(function* () {
		const client = yield* MapleInternalApiClient
		const result = yield* client.organizationCreation.create({
			payload: new CreateOrganizationRequest({ name: name.trim(), region }),
		})
		return result.orgId
	}).pipe(
		Effect.catchCause((cause) =>
			Effect.fail(
				new OrganizationCreateError({
					message: Option.match(Cause.findErrorOption(cause), {
						onNone: () => "Failed to create organization",
						onSome: (error) => error.message,
					}),
					cause,
				}),
			),
		),
	)

export const CreateOrganization = ClerkOrgSwitcherDefinition.makeCommand("CreateOrganization", {
	args: { name: Schema.String, region: MapleRegion },
	messages: [Message.SucceededCreateOrganization, Message.FailedCreateOrganization],
	handler: function* () {
		return ({ name, region }) =>
			createOrganization(name, region).pipe(
				Effect.map((orgId) => Message.SucceededCreateOrganization({ orgId })),
				Effect.catch((error) =>
					Effect.succeed(Message.FailedCreateOrganization({ message: error.message })),
				),
			)
	},
})

// MOUNTS

const signalOnMount = <A>(element: Element, message: A) =>
	Stream.callback<A>((queue) =>
		containSearchKeys(element).pipe(
			Effect.andThen(Effect.sync(() => Queue.offerUnsafe(queue, message))),
			Effect.andThen(Effect.never),
		),
	)

/** The submenu's search input: focused as it mounts, its keys kept from the menu. */
export const MountNamespaceSearch = ClerkOrgSwitcherDefinition.makeMountStream(
	"MountSwitcherNamespaceSearch",
	{
		messages: [Message.CompletedMountNamespaceSearch],
		handler: function* () {
			return ({ element }) => signalOnMount(element, Message.CompletedMountNamespaceSearch())
		},
	},
)

/** A hidden marker in the submenu's header: its insert is the submenu opening. */
export const MountNamespaceSubmenu = ClerkOrgSwitcherDefinition.makeMountStream(
	"MountSwitcherNamespaceSubmenu",
	{
		messages: [Message.OpenedNamespaceSubmenu],
		handler: function* () {
			return () =>
				Stream.callback<typeof Message.OpenedNamespaceSubmenu.Type>((queue) =>
					Effect.sync(() => Queue.offerUnsafe(queue, Message.OpenedNamespaceSubmenu())).pipe(
						Effect.andThen(Effect.never),
					),
				)
		},
	},
)

// COMPOSITION

/** The create dialog; its messages wait while the org is being created (it cannot close then). */
export const CreateDialogBinding = ClerkOrgSwitcherDefinition.makeBinding(DialogBlock, {
	field: "createDialog",
	init: false,
	delivery: { when: (model) => !model.isCreating },
}).withOutMessagePolicy({
	fold: ClerkOrgSwitcherDefinition.makeOutMessageFold(DialogBlock, {
		Opened: makeNoopStep,
		// `handleOpenChange(false)`: the form starts empty next time.
		Closed: () =>
			makeFieldsStep(() => ({
				name: () => "",
				region: () => currentRegion,
				errorMessage: () => null,
			})),
	}),
})

/** A pick in the menu: an org goes to the parent, the create row opens the dialog, a namespace pins. */
export const MenuBinding = ClerkOrgSwitcherDefinition.makeBinding(MenuBlock, {
	field: "menu",
	init: false,
}).withOutMessagePolicy({
	fold: ClerkOrgSwitcherDefinition.makeOutMessageFold(MenuBlock, {
		SelectedItem: ({ value }) =>
			value === CREATE_VALUE
				? CreateDialogBinding.requestOpen()
				: value.startsWith(ORG_PREFIX)
					? makeOutMessageStep(() =>
							OutMessage.SelectedOrganization({ orgId: value.slice(ORG_PREFIX.length) }),
						)
					: makeNoopStep(),
		SelectedSubmenuItem: ({ value }) =>
			makeOutMessageStep(() =>
				OutMessage.SelectedNamespace({
					maybeNamespace:
						value === ALL_NAMESPACES
							? Option.none()
							: Option.some(value.slice(NAMESPACE_PREFIX.length)),
				}),
			),
		ToggledCheckbox: makeNoopStep,
		SelectedRadio: makeNoopStep,
	}),
})

/** The region radio; a pick while the org is being created is dropped. */
export const RegionBinding = ClerkOrgSwitcherDefinition.makeBinding(RadioGroup.RadioGroupBlock, {
	field: "regionRadio",
	init: false,
	delivery: { when: (model) => !model.isCreating },
}).withOutMessagePolicy({
	fold: ClerkOrgSwitcherDefinition.makeOutMessageFold(RadioGroup.RadioGroupBlock, {
		Selected: ({ value }) => makeFieldsStep(() => ({ region: () => parseMapleRegion(value) })),
	}),
})

export const ClerkOrgSwitcherComposition = ClerkOrgSwitcherDefinition.makeComposition({
	bindings: [CreateDialogBinding, MenuBinding, RegionBinding],
	mounts: [MountNamespaceSearch, MountNamespaceSubmenu],
})
export type ClerkOrgSwitcherViewBuilder = Block.ViewBuilderFor<typeof ClerkOrgSwitcherComposition>

// UPDATE

export const init = ClerkOrgSwitcherComposition.makeInit((id: string) => ({ model: initialModel(id) }))

export const update = ClerkOrgSwitcherComposition.makeUpdate({
	ChangedOrganizationName: (model, { value }) => ({ model: modifyFields(model, { name: () => value }) }),
	SubmittedCreateOrganization: (model) =>
		model.isCreating || model.name.trim() === ""
			? { model }
			: {
					model: modifyFields(model, { isCreating: () => true, errorMessage: () => null }),
					commands: [CreateOrganization({ name: model.name, region: model.region })],
				},
	// Stays pending while the page reloads onto the new org.
	SucceededCreateOrganization: (model, { orgId }) => ({
		model,
		commands: [SwitchOrganization({ orgId, targetUrl: createdTargetOf(model.region) })],
	}),
	FailedCreateOrganization: (model, { message: failure }) => ({
		model: modifyFields(model, { isCreating: () => false, errorMessage: () => failure }),
	}),
	CompletedSwitchOrganization: (model) => ({ model }),
	ChangedNamespaceQuery: (model, { value }) => ({
		model: modifyFields(model, { namespaceQuery: () => value }),
	}),
	CompletedMountNamespaceSearch: (model) => ({ model }),
	OpenedNamespaceSubmenu: (model) => ({
		model: modifyFields(model, { namespaceQuery: () => "" }),
		outMessage: OutMessage.OpenedNamespaces(),
	}),
	RequestedSwitchOrganization: (model, { orgId, targetUrl }) => ({
		model,
		commands: [SwitchOrganization({ orgId, targetUrl })],
	}),
})

/** Parent-initiated: the root or a screen switches to an org it resolved. */
export const operations = { requestSwitchOrganization: Message.RequestedSwitchOrganization }

export const EffectsLayer = Layer.mergeAll(
	SwitchOrganization.layer,
	CreateOrganization.layer,
	MountNamespaceSearch.layer,
	MountNamespaceSubmenu.layer,
)
