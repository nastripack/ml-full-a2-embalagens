// Pagina de saude do sistema (operacional, nao e o dashboard de negocio): mostra as ultimas
// sincronizacoes, duracao, erros e ha quanto tempo cada loja nao atualiza - ajuda a perceber
// um cron parado ou uma API quebrada antes do usuario notar dado desatualizado.

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

const LIMITE_FRESCOR_HORAS = 2; // cron roda de hora em hora - mais que isso sem sincronizar e sinal de alerta

export async function handleSaude(request, env) {
  const db = env.DB;

  const lojas = await db.prepare("SELECT loja_id, nickname FROM lojas WHERE ativo = 1 ORDER BY nickname").all();

  const ultimaPorLoja = {};
  for (const loja of lojas.results || []) {
    const evento = await db.prepare(
      "SELECT data_hora, payload_json FROM eventos WHERE loja_id = ? AND tipo = 'sincronizacao_concluida' ORDER BY data_hora DESC LIMIT 1"
    ).bind(loja.loja_id).first();
    ultimaPorLoja[loja.loja_id] = evento;
  }

  const recentes = await db.prepare(
    `SELECT e.loja_id, l.nickname, e.data_hora, e.payload_json
     FROM eventos e
     LEFT JOIN lojas l ON l.loja_id = e.loja_id
     WHERE e.tipo = 'sincronizacao_concluida'
     ORDER BY e.data_hora DESC
     LIMIT 30`
  ).all();

  const cardsLojas = (lojas.results || []).map(loja => {
    const evento = ultimaPorLoja[loja.loja_id];
    if (!evento) {
      return `<div class="card card-alerta">
        <div class="label">${escapeHtml(loja.nickname || loja.loja_id)}</div>
        <div class="value" style="font-size:1rem">nunca sincronizou</div>
      </div>`;
    }
    const horasAtras = (Date.now() - new Date(evento.data_hora.replace(" ", "T") + "Z").getTime()) / 3600000;
    const stale = horasAtras > LIMITE_FRESCOR_HORAS;
    return `<div class="card ${stale ? "card-alerta" : "card-ok"}">
      <div class="label">${escapeHtml(loja.nickname || loja.loja_id)}</div>
      <div class="value" style="font-size:1rem">${stale ? "⚠️ " : "✅ "}${escapeHtml(evento.data_hora)}</div>
    </div>`;
  }).join("");

  const linhasRecentes = (recentes.results || []).map(r => {
    let payload = {};
    try { payload = JSON.parse(r.payload_json); } catch { /* ignora payload malformado */ }
    const duracaoS = payload.tempos_ms?.performance ? (payload.tempos_ms.performance / 1000).toFixed(1) : "-";
    const numErros = (payload.erros || []).length;
    return `<tr>
      <td>${escapeHtml(r.nickname || r.loja_id)}</td>
      <td>${escapeHtml(r.data_hora)}</td>
      <td>${duracaoS}s</td>
      <td>${payload.skus_atualizados ?? "-"}</td>
      <td>${payload.vendas_analisadas ?? "-"}</td>
      <td>${payload.estoque_atualizado ?? "-"}</td>
      <td>${payload.remessas_encontradas ?? "-"}</td>
      <td>${payload.performance_atualizada ?? "-"}</td>
      <td>${numErros > 0 ? `<span class="badge badge-critico">${numErros}</span>` : "0"}</td>
    </tr>`;
  }).join("");

  const html = `<!doctype html>
<html lang="pt-br">
<head>
<meta charset="utf-8">
<title>Saude do Sistema - ML Full</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; background: #f5f5f5; color: #1a1a1a; }
  h1 { font-size: 1.4rem; }
  a { color: #1a56db; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .voltar { display: inline-block; margin-bottom: 1rem; font-size: 0.9rem; }
  .cards { display: flex; gap: 1rem; margin-bottom: 2rem; flex-wrap: wrap; }
  .card { background: white; border-radius: 8px; padding: 1rem 1.5rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1); border-left: 4px solid #ccc; }
  .card-ok { border-left-color: #22c55e; }
  .card-alerta { border-left-color: #ef4444; }
  .card .label { font-size: 0.8rem; color: #666; }
  .card .value { font-size: 1.6rem; font-weight: 600; }
  .table-wrap { overflow-x: auto; margin-bottom: 2rem; }
  table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; }
  th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid #eee; font-size: 0.9rem; }
  th { background: #fafafa; }
  .badge { display: inline-block; padding: 0.15rem 0.6rem; border-radius: 999px; font-size: 0.78rem; font-weight: 600; }
  .badge-critico { background: #fde2e1; color: #a31510; }
</style>
</head>
<body>
  <a class="voltar" href="/">&larr; Voltar ao dashboard</a>
  <h1>Saude do Sistema</h1>
  <div class="cards">${cardsLojas || '<div class="card">Nenhuma loja conectada.</div>'}</div>

  <h2>Ultimas 30 sincronizacoes (todas as lojas)</h2>
  <div class="table-wrap"><table>
    <thead><tr>
      <th>Loja</th><th>Quando</th><th>Duracao</th><th>SKUs</th><th>Vendas</th>
      <th>Estoque</th><th>Remessas</th><th>Performance</th><th>Erros</th>
    </tr></thead>
    <tbody>${linhasRecentes || '<tr><td colspan="9">Nenhuma sincronizacao registrada ainda.</td></tr>'}</tbody>
  </table></div>
</body>
</html>`;

  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
