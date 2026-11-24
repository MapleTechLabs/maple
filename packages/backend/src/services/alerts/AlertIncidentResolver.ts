import { Context, Effect, Layer } from "effect"
import { AlertsService, type AlertsServiceApi } from "./AlertsService"

export interface AlertIncidentResolverApi {
	/** Resolves an open incident by hand and queues its all-clear with the resolve. */
	readonly resolve: AlertsServiceApi["resolveIncident"]
}

/**
 * Resolving an incident by hand, as a capability of its own: the incident routes hold this and
 * the read services, not the whole evaluation and dispatch service it is carried out by.
 */
export class AlertIncidentResolver extends Context.Service<AlertIncidentResolver, AlertIncidentResolverApi>()(
	"@maple/backend/services/alerts/AlertIncidentResolver",
	{
		make: Effect.map(AlertsService, (alerts): AlertIncidentResolverApi => ({
			resolve: alerts.resolveIncident,
		})),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(AlertsService.layer))
}
