import type { AlertRuleId, AuditDetection } from "@maple/domain/http"
import { countLabel } from "@maple/ui/lib/format"
import { Array as Arr, Option } from "effect"
import { AsyncData } from "foldkit"
import type { Model } from "./model"

/** The detections on screen, newest first; null until the list answers. */
export const detectionsOf = (model: Pick<Model, "list">): ReadonlyArray<AuditDetection> | null =>
	AsyncData.matchData(model.list.data, {
		onEmpty: () => null,
		onFailure: () => null,
		onData: (page) => page.detections,
	})

export const detectionById = (
	model: Pick<Model, "list">,
	id: AlertRuleId | null,
): Option.Option<AuditDetection> =>
	Arr.findFirst(detectionsOf(model) ?? [], (detection) => detection.id === id)

/** "2 destinations", or null when the detection notifies nobody. */
export const notifiesText = (detection: AuditDetection): string | null =>
	detection.destinationIds.length === 0 ? null : countLabel(detection.destinationIds.length, "destination")
