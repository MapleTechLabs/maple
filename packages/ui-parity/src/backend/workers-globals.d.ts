/**
 * `@maple/backend/platform/bindings` names the Workers `Fetcher` type, reached here through
 * `WarehouseQueryService`. The fixture never binds one; this keeps the Bun typecheck closed.
 */
interface Fetcher {
	readonly fetch: typeof fetch
}
