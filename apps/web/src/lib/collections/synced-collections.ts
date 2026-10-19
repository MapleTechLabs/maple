import {
	AlertDestinationRowSchema,
	AlertIncidentRowSchema,
	AlertRuleRowSchema,
	AlertRuleStateRowSchema,
} from "@maple/web-data/collections/alerts"
import { ApiKeyRowSchema } from "@maple/web-data/collections/api-keys"
import { timestamptzParser } from "@maple/web-data/collections/shape-parsers"
import { createSyncedCollection } from "./shape-fetch"

// The read-only synced collections over `@maple/web-data/collections` row schemas. Writes go
// through the v2 API, not the shape (dashboards, which write, live in `dashboards.ts`).

export const createAlertRulesCollection = (orgId: string) =>
	createSyncedCollection({
		shape: "alert_rules",
		orgId,
		schema: AlertRuleRowSchema,
		parser: timestamptzParser,
		getKey: (row) => row.id,
	})

export const createAlertRuleStatesCollection = (orgId: string) =>
	createSyncedCollection({
		shape: "alert_rule_states",
		orgId,
		schema: AlertRuleStateRowSchema,
		parser: timestamptzParser,
		// Composite key (org_id, rule_id, group_key) → a stable derived string.
		getKey: (row) => `${row.rule_id}:${row.group_key}`,
	})

export const createAlertIncidentsCollection = (orgId: string) =>
	createSyncedCollection({
		shape: "alert_incidents",
		orgId,
		schema: AlertIncidentRowSchema,
		parser: timestamptzParser,
		getKey: (row) => row.id,
	})

export const createAlertDestinationsCollection = (orgId: string) =>
	createSyncedCollection({
		shape: "alert_destinations_v2",
		orgId,
		schema: AlertDestinationRowSchema,
		parser: timestamptzParser,
		getKey: (row) => row.id,
	})

export const createApiKeysCollection = (orgId: string) =>
	createSyncedCollection({
		shape: "api_keys",
		orgId,
		schema: ApiKeyRowSchema,
		getKey: (row) => row.id,
		parser: timestamptzParser,
	})

export type AlertRulesCollection = ReturnType<typeof createAlertRulesCollection>
export type AlertRuleStatesCollection = ReturnType<typeof createAlertRuleStatesCollection>
export type AlertIncidentsCollection = ReturnType<typeof createAlertIncidentsCollection>
export type AlertDestinationsCollection = ReturnType<typeof createAlertDestinationsCollection>
export type ApiKeysCollection = ReturnType<typeof createApiKeysCollection>
