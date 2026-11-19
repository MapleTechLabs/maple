import { Schema } from "effect"

/**
 * Where in Maple a request was made, and so what its subject names: `cost_source` is a cost
 * provider. A new place to ask from is one more literal here.
 */
export const FeatureRequestArea = Schema.Literals(["cost_source"])
export type FeatureRequestArea = typeof FeatureRequestArea.Type

export const FEATURE_REQUEST_SUBJECT_MAX_LENGTH = 80
export const FEATURE_REQUEST_NOTE_MAX_LENGTH = 1000
