import { String as Str } from "effect"

/** How Maple names a Fleet server everywhere: the organization it reports, else its host. */
export const fleetServerName = (server: {
	readonly organizationName: string | null
	readonly baseUrl: string
}): string =>
	server.organizationName === null || Str.isEmpty(Str.trim(server.organizationName))
		? new URL(server.baseUrl).host
		: server.organizationName
