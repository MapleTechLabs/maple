import { encodePublicId, type PublicIdPrefix } from "@maple/domain/http/v2"
import { type AuditAction, AuditResources, type AuditResourceType } from "@maple/domain/audit-actions"

// The catalog lives in `@maple/domain` so the web can label entries with it.
export { type AuditAction, AuditResources, type AuditResourceType }

type ResourceOf<A extends AuditAction> = A extends `${infer R}.${string}`
	? R extends AuditResourceType
		? R
		: never
	: never

/**
 * The `resourceId` option for an action: the resource's *internal* ID, encoded
 * to its public `<prefix>_…` form on the way to the row. Resources that declare
 * no prefix (org-singletons) accept no `resourceId` at all.
 */
export type AuditResourceIdOption<A extends AuditAction> = (typeof AuditResources)[ResourceOf<A>] extends {
	readonly prefix: PublicIdPrefix
}
	? { readonly resourceId?: string }
	: { readonly resourceId?: never }

/**
 * Derive the row's `resource_type` from the action and encode the internal
 * resource ID into its public form, so no call site restates either.
 */
export const auditResourceFields = (
	action: AuditAction,
	resourceId?: string,
): { readonly resourceType: AuditResourceType; readonly resourceId?: string } => {
	// SAFETY: every `AuditAction` is built as `${resource}.${verb}` from the keys
	// of `AuditResources`, so the segment before the dot is always one of them.
	const resourceType = action.slice(0, action.indexOf(".")) as AuditResourceType
	const resource = AuditResources[resourceType]
	// Narrow rather than widen: org-singleton resources declare no `prefix` at all.
	const prefix = "prefix" in resource ? resource.prefix : undefined
	return {
		resourceType,
		...(resourceId !== undefined && prefix !== undefined
			? { resourceId: encodePublicId(prefix, resourceId) }
			: undefined),
	}
}
