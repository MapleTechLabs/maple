import { CreateOrganizationRequest } from "@maple/domain/http"
import { currentRegion, regionAppUrl } from "@maple/web/lib/region"
import { Cause, Effect, Option, Schema } from "effect"
import { Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { load } from "foldkit/navigation"
import { modifyFields } from "foldkit/struct"
import { MapleInternalApiClient } from "../platform/api-clients"
import { setActiveOrganization } from "../platform/clerk"
import type { Resources } from "../platform/resources"
import * as Dialog from "../ui/dialog"
import * as Menu from "../ui/menu"

/**
 * `ClerkOrgSwitcherMenu` (apps/web/src/components/dashboard/org-switcher-menu.tsx): the active
 * user's organizations, "Create Organization" (its `CreateOrganizationDialog`), and in the sidebar
 * the namespace submenu. One Submodel backs the sidebar switcher and the auth screens' buttons.
 */

export const Model = Schema.Struct({
	menu: Menu.Model,
	createDialog: Dialog.Model,
	name: Schema.String,
	isCreating: Schema.Boolean,
	errorMessage: Schema.NullOr(Schema.String),
})
export type Model = typeof Model.Type

export const init = (id: string): Model => ({
	menu: Menu.init(id),
	createDialog: Dialog.init(`${id}-create`, "dialog"),
	name: "",
	isCreating: false,
	errorMessage: null,
})

export const Message = defineMessageUnion({
	GotMenuMessage: { message: Menu.Message },
	GotCreateDialogMessage: { message: Dialog.Message },
	ChangedOrganizationName: { value: Schema.String },
	SubmittedCreateOrganization: {},
	SucceededCreateOrganization: { orgId: Schema.String },
	FailedCreateOrganization: { message: Schema.String },
	CompletedSwitchOrganization: {},
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
		return opened ? { ...menuStep, outMessage: OutMessage.OpenedNamespaces() } : menuStep
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
		SubmittedCreateOrganization: () =>
			model.isCreating || model.name.trim() === ""
				? { model }
				: {
						model: modifyFields(model, { isCreating: () => true, errorMessage: () => null }),
						commands: [CreateOrganization({ name: model.name })],
					},
		// Stays pending while the page reloads onto the new org.
		SucceededCreateOrganization: ({ orgId }) => ({
			model,
			commands: [SwitchOrganization({ orgId, targetUrl: null })],
		}),
		FailedCreateOrganization: ({ message: failure }) => ({
			model: modifyFields(model, { isCreating: () => false, errorMessage: () => failure }),
		}),
		CompletedSwitchOrganization: () => ({ model }),
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
	args: { name: Schema.String },
	messages: [Message.SucceededCreateOrganization, Message.FailedCreateOrganization],
	execute: ({ name }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			const result = yield* client.organizationCreation.create({
				payload: new CreateOrganizationRequest({ name: name.trim(), region: currentRegion }),
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
