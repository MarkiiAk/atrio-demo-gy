import { describe, expect, it } from 'vitest';


import * as fs from 'fs';
import * as path from 'path';
import { onboardingDir } from './helpers/env';
import { writeTenant } from './helpers/fixtures';
import { clearTenantCache, listTenants, loadTenantConfig, requireTenantConfig, tenantExists } from '../src/tenants/tenant-loader';
import { findTodos, summarizeIssues, validateTenant } from '../src/tenants/tenant-validator';
import { TODO_SENTINEL, isTodo } from '../src/tenants/config-schema';

describe('carga de configuración de tenant', () => {
  it('carga los cinco YAML y expone el tenant', () => {
    writeTenant('acme');
    clearTenantCache();

    expect(tenantExists('acme')).toBe(true);
    const { config, issues } = loadTenantConfig('acme');

    expect(issues.filter((i) => i.severity === 'ERROR')).toEqual([]);
    expect(config?.company.company.name).toBe('Empresa de Prueba');
    expect(Object.keys(config!.workflows.workflows)).toContain('SALES_QUOTE');
    expect(config?.personality.base.pronoun_style).toBe('usted');
  });

  it('rechaza que company.id no coincida con la carpeta', () => {
    writeTenant('desalineado', {
      company: `company:
  id: otro-id
  name: "X"
assistant:
  display_name: "A"
channels:
  whatsapp:
    enabled: false
`,
    });
    clearTenantCache();

    const { config, issues } = loadTenantConfig('desalineado');
    expect(config).toBeNull();
    expect(issues.some((i) => i.path === 'company.id')).toBe(true);
  });

  it('reporta YAML mal formado sin lanzar', () => {
    const dir = path.join(onboardingDir(), 'roto');
    writeTenant('roto');
    fs.writeFileSync(path.join(dir, 'workflows.yaml'), 'workflows:\n  - [esto: no\n   cierra', 'utf8');
    clearTenantCache();

    const { config, issues } = loadTenantConfig('roto');
    expect(config).toBeNull();
    expect(issues.some((i) => i.file === 'workflows.yaml')).toBe(true);
  });

  it('requireTenantConfig lanza cuando hay errores', () => {
    writeTenant('malo', {
      personality: `base:\n  style: []\n`,
    });
    clearTenantCache();
    expect(() => requireTenantConfig('malo')).toThrow();
  });

  it('lista sólo carpetas que son tenants reales', () => {
    fs.mkdirSync(path.join(onboardingDir(), 'carpeta-vacia'), { recursive: true });
    clearTenantCache();
    const tenants = listTenants();
    expect(tenants).toContain('acme');
    expect(tenants).not.toContain('carpeta-vacia');
  });
});

describe('aislamiento entre tenants', () => {
  it('dos tenants no comparten configuración', () => {
    writeTenant('uno');
    writeTenant('dos', {
      company: `company:
  id: dos
  name: "Segunda Empresa"
assistant:
  display_name: "Asistente Dos"
  locale: es-MX
channels:
  whatsapp:
    enabled: true
    from: "whatsapp:+15550000002"
`,
    });
    clearTenantCache();

    const a = requireTenantConfig('uno');
    const b = requireTenantConfig('dos');

    expect(a.company.company.name).not.toBe(b.company.company.name);
    expect(a.company.channels.whatsapp.from).not.toBe(b.company.channels.whatsapp.from);
    expect(a.dir).not.toBe(b.dir);
  });
});

describe('validación semántica cruzada', () => {
  it('detecta un departamento inexistente', () => {
    writeTenant('sin-depto', {
      workflows: `workflows:
  OTRO_FLUJO:
    enabled: true
    department: NO_EXISTE
    strategy: collect_then_route
    intents: [SALES_QUOTE]
    fields:
      essential: [a]
      useful: []
      optional: []
    field_labels:
      a: "campo a"
    routing:
      require_all_essential: true
      satisfied_by_channel: []
    cannot_do: []
`,
    });
    clearTenantCache();

    const config = requireTenantConfig('sin-depto');
    const issues = validateTenant(config, 'demo');
    expect(
      issues.some((i) => i.severity === 'ERROR' && i.message.includes('no existe en departments.yaml')),
    ).toBe(true);
  });

  it('prohíbe que un adapter LOG confirme entrega al equipo', () => {
    writeTenant('log-mentiroso', {
      routing: `routing:
  SALES:
    type: LOG
    to: []
    confirmation_semantics: DELIVERED_TO_TEAM
  CUSTOMER_SERVICE:
    type: LOG
    to: []
    confirmation_semantics: REGISTERED_ONLY
`,
    });
    clearTenantCache();

    const issues = validateTenant(requireTenantConfig('log-mentiroso'), 'demo');
    expect(
      issues.some(
        (i) => i.severity === 'ERROR' && i.message.includes('haría que el asistente mienta'),
      ),
    ).toBe(true);
  });

  it('detecta campos duplicados entre niveles', () => {
    writeTenant('dupes', {
      workflows: `workflows:
  OTRO_FLUJO:
    enabled: true
    department: SALES
    strategy: collect_then_route
    intents: [SALES_QUOTE]
    fields:
      essential: [producto]
      useful: [producto]
      optional: []
    field_labels:
      producto: "producto"
    routing:
      require_all_essential: true
      satisfied_by_channel: []
    cannot_do: []
`,
    });
    clearTenantCache();

    const issues = validateTenant(requireTenantConfig('dupes'), 'demo');
    expect(issues.some((i) => i.message.includes('más de un nivel'))).toBe(true);
  });
});

describe('detección de TODOs de onboarding', () => {
  const withTodo = {
    workflows: `workflows:
  SALES_QUOTE:
    enabled: true
    department: SALES
    strategy: collect_then_route
    intents: [SALES_QUOTE]
    fields:
      essential: [product]
      useful: []
      optional: []
    field_labels:
      product: "${TODO_SENTINEL}: cómo llamamos a esto"
    routing:
      require_all_essential: true
      satisfied_by_channel: []
    cannot_do: []
`,
  };

  it('isTodo reconoce el sentinel', () => {
    expect(isTodo(`${TODO_SENTINEL}: falta`)).toBe(true);
    expect(isTodo('valor normal')).toBe(false);
    expect(isTodo(undefined)).toBe(false);
  });

  it('en demo es aviso; en production es error', () => {
    writeTenant('pendiente', withTodo);
    clearTenantCache();
    const config = requireTenantConfig('pendiente');

    const demo = findTodos(config, 'demo');
    const prod = findTodos(config, 'production');

    expect(demo.length).toBeGreaterThan(0);
    expect(demo.every((i) => i.severity === 'WARNING')).toBe(true);
    expect(prod.some((i) => i.severity === 'ERROR')).toBe(true);
  });

  it('un TODO en workflow deshabilitado no rompe production', () => {
    writeTenant('apagado', {
      workflows: withTodo.workflows.replace('enabled: true', 'enabled: false'),
    });
    clearTenantCache();

    const prod = findTodos(requireTenantConfig('apagado'), 'production');
    expect(prod.some((i) => i.severity === 'ERROR' && i.file === 'workflows.yaml')).toBe(false);
  });

  it('summarizeIssues cuenta por severidad', () => {
    const s = summarizeIssues([
      { severity: 'ERROR', file: 'a', path: '', message: '' },
      { severity: 'WARNING', file: 'b', path: '', message: '' },
      { severity: 'WARNING', file: 'c', path: '', message: '' },
    ]);
    expect(s).toEqual({ errors: 1, warnings: 2 });
  });
});
