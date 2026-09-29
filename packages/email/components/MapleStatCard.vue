<script setup lang="ts">
/** One headline stat with its icon, and the week-over-week pill spelled out. */
defineProps({
	icon: { type: String, default: "[[icon]]" },
	label: { type: String, default: "[[label]]" },
	value: { type: String, default: "[[value]]" },
})
</script>

<template>
	<td class="w-1/2 p-1">
		<MapleTile class="px-4 py-3.5">
			<table class="mb-1.5"><tbody><tr>
			<td class="w-[14px] pr-1.5 align-middle"><img :src="icon" width="14" height="14" alt="" style="display:block;border:0;width:14px;height:14px"></td>
			<td class="align-middle"><MapleSectionLabel>{{ label }}</MapleSectionLabel></td>
			</tr></tbody></table>
			<p class="m-0 mb-2 font-mono text-[22px] font-semibold leading-none text-maple-fg">{{ value }}</p>
			<p class="m-0 font-mono text-[10px] leading-[16px] text-maple-fg-dim">[[#deltaPill]] vs last week</p>
		</MapleTile>
	</td>
</template>
