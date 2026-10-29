import { Array, Equal, Option, Record, Struct } from "effect"
import { AsyncData } from "foldkit"
import { modifyFields } from "foldkit/struct"
import { integrationsAnswered, settledSurfaces } from "../data/infra-surfaces"
import { DismissQuotaBanner, OpenCustomerPortal } from "./billing-banners"
import {
	FocusElement,
	FocusShortcutSearch,
	FocusSiblingMenuItem,
	LogOut,
	OpenGlobalChat,
	ReleasePaletteServices,
	SaveInfraSurfaces,
	SaveNamespace,
	SaveSidebarState,
	SaveTheme,
} from "./command"
import type { Context as ConnectContext } from "./connect-panel"
import {
	LoadAwsStatus,
	LoadCloudflareStatus,
	LoadGcpStatus,
	LoadInfraPresence,
	LoadNamespaces,
	LoadPlanetscaleStatus,
	LoadRailwayStatus,
	LoadSupabaseStatus,
	LoadTenant,
} from "./data"
import { isSameMenu } from "./menus"
import { type Menu, OutMessage } from "./message"
import { DashboardsData, InfraPresenceData, type Model, NamespacesData, shellProbe } from "./model"
import type * as Palette from "./palette/update"
import { CheckDeployedCommit, ReloadPage } from "./version"

// The shell's own transitions: plain results over its Model, combined with its children's
// operations in `update.ts` and `composition.ts`.

/** Every Command the shell's own update returns. */
export type ShellCommand =
	| ReturnType<typeof FocusElement>
	| ReturnType<typeof FocusSiblingMenuItem>
	| ReturnType<typeof FocusShortcutSearch>
	| ReturnType<typeof LogOut>
	| ReturnType<typeof OpenGlobalChat>
	| ReturnType<typeof ReleasePaletteServices>
	| ReturnType<typeof SaveInfraSurfaces>
	| ReturnType<typeof SaveNamespace>
	| ReturnType<typeof SaveSidebarState>
	| ReturnType<typeof SaveTheme>
	| ReturnType<typeof LoadTenant>
	| ReturnType<typeof LoadInfraPresence>
	| ReturnType<typeof LoadCloudflareStatus>
	| ReturnType<typeof LoadPlanetscaleStatus>
	| ReturnType<typeof LoadRailwayStatus>
	| ReturnType<typeof LoadGcpStatus>
	| ReturnType<typeof LoadSupabaseStatus>
	| ReturnType<typeof LoadAwsStatus>
	| ReturnType<typeof LoadNamespaces>
	| ReturnType<typeof CheckDeployedCommit>
	| ReturnType<typeof ReloadPage>
	| ReturnType<typeof DismissQuotaBanner>
	| ReturnType<typeof OpenCustomerPortal>

/** A result without an ask to the root, so it can be combined with the children's operations. */
export type StepReturn = Readonly<{ model: Model; commands?: ReadonlyArray<ShellCommand> }>
export type UpdateReturn = StepReturn & Readonly<{ outMessage?: OutMessage }>

/**
 * `modifyFields` always builds a new object, so a message that changed no field (a version check
 * that found the same commit) would re-render the whole app. Hand back the old Model instead.
 */
export const stable = <Result extends UpdateReturn>(model: Model, result: Result): Result =>
	result.model !== model && Struct.keys(model).every((key) => model[key] === result.model[key])
		? { ...result, model }
		: result

export const closeMenu = (model: Model): Model => modifyFields(model, { openMenu: () => Option.none() })

export const openMenuOf = (model: Model): Option.Option<Menu> =>
	Option.map(model.openMenu, ({ menu }) => menu)

/**
 * What `AppSidebar` reads once it mounts: always on desktop, but below `md` only when its sheet
 * first opens (a closed sheet renders nothing). The live dashboards read follows the flag.
 */
export const requestSidebarData = (model: Model): StepReturn => {
	if (model.hasRequestedSidebarData || Option.isNone(model.maybeOrgId)) return { model }
	const surfaces = requestInfraSurfaces(model)
	return {
		model: modifyFields(surfaces.model, {
			hasRequestedSidebarData: () => true,
			dashboards: () => DashboardsData.Loading(),
		}),
		commands: surfaces.commands ?? [],
	}
}

/** `useInfraSurfaces`: the last hour's presence probe and the four integration statuses, once. */
export const requestInfraSurfaces = (model: Model): StepReturn =>
	Option.match(model.maybeOrgId, {
		onNone: () => ({ model }),
		onSome: (orgId) =>
			!AsyncData.isIdle(model.infraPresence)
				? { model }
				: {
						model: modifyFields(model, { infraPresence: () => InfraPresenceData.Loading() }),
						commands: [
							LoadInfraPresence({ orgId }),
							LoadCloudflareStatus({ orgId }),
							LoadPlanetscaleStatus({ orgId }),
							LoadRailwayStatus({ orgId }),
							LoadGcpStatus({ orgId }),
							LoadSupabaseStatus({ orgId }),
							LoadAwsStatus({ orgId }),
						],
					},
	})

/**
 * `NamespaceScopeList` mounts with each menu open and probes a fresh 24 h window (cached while the
 * snapped window holds). Listed names stay up while it reads; only a first read shows the spinner.
 */
export const readNamespaces = (model: Model): StepReturn =>
	Option.match(model.maybeOrgId, {
		onNone: () => ({ model }),
		onSome: (orgId) => ({
			model: AsyncData.isSuccess(model.namespaces)
				? model
				: modifyFields(model, { namespaces: () => NamespacesData.Loading() }),
			commands: [LoadNamespaces({ orgId })],
		}),
	})

/** An org-stamped answer applies only while the shell is still on that org. */
export const forOrg = (model: Model, orgId: string, apply: (model: Model) => Model): StepReturn => ({
	model: Option.contains(model.maybeOrgId, orgId) ? apply(model) : model,
})

/** Once the org's live surfaces are complete, remember them if they changed. */
const rememberSettled = (orgId: string, step: StepReturn): StepReturn => {
	const model = step.model
	const settled = settledSurfaces(shellProbe(model), model.integrations)
	const remembered = model.rememberedSurfaces[orgId]
	if (
		settled === null ||
		(remembered !== undefined && Array.makeEquivalence(Equal.equals)(remembered, settled))
	)
		return step
	return {
		model: modifyFields(model, { rememberedSurfaces: (all) => Record.set(all, orgId, settled) }),
		commands: [SaveInfraSurfaces({ orgId, surfaces: settled })],
	}
}

/** A probe or status answer for the org; the last status to answer tells the pages. */
export const surfacesAnswered = (
	model: Model,
	orgId: string,
	apply: (model: Model) => Model,
): UpdateReturn => {
	// A late answer for an org the shell has left must not file this org's set under it.
	if (!Option.contains(model.maybeOrgId, orgId)) return { model }
	const step = rememberSettled(orgId, { model: apply(model) })
	return !integrationsAnswered(model.integrations) && integrationsAnswered(step.model.integrations)
		? { ...step, outMessage: OutMessage.SettledInfraSurfaces() }
		: step
}

export const clickedMenuTrigger = (model: Model, menu: Menu): StepReturn => {
	if (Option.exists(openMenuOf(model), (open) => isSameMenu(open, menu))) return { model: closeMenu(model) }
	const opened = modifyFields(model, {
		openMenu: () => Option.some({ menu, maybePosition: Option.none() }),
		namespaceQuery: () => "",
	})
	return menu._tag === "Org" ? readNamespaces(opened) : { model: opened }
}

export const clickedNamespace = (model: Model, maybeNamespace: Option.Option<string>): UpdateReturn =>
	Option.match(model.maybeOrgId, {
		onNone: () => ({ model: closeMenu(model) }),
		onSome: (orgId) => ({
			model: modifyFields(closeMenu(model), {
				pinnedNamespaces: (pinned) =>
					Option.match(maybeNamespace, {
						onNone: () => Record.remove(pinned, orgId),
						onSome: (namespace) => Record.set(pinned, orgId, namespace),
					}),
			}),
			commands: [SaveNamespace({ orgId, maybeNamespace })],
			outMessage: OutMessage.ChangedGlobalNamespace({ maybeNamespace }),
		}),
	})

/** The signed-in org and its namespace pin, which the Connect panel's overview read applies. */
export const connectContextOf = (model: Model): ConnectContext => {
	const orgId = Option.getOrNull(model.maybeOrgId)
	return { orgId, pinnedNamespace: orgId === null ? null : (model.pinnedNamespaces[orgId] ?? null) }
}

/** What the palette's entries read from the shell. */
export const paletteContextOf = (model: Model): Palette.Context => ({
	dashboards: AsyncData.getOrElse(model.dashboards, () => []),
	favorites: model.dashboardFavorites,
	theme: model.theme,
})

/** The palette's unmount: the services read's idle TTL starts. */
export const closePalette = (model: Model): StepReturn =>
	Option.isNone(model.palette)
		? { model }
		: {
				model: { ...model, palette: Option.none() },
				commands: Option.match(model.maybeOrgId, {
					onNone: () => [],
					onSome: (orgId) => [ReleasePaletteServices({ orgId })],
				}),
			}

export const toggleTheme = (model: Model): StepReturn => {
	const theme = model.theme === "dark" ? "light" : "dark"
	return { model: { ...model, theme }, commands: [SaveTheme({ theme })] }
}

/** Results in order: the first's Commands run first. */
export const andThen = (first: StepReturn, next: (model: Model) => UpdateReturn): UpdateReturn => {
	const second = next(first.model)
	return { ...second, commands: [...(first.commands ?? []), ...(second.commands ?? [])] }
}
