import { Effect } from "effect"
import { constTrue } from "effect/Function"
import { HttpClient } from "effect/unstable/http"

/**
 * The `HttpClient` a warehouse driver runs on. OTel's database conventions
 * want one `Client` span per logical database operation, retries included,
 * with the transport's details as attributes on it — `executeSql` is that
 * span. Effect's HTTP client would otherwise nest an `http.client` span under
 * it for every round-trip, doubling warehouse span volume with a span that
 * names no database. The predicate is read from the executing fiber, so it is
 * provided around each request rather than at construction.
 */
export const warehouseHttpClient = (http: HttpClient.HttpClient): HttpClient.HttpClient =>
	HttpClient.transform(http, (effect) => Effect.provideService(effect, HttpClient.TracerDisabledWhen, constTrue))
