import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // setupFiles corre antes de importar cada archivo de test: es la única
    // ventana para fijar el entorno antes de que src/config/env se congele
    // (los `import` de ESM se evalúan antes que el cuerpo del módulo).
    setupFiles: ['tests/setup.ts'],
    // Un proceso por archivo → una base SQLite temporal por archivo.
    pool: 'forks',
    isolate: true,
    globals: false,
    testTimeout: 20_000,
  },
});
