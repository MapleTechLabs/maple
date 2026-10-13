<script setup lang="ts">
/** A ranked list under a section head: name, count, and a trailing figure
    (share or week-over-week trend). */
defineProps({
	valueHeading: { type: String, default: "[[valueHeading]]" },
	asideHeading: { type: String, default: "[[asideHeading]]" },
})
</script>

<template>
<MapleSection class="px-6 pt-6">
[[#head]]
<MaplePanel>
<table class="w-full border-collapse">
<thead><tr>
<th class="px-3 py-2" style="border-bottom:1px solid #302b26"></th>
<th class="px-3 py-2 text-right font-mono text-[10px] font-medium uppercase tracking-widest text-maple-fg-dim" style="border-bottom:1px solid #302b26">{{ valueHeading }}</th>
<th class="w-[72px] px-3 py-2 text-right font-mono text-[10px] font-medium uppercase tracking-widest text-maple-fg-dim" style="border-bottom:1px solid #302b26">{{ asideHeading }}</th>
</tr></thead>
<tbody>[[#rankRows]]</tbody>
</table>
</MaplePanel>
</MapleSection>
</template>
