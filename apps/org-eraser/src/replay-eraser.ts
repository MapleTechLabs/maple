import type * as Cloudflare from "@alchemy.run/cloudflare"
import { type ObjectPrefixEraser, ObjectStoreError } from "@maple/backend/platform/bindings"
import { dischargeRuntimeContext } from "@maple/infra/worker-runtime"
import { Array as Arr, Effect } from "effect"

/** R2 deletes at most 1000 keys per call, which is also a listing's largest page. */
export const ERASE_PAGE_SIZE = 1000

/** The replay bucket's delete side: one listing page under the prefix, then those keys deleted. */
export const prefixEraser = (client: Cloudflare.R2.ReadWriteBucketClient): ObjectPrefixEraser => ({
	deletePage: (prefix) =>
		dischargeRuntimeContext(client.list({ prefix, limit: ERASE_PAGE_SIZE })).pipe(
			Effect.flatMap((page) => {
				const keys = Arr.map(page.objects, (object) => object.key)
				return keys.length === 0
					? Effect.succeed(0)
					: dischargeRuntimeContext(client.delete(keys)).pipe(Effect.as(keys.length))
			}),
			Effect.mapError((error) => new ObjectStoreError({ message: error.message, cause: error.cause })),
		),
})
