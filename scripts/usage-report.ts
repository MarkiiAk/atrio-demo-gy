import { getDb } from '../src/db';
import { c, die, heading, option, out, requireTenantArg } from '../src/lib/cli';
import { buildUsageReport } from '../src/usage/usage.service';
import { loadTenantConfig, tenantExists } from '../src/tenants/tenant-loader';

function row(label: string, value: string | number): void {
  out(`  ${label.padEnd(22)} ${String(value)}`);
}

function main(): void {
  const tenantId = requireTenantArg('usage:report');
  if (!tenantExists(tenantId)) die(`No existe el tenant "${tenantId}"`);
  getDb();

  const days = Number.parseInt(option('days', '30') as string, 10);
  const { config } = loadTenantConfig(tenantId);
  const report = buildUsageReport(tenantId, days);

  heading(`Consumo — ${config?.company.company.name ?? tenantId}`);
  row('Periodo', `últimos ${days} días`);
  out();
  row('Conversaciones', report.conversations);
  row('Mensajes inbound', report.inboundMessages);
  row('Mensajes outbound', report.outboundMessages);
  out();
  row('Llamadas a OpenAI', report.openaiCalls);
  row('Input tokens', report.inputTokens);
  row('Output tokens', report.outputTokens);
  row('Total tokens', report.totalTokens);
  out();
  row('Latencia media', `${report.avgLatencyMs} ms`);
  row('Latencia p95', `${report.p95LatencyMs} ms`);

  if (report.byModel.length > 0) {
    out();
    out(c.bold('  Por modelo'));
    for (const m of report.byModel) {
      out(`    ${m.model.padEnd(24)} ${String(m.calls).padStart(5)} llamadas   ${m.totalTokens} tokens`);
    }
  }

  const perConv =
    report.conversations > 0 ? Math.round(report.totalTokens / report.conversations) : 0;
  out();
  out(c.bold('  Derivados'));
  row('Tokens / conversación', perConv);
  row(
    'Llamadas / mensaje in',
    report.inboundMessages > 0 ? (report.openaiCalls / report.inboundMessages).toFixed(2) : '0',
  );

  out();
  out(
    c.gray(
      '  No se calculan importes: los precios de OpenAI y Twilio cambian y hardcodearlos daría números falsos.',
    ),
  );
  out(c.gray('  Multiplica estos tokens por la tarifa vigente de tu modelo para obtener el costo real.'));
  out();
}

main();
