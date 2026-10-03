<script setup lang="ts">
/** AI traffic block: section head, then assistants and crawlers side by side
    (or a quiet-week line). */
</script>

<template>
<MapleSection class="px-6 pt-6">
[[#head]]
</MapleSection>
<MapleSection class="px-5">
<table class="w-full border-collapse"><tbody><tr>[[#aiColumns]]</tr></tbody></table>
</MapleSection>
[[#aiQuiet]]
</template>
