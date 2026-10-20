import { groupReleases, type ReleaseGroup } from "../../../components/releases/release-model"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import { deriveOf } from "../list/derive"
import type { Model } from "./model"

/** The deploy this page describes, once the releases of the window have loaded. */
export const groupOf = (model: Model): Option.Option<ReleaseGroup> =>
	Option.flatMap(AsyncData.getData(model.releases.data), (data) =>
		Option.fromUndefinedOr(groupReleases(deriveOf(data).impacts).find((group) => group.commitSha === model.commitSha)),
	)
