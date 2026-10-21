/**
 * Lazy facade over {@link Impl}, which owns the `@distilled.cloud/aws` SDK. Only the AWS connection
 * check touches it, so it loads on first call instead of with every request graph.
 */
import { Effect } from "effect"
import type * as Impl from "./api-impl"

export { AwsApiError } from "./errors"
export type { AwsKey, AwsRoleReport, AwsRoleTarget } from "./api-impl"

const impl = Effect.promise(() => import("./api-impl"))

export const checkRole: typeof Impl.checkRole = (...args) => Effect.flatMap(impl, (m) => m.checkRole(...args))
