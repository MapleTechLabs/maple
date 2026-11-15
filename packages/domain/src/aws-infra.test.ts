import { describe, expect, it } from "vitest"
import { Array as Arr, String as Str } from "effect"
import { AWS_INFRA_KINDS, AWS_INFRA_KIND_IDS, AWS_METRIC_PREFIX } from "./aws-infra"

describe("AWS_INFRA_KINDS", () => {
	// `aws_metrics_hourly`'s views keep only metrics with this prefix; a page metric without it
	// would read zero from the rollup's whole hours while the raw edges still found it.
	it("names only metrics the aws_metrics_hourly views write", () => {
		const names = Arr.flatMap(AWS_INFRA_KIND_IDS, (kind) =>
			Arr.map(AWS_INFRA_KINDS[kind].metrics, (metric) => metric.name),
		)
		expect(Arr.filter(names, (name) => !Str.startsWith(AWS_METRIC_PREFIX)(name))).toEqual([])
	})
})
