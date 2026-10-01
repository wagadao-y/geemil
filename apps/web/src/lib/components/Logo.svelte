<script lang="ts">
  let { compact = false }: { compact?: boolean } = $props();
</script>

<span class="logo">
  <svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true">
    <path d="M16 3 28 10v12l-12 7-12-7V10z" fill="#0f766e" />
    <path
      d="M4 10l12 7 12-7M16 17v12"
      fill="none"
      stroke="#5eead4"
      stroke-width="2"
      stroke-linejoin="round"
    />
    <path d="M10 13.5 16 17l6-3.5" fill="none" stroke="#fff" stroke-width="1.6" opacity=".8" />
  </svg>
  {#if !compact}<span class="word">SPATIAL<b>HUB</b></span>{/if}
</span>

<style>
  .logo {
    display: inline-flex;
    align-items: center;
    gap: 10px;
  }
  .word {
    font-size: 17px;
    font-weight: 700;
    letter-spacing: 0.06em;
    color: var(--text);
  }
  b {
    margin-left: 5px;
    color: var(--accent);
  }
</style>
