import { Context } from "effect"

/**
 * Why an analyst, who only reads, may still call an endpoint that is not a GET: `read` only looks
 * (a query with a body), `personal` changes the caller's own state. Unset means the endpoint changes
 * the organization, and the auth middlewares refuse it to an analyst.
 */
export class AnalystAccess extends Context.Reference<"read" | "personal" | undefined>(
	"@maple/http/AnalystAccess",
	{ defaultValue: () => undefined },
) {}

interface Annotated {
	readonly annotations: Context.Context<never>
}

/** Whether a read-only role may call the endpoint: a GET, or one marked {@link AnalystAccess}. */
export const isOpenToAnalysts = (options: {
	readonly endpoint: Annotated & { readonly method: string }
	readonly group: Annotated
}): boolean => {
	const { method } = options.endpoint
	if (method === "GET" || method === "HEAD") return true
	// A group-level `.annotate` lands on the group only, so both are read; the endpoint wins.
	const access =
		Context.get(options.endpoint.annotations, AnalystAccess) ??
		Context.get(options.group.annotations, AnalystAccess)
	return access !== undefined
}
