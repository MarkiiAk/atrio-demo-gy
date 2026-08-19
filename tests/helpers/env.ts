/**
 * El aislamiento real (base temporal, carpeta de onboarding propia) lo hace
 * `tests/setup.ts`, que vitest ejecuta antes de importar cada archivo de test.
 * Aquí sólo se leen esas rutas.
 */
export function onboardingDir(): string {
  const dir = process.env.ONBOARDING_DIR;
  if (!dir) {
    throw new Error('ONBOARDING_DIR no está definido: falta configurar setupFiles en vitest.config.ts');
  }
  return dir;
}

export function testRoot(): string {
  return process.env.ATRIO_TEST_ROOT as string;
}
