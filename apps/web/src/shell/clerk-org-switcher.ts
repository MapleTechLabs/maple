import { CreateOrganizationRequest } from "@maple/domain/http"
import { MapleRegion, parseMapleRegion } from "@maple/domain/organization-regions"
import { currentRegion, regionAppUrl } from "../lib/region"
import { Cause, Effect, Option, Queue, Schema, Stream } from "effect"
import { Command, Mount, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { load } from "foldkit/navigation"
import { modifyFields } from "foldkit/struct"
import { MapleInternalApiClient } from "../platform/api-clients"
import { setActiveOrganization } from "../platform/clerk"
import type { Resources } from "../platform/resources"
import * as Dialog from "../ui/dialog"
import * as Menu from "../ui/menu"
import * as RadioGroup from "../ui/radio-group"
import { containSearchKeys } from "./namespace-search"

/**
 * The Clerk org switcher menu: the active
 * user's organizations, "Create Organization" (its `CreateOrganizationDialog`), and in the sidebar
 * the namespace submenu. One Submodel backs the sidebar switcher and the auth screens' buttons.
 */

export const Model = Schema.Struct({
	menu: Menu.Model,
	createDialog: Dialog.Model,
	name: Schema.String,
	/** The data region the new org lives in (only offered with several regions). */
	region: MapleRegion,
	isCreating: Schema.Boolean,
	errorMessage: Schema.NullOr(Schema.String),
	/** The namespace submenu's search query; each opening starts blank. */
	namespaceQuery: Schema.String,
})
export type Model = typeof Model.Type

export const init = (id: string): Model => ({
	menu: Menu.init(id),
	createDialog: Dialog.init(`${id}-create`, "dialog"),
	name: "",
	region: currentRegion,
	isCreating: false,
	errorMessage: null,
	namespaceQuery: "",
})

export const Message = defineMessageUnion({
	GotMenuMessage: { message: Menu.Message },
	GotCreateDialogMessage: { message: Dialog.Message },
	ChangedOrganizationName: { value: Schema.String },
	GotRegionMessage: { message: RadioGroup.Message },
	SubmittedCreateOrganization: {},
	SucceededCreateOrganization: { orgId: Schema.String },
	FailedCreateOrganization: { message: Schema.String },
	CompletedSwitchOrganization: {},
	ChangedNamespaceQuery: { value: Schema.String },
	CompletedMountNamespaceSearch: {},
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

// UPDATE

export type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage, Resources>

const toMenu = (message: Menu.Message) => Message.GotMenuMessage({ message })
const toCreateDialog = (message: Dialog.Message) => Message.GotCreateDialogMessage({ message })

/** `handleOpenChange(false)`: the form starts empty next time. */
const withDialog = (model: Model, step: ReturnType<typeof Dialog.update>): UpdateReturn => {
	const isClosed = step.outMessage !== undefined && step.outMessage._tag === "Closed"
	return {
		model: modifyFields(model, {
			createDialog: () => step.model,
			name: (name) => (isClosed ? "" : name),
			region: (region) => (isClosed ? currentRegion : region),
			errorMessage: (message) => (isClosed ? null : message),
		}),
		commands: Command.mapMessages(step.commands ?? [], toCreateDialog),
	}
}

const updateMenu = (model: Model, message: Menu.Message): UpdateReturn => {
	const next = Menu.update(model.menu, message)
	const menuStep: UpdateReturn = {
		model: modifyFields(model, { menu: () => next.model }),
		commands: Command.mapMessages(next.commands ?? [], toMenu),
	}
	const out = next.outMessage
	if (out === undefined) {
		const opened = model.menu.submenu === null && next.model.submenu !== null
		return opened
			? {
					...menuStep,
					model: modifyFields(menuStep.model, { namespaceQuery: () => "" }),
					outMessage: OutMessage.OpenedNamespaces(),
				}
			: menuStep
	}
	return Menu.OutMessage.match<UpdateReturn>(out, {
		SelectedItem: ({ value }) => {
			if (value === CREATE_VALUE) {
				const opened = withDialog(menuStep.model, Dialog.open(model.createDialog))
				return { ...opened, commands: [...(menuStep.commands ?? []), ...(opened.commands ?? [])] }
			}
			return value.startsWith(ORG_PREFIX)
				? { ...menuStep, outMessage: OutMessage.SelectedOrganization({ orgId: value.slice(ORG_PREFIX.length) }) }
				: menuStep
		},
		SelectedSubmenuItem: ({ value }) => ({
			...menuStep,
			outMessage: OutMessage.SelectedNamespace({
				maybeNamespace:
					value === ALL_NAMESPACES ? Option.none() : Option.some(value.slice(NAMESPACE_PREFIX.length)),
			}),
		}),
		ToggledCheckbox: () => menuStep,
		SelectedRadio: () => menuStep,
	})
}

export const update = (model: Model, message: Message): UpdateReturn =>
	Message.match<UpdateReturn>(message, {
		GotMenuMessage: ({ message: child }) => updateMenu(model, child),
		GotCreateDialogMessage: ({ message: child }) =>
			model.isCreating ? { model } : withDialog(model, Dialog.update(model.createDialog, child)),
		ChangedOrganizationName: ({ value }) => ({ model: modifyFields(model, { name: () => value }) }),
		GotRegionMessage: ({ message: child }) => {
			if (model.isCreating) return { model }
			const next = RadioGroup.update(RadioGroup.init(model.region), child)
			return {
				model: modifyFields(model, {
					region: (region) => Option.match(next.model.maybeValue, { onNone: () => region, onSome: parseMapleRegion }),
				}),
				commands: Command.mapMessages(next.commands ?? [], (message) => Message.GotRegionMessage({ message })),
			}
		},
		SubmittedCreateOrganization: () =>
			model.isCreating || model.name.trim() === ""
				? { model }
				: {
						model: modifyFields(model, { isCreating: () => true, errorMessage: () => null }),
						commands: [CreateOrganization({ name: model.name, region: model.region })],
					},
		// Stays pending while the page reloads onto the new org.
		SucceededCreateOrganization: ({ orgId }) => ({
			model,
			commands: [SwitchOrganization({ orgId, targetUrl: createdTargetOf(model.region) })],
		}),
		FailedCreateOrganization: ({ message: failure }) => ({
			model: modifyFields(model, { isCreating: () => false, errorMessage: () => failure }),
		}),
		CompletedSwitchOrganization: () => ({ model }),
		ChangedNamespaceQuery: ({ value }) => ({ model: modifyFields(model, { namespaceQuery: () => value }) }),
		CompletedMountNamespaceSearch: () => ({ model }),
	})

/** The submenu's search input: focused as it mounts, its keys kept from the menu. */
export const MountNamespaceSearch = Mount.defineStream("MountSwitcherNamespaceSearch", {
	messages: [Message.CompletedMountNamespaceSearch],
	execute: ({ element }) =>
		Stream.callback<typeof Message.CompletedMountNamespaceSearch.Type>((queue) =>
			containSearchKeys(element).pipe(
				Effect.andThen(Effect.sync(() => Queue.offerUnsafe(queue, Message.CompletedMountNamespaceSearch()))),
				Effect.andThen(Effect.never),
			),
		),
})

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

/** `switchOrganization` / the create dialog's ending: `setActive`, then reload or the region's app. */
export const SwitchOrganization = Command.define("SwitchOrganization", {
	args: { orgId: Schema.String, targetUrl: Schema.NullOr(Schema.String) },
	messages: [Message.CompletedSwitchOrganization],
	execute: ({ orgId, targetUrl }) =>
		setActiveOrganization(orgId).pipe(
			Effect.andThen(landOn(targetUrl)),
			Effect.as(Message.CompletedSwitchOrganization()),
		),
})

/** `organizationCreation.create`: the org starts life with its region set. */
export const CreateOrganization = Command.define("CreateOrganization", {
	args: { name: Schema.String, region: MapleRegion },
	messages: [Message.SucceededCreateOrganization, Message.FailedCreateOrganization],
	execute: ({ name, region }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			const result = yield* client.organizationCreation.create({
				payload: new CreateOrganizationRequest({ name: name.trim(), region }),
			})
			return Message.SucceededCreateOrganization({ orgId: result.orgId })
		}).pipe(
			Effect.catchCause((cause) =>
				Effect.succeed(
					Message.FailedCreateOrganization({
						message: Option.match(Cause.findErrorOption(cause), {
							onNone: () => "Failed to create organization",
							onSome: (error) => error.message,
						}),
					}),
				),
			),
		),
})
