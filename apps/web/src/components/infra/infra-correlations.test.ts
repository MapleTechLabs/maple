import { describe, expect, it } from "vitest"
import { getActiveInfraCorrelations } from "./infra-correlations"

describe("getActiveInfraCorrelations", () => {
	it("returns no groups for empty/missing resource attributes", () => {
		expect(getActiveInfraCorrelations(null)).toEqual([])
		expect(getActiveInfraCorrelations(undefined)).toEqual([])
		expect(getActiveInfraCorrelations({})).toEqual([])
		expect(getActiveInfraCorrelations({ "service.name": "checkout" })).toEqual([])
	})

	it("treats empty-string identity values as absent", () => {
		// Warehouse resource maps default missing keys to "" — must not surface a
		// group that would query/link to an empty identifier.
		expect(
			getActiveInfraCorrelations({
				"k8s.pod.name": "",
				"k8s.node.name": "",
				"host.name": "",
			}),
		).toEqual([])
	})

	it("detects a pod and builds a namespaced deep-link", () => {
		const [pod] = getActiveInfraCorrelations({
			"k8s.pod.name": "checkout-7c9f",
			"k8s.namespace.name": "prod",
		})
		expect(pod.kind).toBe("pod")
		expect(pod.identifier).toBe("checkout-7c9f")
		expect(pod).toMatchObject({ namespace: "prod" })
		expect(pod.href).toBe("/infra/kubernetes/pods/checkout-7c9f?namespace=prod")
	})

	it("omits the namespace query param when no namespace is present", () => {
		const [pod] = getActiveInfraCorrelations({ "k8s.pod.name": "checkout-7c9f" })
		expect(pod.href).toBe("/infra/kubernetes/pods/checkout-7c9f")
	})

	it("detects a node", () => {
		const groups = getActiveInfraCorrelations({ "k8s.node.name": "ip-10-0-1-5" })
		expect(groups).toHaveLength(1)
		expect(groups[0]).toMatchObject({
			kind: "node",
			identifier: "ip-10-0-1-5",
			href: "/infra/kubernetes/nodes/ip-10-0-1-5",
		})
	})

	it("detects a host", () => {
		const groups = getActiveInfraCorrelations({ "host.name": "ip-10-0-1-5.ec2.internal" })
		expect(groups).toHaveLength(1)
		expect(groups[0]).toMatchObject({
			kind: "host",
			identifier: "ip-10-0-1-5.ec2.internal",
			href: "/infra/ip-10-0-1-5.ec2.internal",
		})
	})

	it("emits both Pod and Node groups in order for a k8s span", () => {
		const groups = getActiveInfraCorrelations({
			"k8s.pod.name": "checkout-7c9f",
			"k8s.namespace.name": "prod",
			"k8s.node.name": "ip-10-0-1-5",
		})
		expect(groups.map((g) => g.kind)).toEqual(["pod", "node"])
	})

	it("url-encodes identifiers and namespaces in the deep-link", () => {
		const [pod] = getActiveInfraCorrelations({
			"k8s.pod.name": "weird/pod name",
			"k8s.namespace.name": "team a/b",
		})
		expect(pod.href).toBe(
			"/infra/kubernetes/pods/weird%2Fpod%20name?namespace=team%20a%2Fb",
		)
	})

	it("each group carries at least one chart", () => {
		const groups = getActiveInfraCorrelations({
			"k8s.pod.name": "p",
			"k8s.node.name": "n",
			"host.name": "h",
		})
		expect(groups.map((g) => g.kind)).toEqual(["pod", "node", "host"])
		for (const g of groups) {
			expect(g.charts.length).toBeGreaterThan(0)
		}
	})
})
