import type { Dataset } from "../dataset.ts"
import { defaultDataset } from "./default.ts"
import { emptyDataset } from "./empty.ts"
import { signedOutDataset } from "./signed-out.ts"

/** Every dataset the fixture backend serves, by name. Requests without a header get `default`. */
export const DATASETS: ReadonlyArray<Dataset> = [defaultDataset, emptyDataset, signedOutDataset]
export const DEFAULT_DATASET = defaultDataset.name
