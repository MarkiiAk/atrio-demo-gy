# Onboarding — grupo-yoma

`tenant_id`: `grupo-yoma`

Toda la personalización de este cliente vive en esta carpeta. **No se edita TypeScript para dar de alta o cambiar un cliente.**

## Archivos

| Archivo | Qué controla |
|---|---|
| `company.yaml` | Identidad, nombre visible del asistente, idioma, canal, textos de respaldo |
| `personality.yaml` | Estilo, trato (usted/tú), principios, frases prohibidas, tono por tipo de solicitud |
| `departments.yaml` | Áreas internas de la empresa |
| `workflows.yaml` | Tipos de solicitud, qué información recabar, cuándo se puede canalizar |
| `routing.yaml` | A dónde va cada caso y qué puede confirmarle el asistente al cliente |

## Conocimiento

```
knowledge/
  public/         → información ya publicada (catálogos, fichas, documentos públicos)
  customer-safe/  → información NO publicada que grupo-yoma AUTORIZA a usar frente al cliente
```

**Colocar un archivo en `customer-safe/` es una autorización explícita.** Significa que grupo-yoma acepta que el asistente use ese contenido para responderle a cualquier persona que escriba. Si algo no debe salir de la empresa, no va aquí.

Las reglas internas (a quién se canaliza, correos internos, criterios de prioridad) **no van en `knowledge/`**: van en `routing.yaml` y `workflows.yaml`, que la aplicación consume y el cliente externo nunca ve.

## Marcadores pendientes

Los campos con `TODO_REQUIRES_CLIENT_ONBOARDING` son preguntas abiertas del onboarding.

- En `APP_MODE=demo` se toleran y se reportan como advertencia.
- En `APP_MODE=production`, dentro de un workflow habilitado, son **error de arranque**.

## Comandos

```bash
npm run onboard:validate -- grupo-yoma
npm run knowledge:web-sync -- grupo-yoma <url>
npm run onboard:sync -- grupo-yoma
npm run onboard:status -- grupo-yoma
npm run chat -- grupo-yoma
npm run onboard:gaps -- grupo-yoma
```
