import { Array as Arr } from "effect"
import { describe, expect, it } from "vitest"
import { cloudResourceCandidates } from "./cloud-security"

const valuesOn = (resourceId: string, resourceType: string, key: string) =>
	Arr.map(
		Arr.filter(
			cloudResourceCandidates({
				resourceId,
				resourceType,
				accountId: "111111111111",
				region: "us-east-1",
			}),
			(candidate) => candidate.key === key,
		),
		(candidate) => candidate.value,
	)

describe("cloudResourceCandidates", () => {
	it("matches a Lambda by its function name, never by a version or alias", () => {
		const arn = "arn:aws:lambda:us-east-1:111111111111:function:checkout:prod"
		expect(valuesOn(arn, "AwsLambdaFunction", "faas.name")).toEqual(["checkout"])
		expect(valuesOn(arn, "AwsLambdaFunction", "k8s.cluster.name")).toEqual([])
		expect(
			Arr.map(
				cloudResourceCandidates({
					resourceId: arn,
					resourceType: "",
					accountId: "111111111111",
					region: "us-east-1",
				}),
				(c) => c.value,
			),
		).not.toContain("prod")
	})

	it("matches an EC2 instance ARN on host.id and an EKS cluster ARN on its cluster name", () => {
		expect(
			valuesOn(
				"arn:aws:ec2:us-east-1:111111111111:instance/i-0abc12345678",
				"AwsEc2Instance",
				"host.id",
			),
		).toEqual(["i-0abc12345678"])
		expect(
			valuesOn(
				"arn:aws:eks:us-east-1:111111111111:cluster/payments",
				"AwsEksCluster",
				"k8s.cluster.name",
			),
		).toEqual(["payments"])
	})

	it("keeps an IAM role's name out of every name attribute", () => {
		const candidates = cloudResourceCandidates({
			resourceId: "arn:aws:iam::111111111111:role/admin",
			resourceType: "AwsIamRole",
			accountId: "111111111111",
			region: "us-east-1",
		})
		expect(Arr.map(candidates, (candidate) => candidate.value)).not.toContain("admin")
	})

	it("reads a bare id only where its type says what it is", () => {
		expect(valuesOn("i-0abc12345678", "Instance", "host.id")).toEqual(["i-0abc12345678"])
		expect(valuesOn("cart-fn", "Lambda", "faas.name")).toEqual(["cart-fn"])
		// An instance-shaped Lambda name is still a function name.
		expect(valuesOn("i-0abc12345678", "Lambda", "faas.name")).toEqual(["i-0abc12345678"])
		expect(valuesOn("i-0abc12345678", "Lambda", "host.id")).toEqual([])
		expect(
			cloudResourceCandidates({
				resourceId: "my-bucket",
				resourceType: "S3Bucket",
				accountId: "1",
				region: "us-east-1",
			}),
		).toEqual([])
	})
})
