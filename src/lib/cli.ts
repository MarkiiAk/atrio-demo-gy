import * as readline from 'readline';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

const wrap = (code: string) => (s: string) => (useColor ? `[${code}m${s}[0m` : s);

export const c = {
  bold: wrap('1'),
  dim: wrap('2'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  cyan: wrap('36'),
  gray: wrap('90'),
};

export function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

export function heading(title: string): void {
  out();
  out(c.bold(title));
  out(c.gray('─'.repeat(Math.max(8, title.length))));
}

export function ok(msg: string): void {
  out(`${c.green('✓')} ${msg}`);
}

export function warn(msg: string): void {
  out(`${c.yellow('!')} ${msg}`);
}

export function fail(msg: string): void {
  out(`${c.red('✗')} ${msg}`);
}

/** Argumentos posicionales tras `npm run <script> --`. */
export function positionals(): string[] {
  return process.argv.slice(2).filter((a) => !a.startsWith('--'));
}

export function flag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

export function option(name: string, dflt?: string): string | undefined {
  const args = process.argv.slice(2);
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
  const inline = args.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  return dflt;
}

export function requireTenantArg(scriptName: string): string {
  const [tenantId] = positionals();
  if (!tenantId) {
    fail(`Falta el tenant. Uso: npm run ${scriptName} -- <tenant-id>`);
    process.exit(1);
  }
  return tenantId;
}

export function createPrompt(): {
  ask: (question: string, dflt?: string) => Promise<string>;
  close: () => void;
} {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask: (question: string, dflt?: string) =>
      new Promise<string>((resolve) => {
        const suffix = dflt ? c.gray(` [${dflt}]`) : '';
        rl.question(`${question}${suffix}: `, (answer) => resolve(answer.trim() || dflt || ''));
      }),
    close: () => rl.close(),
  };
}

export function die(message: string, error?: unknown): never {
  fail(message);
  if (error) out(c.gray(String((error as Error)?.message ?? error)));
  process.exit(1);
}
