declare module "*.css" {
	const content: string
	export default content
}

// Vite's `?worker` suffix (declared by `vite/client` in the apps that bundle this package).
declare module "*?worker" {
	const WorkerConstructor: new (options?: { name?: string }) => Worker
	export default WorkerConstructor
}
