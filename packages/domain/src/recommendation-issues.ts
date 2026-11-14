// Stored shapes shared by the HTTP contract (`./http/recommendation-issues.ts`) and the Postgres tables.

import { Schema } from "effect"

export const RecommendationIssueStatus = Schema.Literals(["open", "dismissed", "applied", "resolved"])
export type RecommendationIssueStatus = typeof RecommendationIssueStatus.Type
