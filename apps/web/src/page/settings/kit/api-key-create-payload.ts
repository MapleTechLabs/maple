import type { V2ApiKeyCreateParams, V2Scope } from "@maple/domain/http/v2"
import { String as Str } from "effect"

export interface ApiKeyCreateOptions {
	expiresInSeconds?: number
	scopes?: ReadonlyArray<V2Scope>
}

export const buildApiKeyCreatePayload = (
	name: string,
	description: string,
	kind: V2ApiKeyCreateParams["kind"],
	options: ApiKeyCreateOptions = {},
): V2ApiKeyCreateParams => {
	const trimmedDescription = Str.trim(description)

	return {
		name: Str.trim(name),
		...(trimmedDescription.length > 0 ? { description: trimmedDescription } : undefined),
		...(kind !== undefined ? { kind } : undefined),
		...(options.expiresInSeconds !== undefined
			? { expires_in_seconds: options.expiresInSeconds }
			: undefined),
		...(kind !== "mcp" && options.scopes !== undefined && options.scopes.length > 0
			? { scopes: options.scopes }
			: undefined),
	}
}
