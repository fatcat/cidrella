<template>
  <div class="not-found">
    <h1>404</h1>
    <p>Page not found.</p>
    <router-link to="/">Go to Dashboard</router-link>
  </div>
</template>

<style scoped>
.not-found {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
}
.not-found h1 {
  font-size: 4rem;
  margin: 0;
  color: var(--p-text-muted-color);
}
</style>
