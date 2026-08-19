# ATRIO

Plataforma multi-tenant de asistentes de IA para WhatsApp. Funciona como el **primer punto de atención** de una empresa: entiende lo que la persona necesita aunque escriba libre, responde sólo lo que puede respaldar con información autorizada, recaba lo que falta sin interrogar, y prepara casos estructurados para el área interna correcta.

El primer tenant es **Grupo Yoma**. El core no lo conoce: toda la personalización vive en `onboarding/grupo-yoma/`. Dar de alta otro cliente no requiere tocar TypeScript.

---

## Principio central

> **El LLM entiende, conversa, extrae y redacta. La aplicación gobierna, limita, persiste, enruta y decide qué está permitido.**

El modelo no es dueño del sistema. Puede *sugerir* que un caso está listo; sólo la aplicación decide si se canaliza, comparando contra la configuración del tenant y los datos realmente presentes en la base. Y el texto que genera pasa por un guardián determinista antes de salir.

---

## Arquitectura

```
                 ┌───────────────┐        ┌──────────────┐
   WhatsApp ────▶│    Twilio     │        │  Navegador   │
                 └───────┬───────┘        └──────┬───────┘
                         │ POST                  │ POST
                         ▼                       ▼
              /webhooks/twilio/whatsapp     /api/web/chat
                         │                       │
              ┌──────────▼──────────┐            │
              │ Validar X-Twilio-   │            │
              │ Signature (SDK)     │            │
              ├─────────────────────┤            │
              │ Deduplicar          │            │
              │ MessageSid          │            │
              ├─────────────────────┤            │
              │ Persistir + encolar │            │
              │ → 200 OK inmediato  │            │
              └──────────┬──────────┘            │
                         │                       │
              ┌──────────▼──────────┐            │
              │ Worker in-process   │            │
              │ · debounce          │            │
              │ · 1 lote por        │            │
              │   conversación      │            │
              └──────────┬──────────┘            │
                         │                       │
                         └───────┬───────────────┘
                                 ▼
                    ╔════════════════════════╗
                    ║  ConversationEngine    ║   ← un solo camino
                    ╚════════════┬═══════════╝     (WhatsApp = web = CLI)
                                 │
     ┌───────────────────────────┼───────────────────────────┐
     ▼                           ▼                           ▼
┌──────────┐          ┌─────────────────────┐      ┌──────────────────┐
│  Config  │          │  OpenAI Responses   │      │  Estado en DB    │
│  YAML    │─prompt──▶│  + File Search      │      │  casos, campos,  │
│ (tenant) │          │  + Structured Out.  │      │  conversación    │
└──────────┘          └──────────┬──────────┘      └──────────────────┘
                                 │
                                 ▼
                    ┌────────────────────────┐
                    │ Reglas DETERMINISTAS   │
                    │ · ¿esenciales listos?  │
                    │ · ¿hay destino?        │
                    │ · ¿está permitido?     │
                    └───────────┬────────────┘
                                │ sí
                                ▼
                    ┌────────────────────────┐
                    │ Canalizar (LOG/EMAIL)  │
                    │ → RoutingEvent SUCCESS │
                    └───────────┬────────────┘
                                │ AHORA sí puede confirmar
                                ▼
                    ┌────────────────────────┐
                    │ Guardián de respuesta  │
                    │ · no promete envíos    │
                    │ · no expone tripas     │
                    │ · reintenta o degrada  │
                    └───────────┬────────────┘
                                ▼
                         respuesta al cliente
```

### Vector store por tenant

Cada tenant tiene su **propio** vector store en OpenAI (`atrio-<tenant-id>`). El id se resuelve siempre desde el tenant en curso, así que una consulta no puede alcanzar documentos de otro cliente. El aislamiento no depende de un filtro que alguien pueda olvidar.

### Tres tipos de conocimiento

| Tipo | Dónde vive | Quién lo ve |
|---|---|---|
| **PUBLIC** | sitio web sincronizado + `knowledge/public/` | el cliente final, vía RAG |
| **CUSTOMER_SAFE** | `knowledge/customer-safe/` | el cliente final, vía RAG — **el tenant lo autoriza explícitamente** |
| **INTERNAL_RULES** | `routing.yaml`, `workflows.yaml` | sólo la aplicación. Nunca entra al RAG. |

Poner un archivo en `customer-safe/` **es** la autorización. Las reglas de a quién se canaliza cada caso no van ahí: son configuración estructurada que consume el código.

El contenido recuperado se trata como **dato, nunca como instrucción**: el prompt le prohíbe al modelo obedecer órdenes que aparezcan dentro de un documento.

---

## Instalación

```bash
npm install
cp .env.example .env      # y llena los valores (abajo)
npm run db:migrate
```

Requiere Node.js 20.11+ (probado en 22 LTS).

---

## Variables de entorno

Sólo estas cuatro son secretas. Ninguna va al repo.

| Variable | De dónde sale |
|---|---|
| `OPENAI_API_KEY` | platform.openai.com → API keys |
| `TWILIO_ACCOUNT_SID` | consola de Twilio → Account Info |
| `TWILIO_AUTH_TOKEN` | consola de Twilio → Account Info |
| `TWILIO_WHATSAPP_FROM` | tu sender de WhatsApp, formato `whatsapp:+52...` |

Las que más cambian el comportamiento:

| Variable | Para qué |
|---|---|
| `APP_MODE` | `demo` tolera TODOs de onboarding; `production` los vuelve error de arranque |
| `OPENAI_MODEL` | nunca está hardcodeado; cámbialo sin tocar código |
| `PUBLIC_BASE_URL` | URL pública EXACTA — ver *Firma de Twilio* abajo |
| `TWILIO_VALIDATE_SIGNATURE` | `true` por defecto. Sólo desactívalo en pruebas locales |
| `INBOUND_DEBOUNCE_MS` | agrupa mensajes rápidos consecutivos en una sola respuesta |

Ver `.env.example` para la lista completa comentada.

---

## Onboarding: dar de alta un cliente

```bash
npm run onboard:new -- mi-cliente          # wizard interactivo
npm run onboard:new -- mi-cliente --yes    # valores por defecto, sin preguntas
```

Genera:

```
onboarding/mi-cliente/
  company.yaml        identidad, canal, textos de respaldo
  personality.yaml    estilo, trato usted/tú, frases prohibidas, tono por flujo
  departments.yaml    áreas internas
  workflows.yaml      tipos de solicitud y qué información recabar
  routing.yaml        a dónde va cada caso y qué puede confirmar el asistente
  knowledge/
    public/           documentos ya públicos
    customer-safe/    documentos que el cliente AUTORIZA usar con externos
  README.md
```

Nunca sobrescribe archivos existentes sin `--force`.

Los campos que el cliente aún no ha respondido llevan el marcador `TODO_REQUIRES_CLIENT_ONBOARDING`. En `demo` son avisos; en `production`, dentro de un workflow habilitado, **impiden el arranque** — el sistema no se comporta de forma rota en silencio.

### Ciclo completo

```bash
npm run onboard:validate -- mi-cliente                    # valida los 5 YAML y sus relaciones
npm run knowledge:web-sync -- mi-cliente https://sitio.com # indexa el sitio
npm run onboard:sync -- mi-cliente                        # sube todo al vector store
npm run onboard:status -- mi-cliente                      # estado consolidado
npm run chat -- mi-cliente                                # pruébalo sin WhatsApp
```

---

## Grupo Yoma

Ya está configurado. Para recargarlo desde cero:

```bash
npm run onboard:validate -- grupo-yoma
npm run knowledge:web-sync -- grupo-yoma https://grupoyoma.com.mx --max 45
npm run onboard:sync -- grupo-yoma
```

El crawler respeta `robots.txt`, se limita al mismo dominio, hace pausas entre peticiones, extrae sólo contenido visible, calcula hashes y **no vuelve a subir lo que no cambió**. La copia local queda en `.cache/knowledge/grupo-yoma/website/` para poder auditar exactamente qué se indexó.

Para editar su comportamiento no se toca código: se editan los YAML de `onboarding/grupo-yoma/` y se corre `onboard:sync`.

---

## Probar sin WhatsApp

**Chat en terminal** — usa exactamente el mismo `ConversationEngine`:

```bash
npm run chat -- grupo-yoma
```

Comandos dentro del chat: `/debug` (traza interna), `/prompt` (system prompt del último turno), `/reset`, `/salir`.

**Chat web** — es el link que puede abrir el cliente:

```bash
npm run build && npm start
# http://localhost:3000
```

El botón **Detalle** muestra qué detectó, qué documentos consultó, qué le falta y si canalizó. Útil para demostrar que hay ingeniería detrás y no un truco.

---

## WhatsApp real

### 1. Túnel (si corres local)

```bash
ngrok http 3000
```

Copia la URL `https://…ngrok-free.app` a `PUBLIC_BASE_URL` en `.env`, **sin slash final**, y reinicia el servidor.

### 2. Webhook en Twilio

Consola de Twilio → **Messaging → Senders → WhatsApp senders** → tu número:

| Campo | Valor |
|---|---|
| When a message comes in | `https://TU-URL-PUBLICA/webhooks/twilio/whatsapp` — **HTTP POST** |
| Status callback URL | `https://TU-URL-PUBLICA/webhooks/twilio/status` (opcional) |

### 3. Firma de Twilio y por qué `PUBLIC_BASE_URL` importa

Twilio firma cada webhook con HMAC-SHA1 sobre **la URL exacta a la que hizo el POST**, concatenada con los parámetros del formulario. Detrás de ngrok o de un proxy, `req.protocol` y `req.host` reflejan la conexión interna (`http://localhost:3000`), no la URL pública que Twilio usó. Reconstruir la URL desde el request produciría una firma distinta y rechazaría webhooks legítimos.

Por eso la URL pública se **declara** y no se adivina. Si cambias la URL de ngrok, actualiza `PUBLIC_BASE_URL` y la de Twilio: tienen que coincidir carácter por carácter.

La validación usa `twilio.validateRequest()` del SDK oficial. No escribimos criptografía propia.

### 4. Primera prueba

```
WhatsApp personal
  → mensaje al número de Twilio
  → webhook (firma validada)
  → job persistido en SQLite
  → tenant grupo-yoma resuelto por el número receptor
  → ConversationEngine → OpenAI + File Search
  → reglas de negocio → caso → canalización
  → Twilio REST API
  → respuesta en tu WhatsApp
```

Verifica en la consola: aparecerán bloques `[INBOUND]`, `[AI]` y `[OUTBOUND]`.

### Un mismo número no puede servir a dos sistemas

Twilio permite **una sola URL de webhook por número**. Apuntar un número a ATRIO lo desconecta de cualquier otro sistema que lo estuviera usando. Para probar sin tocar un número en uso: crea un sender nuevo o usa el Sandbox de Twilio.

---

## Comandos de operación

### Gaps de onboarding

Lo que el asistente no pudo responder con respaldo, agregado por frecuencia:

```bash
npm run onboard:gaps -- grupo-yoma
npm run onboard:gaps -- grupo-yoma --clear   # tras resolverlos
```

Cada línea es una pregunta que el cliente debería poder contestar para su asistente. Es material directo para la siguiente sesión de onboarding.

### Consumo

```bash
npm run usage:report -- grupo-yoma
npm run usage:report -- grupo-yoma --days 7
```

Reporta conversaciones, mensajes, llamadas a OpenAI, tokens de entrada/salida, latencia media y p95, y tokens por conversación.

**No calcula importes a propósito:** los precios de OpenAI y Twilio cambian, y hardcodearlos daría números falsos con apariencia de exactitud. Multiplica los tokens por la tarifa vigente de tu modelo.

### Retención de datos

```bash
npm run data:purge              # simulación, no borra nada
npm run data:purge -- --apply   # ejecuta
```

Borra conversaciones más viejas que `DATA_RETENTION_DAYS` (y en cascada sus mensajes, casos y jobs). Los registros de consumo y los gaps se conservan: son agregados operativos, no contenido de conversación.

---

## Tests

```bash
npm test          # 103 tests, sin red
npm run typecheck
npm run build
```

Cubren validación de YAML, aislamiento entre tenants, carga de workflows, fusión de campos, multi-intent, evaluación de esenciales, elegibilidad de canalización, idempotencia de `MessageSid`, serialización de la cola, detección de TODOs, agregación de gaps y de consumo, middleware de firma de Twilio, constructor de prompt y guardián de respuestas.

No tocan OpenAI ni Twilio: cada archivo corre contra una base SQLite temporal y su propia carpeta de onboarding.

### Evaluaciones en vivo

```bash
# .env → RUN_LIVE_EVALS=true
npm run eval:demo -- grupo-yoma
npm run eval:demo -- grupo-yoma --only=B
```

Corren contra OpenAI real y **gastan tokens**. No comparan frases exactas — el modelo redacta distinto cada vez y exigir texto literal daría una suite que falla sin que nada esté mal. Verifican **invariantes**: intent correcto, no inventa, no expone las tripas, no repite datos que ya tiene, canaliza cuando debe y no antes, cierra sin forzar venta.

Los diez escenarios cubren: cotización completa, dos problemas en un mensaje, pregunta técnica sin respaldo, cliente recurrente, proveedor, RH, estatus de pedido sin integración, información general, cierre cordial y ambigüedad.

---

## Demo vs Production

| | `demo` | `production` |
|---|---|---|
| TODOs de onboarding | avisos | **error de arranque** si están en un workflow habilitado |
| Routing `LOG` | permitido | permitido, pero sólo puede confirmar "registrado" |
| Arranque con tenant inválido | continúa | aborta |
| PII en logs | visible | enmascarada |
| Inventar información | **nunca** | **nunca** |

El modo demo relaja la *configuración pendiente*, nunca la honestidad de las respuestas.

---

## Despliegue

```bash
# Render — usa render.yaml
#   Necesita el plan starter: el free NO tiene disco persistente y SQLite
#   perdería el estado en cada redeploy.

# Railway / Fly.io / Cloud Run — usa el Dockerfile
docker build -t atrio .
docker run -p 3000:3000 --env-file .env -v atrio-data:/var/data atrio
```

Tras desplegar: copia la URL pública a `PUBLIC_BASE_URL` **y** al webhook de Twilio.

**Por qué no Vercel:** ATRIO necesita un proceso vivo (el worker de cola, con debounce y serialización por conversación) y un disco persistente para SQLite. En serverless el estado se pierde entre invocaciones y el asistente olvidaría la conversación a media charla. Migrar a Vercel es posible, pero requiere Postgres serverless y mover el worker a `waitUntil`.

---

## Estructura

```
src/
  app.ts server.ts
  config/env.ts                    entorno validado con Zod
  tenants/                         carga y validación de la config YAML
  channels/
    whatsapp/                      webhook, firma, envío, resolución de tenant
    web/                           chat de demostración
  conversation/
    conversation-engine.ts         EL camino único
    reply-guard.ts                 verificación determinista del texto
    state.service.ts
  ai/                              Responses API + JSON Schema
  knowledge/                       crawler, vector store, manifest, sync
  workflows/                       intent→workflow, campos esenciales
  routing/                         elegibilidad + adapters
  onboarding/                      plantillas, scaffolding, gaps
  usage/  jobs/  repositories/  prompts/  types/
scripts/                           los 11 comandos de CLI
onboarding/grupo-yoma/             configuración del primer tenant
public/                            chat web
tests/                             103 tests
```

---

## Limitaciones actuales

Honestas, no exhaustivas:

- **Un solo proceso.** La cola es SQLite y el worker corre in-process. Sirve para pilotos; escalar a varias instancias requiere Redis o similar.
- **Adapters de canalización:** `LOG` y `EMAIL` funcionan. `WEBHOOK`, `CRM` y `HUMAN_INBOX` están declarados pero no implementados — degradan a `LOG` y lo registran como gap, sin fingir una entrega.
- **Multimedia:** se persiste la metadata que manda Twilio (URL, content-type), pero no se descarga ni se interpreta el contenido. El texto es el camino completo.
- **Sin integraciones de negocio.** No consulta estatus de pedidos, facturas ni inventario. Recaba y canaliza; nunca inventa un estatus.
- **Extracción de campos intermitente.** El modelo ocasionalmente no rellena `field_updates` en el primer turno; la conversación se recupera en el siguiente. Mitigado con reasignación por clave de campo.
- **El crawler no ejecuta JavaScript.** Sitios que renderizan en cliente devolverán poco contenido.
- **Sin autenticación.** El chat web es público por diseño (es un demo). No exponerlo con datos sensibles cargados.
- **Sin panel.** Los casos canalizados se leen en `data/routed/<tenant>.jsonl` o por correo.

## Siguiente iteración

Deliberadamente fuera de alcance por ahora:

- Panel web de onboarding (la config actual mapea 1:1 a un wizard).
- Bandeja humana con handoff y pausa del bot por conversación.
- Adapters `WEBHOOK` y `CRM` reales.
- Comprensión de imágenes y documentos entrantes.
- Aprendizaje de políticas con humano en el circuito: el dueño responde un gap → el sistema propone guardarlo → confirmación explícita antes de volverse verdad.
- Postgres + cola externa cuando haga falta más de una instancia.
