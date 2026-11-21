/** Font files the Worker bundles as Data modules (`rules` in `worker.ts`). */
declare module "*.ttf" {
	const data: ArrayBuffer
	export default data
}
