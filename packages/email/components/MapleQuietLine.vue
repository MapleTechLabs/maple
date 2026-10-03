<script setup lang="ts">
/** A single muted line standing in for an empty block. */
defineProps({ text: { type: String, default: "[[text]]" } })
</script>

<template>
<MapleSection class="px-6 pt-3">
<p class="m-0 font-mono text-[11px] leading-snug text-maple-fg-muted">{{ text }}</p>
</MapleSection>
</template>
