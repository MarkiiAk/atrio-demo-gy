import * as fs from 'fs';
import * as path from 'path';
import { env } from '../config/env';
import { tenantDir } from '../tenants/tenant-loader';
import {
  ALL_WORKFLOW_KEYS,
  DEFAULT_DEPARTMENTS,
  WORKFLOW_LIBRARY,
  companyYaml,
  departmentsYaml,
  knowledgeReadme,
  personalityYaml,
  readmeMd,
  routingYaml,
  workflowsYaml,
  type WizardAnswers,
} from './templates';

export interface ScaffoldResult {
  dir: string;
  created: string[];
  skipped: string[];
}

export function defaultAnswers(tenantId: string): WizardAnswers {
  return {
    tenantId,
    companyName: tenantId,
    assistantName: `Asistente de ${tenantId}`,
    locale: 'es-MX',
    website: '',
    pronounStyle: 'usted',
    departments: Object.keys(DEFAULT_DEPARTMENTS),
    workflows: ALL_WORKFLOW_KEYS,
    routingType: 'LOG',
    routingTo: '',
  };
}

/**
 * Crea la estructura de un tenant nuevo. Nunca sobrescribe: si un archivo ya
 * existe se reporta como omitido y el llamador decide.
 */
export function scaffoldTenant(answers: WizardAnswers, force = false): ScaffoldResult {
  const dir = tenantDir(answers.tenantId);
  const created: string[] = [];
  const skipped: string[] = [];

  // Los departamentos efectivos son los que algún workflow habilitado necesita,
  // más los que el usuario eligió explícitamente.
  const needed = new Set(answers.departments);
  for (const key of answers.workflows) {
    const wf = WORKFLOW_LIBRARY[key];
    if (wf) needed.add(wf.department);
  }
  const departments = [...needed];

  const files: Array<[string, string]> = [
    ['company.yaml', companyYaml(answers)],
    ['personality.yaml', personalityYaml(answers, answers.workflows)],
    ['departments.yaml', departmentsYaml(departments)],
    ['workflows.yaml', workflowsYaml(answers.workflows)],
    ['routing.yaml', routingYaml(answers, departments)],
    ['README.md', readmeMd(answers)],
    [path.join('knowledge', 'public', 'README.md'), knowledgeReadme('public', answers.companyName)],
    [
      path.join('knowledge', 'customer-safe', 'README.md'),
      knowledgeReadme('customer-safe', answers.companyName),
    ],
  ];

  fs.mkdirSync(path.join(dir, 'knowledge', 'public'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'knowledge', 'customer-safe'), { recursive: true });

  for (const [rel, content] of files) {
    const full = path.join(dir, rel);
    if (fs.existsSync(full) && !force) {
      skipped.push(rel);
      continue;
    }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
    created.push(rel);
  }

  return { dir, created, skipped };
}

export function onboardingRootExists(): boolean {
  return fs.existsSync(env.ONBOARDING_DIR);
}
