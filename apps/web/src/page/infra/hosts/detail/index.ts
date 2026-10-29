import type { BreadcrumbEntry } from "../../../../shell"
import type { Model } from "./model"

/**
 * `/infra/hosts/$hostName`: one instance per host (`key`). Entry is `HostDetailBlock.init(route,
 * context)`; a window change arrives through the `informOfRouteChange` operation.
 */
export { HostDetailBlock } from "./block"
export { Model } from "./model"
export type { HostDetailViewInputs } from "./view"

export const routes: ReadonlyArray<"InfraHost"> = ["InfraHost"]

export const key = (route: Readonly<{ hostName: string }>): string => route.hostName

export const breadcrumbs = (model: Model): ReadonlyArray<BreadcrumbEntry> => [
	{ label: "Infrastructure", href: "/infra" },
	{ label: "Hosts", href: "/infra/hosts" },
	{ label: model.hostName },
]
