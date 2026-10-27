// Sugestoes do Duplicador de Anuncios (anuncios.nastripack.com.br): anuncios ativos, fora do Full, que
// ja provaram que vendem (10+ vendas), por conta PJ. So leitura - o Duplicador calcula, aqui so se
// mostra. Chamada feita ao abrir a tela; se o Duplicador estiver fora do ar, avisa e nada mais quebra.
// Autenticacao: chave compartilhada (secret DUPLICADOR_API_KEY neste Worker = FULL_API_KEY no outro).

import { layout, escapeHtml, formatarMoeda } from "./dashboard.js";

const URL_DUPLICADOR = "https://anuncios.nastripack.com.br";

async function buscarSugestoes(env) {
  if (!env.DUPLICADOR_API_KEY) return { erro: "A chave DUPLICADOR_API_KEY não está configurada neste sistema." };
  try {
    const resp = await fetch(`${URL_DUPLICADOR}/api/full/sugestoes?por_conta=40`, {
      headers: { Authorization: `Bearer ${env.DUPLICADOR_API_KEY}` }
    });
    if (!resp.ok) return { erro: `O Duplicador respondeu ${resp.status}${resp.status === 401 ? " (chave não confere)" : ""}.` };
    return { dados: await resp.json() };
  } catch (err) {
    return { erro: `Não consegui falar com o Duplicador: ${err.message}` };
  }
}

export async function handleSugestoesDuplicador(request, env) {
  const url = new URL(request.url);
  const lojaVolta = url.searchParams.get("loja");
  const voltar = lojaVolta ? `/?loja=${encodeURIComponent(lojaVolta)}` : "/";
  const { dados, erro } = await buscarSugestoes(env);

  let corpo;
  if (erro) {
    corpo = `<div class="aviso" style="padding:0.8rem; border:1px solid #d97706; border-radius:8px;">${escapeHtml(erro)}</div>`;
  } else {
    const contas = dados.contas || [];
    corpo = `
      <p style="font-size:0.9rem; color:#666;">
        Anúncios <strong>ativos, fora do Full, com ${dados.criterio?.vendas_minimas || 10}+ vendas</strong>, só das contas PJ, do mais vendido para o menos.
        Vendas são o total acumulado do anúncio. <strong>Peso e dimensões não vêm do Duplicador</strong> — confira as medidas e as regras do Full antes de enviar.
        ${dados.varredura_mais_recente ? `Dados da varredura de ${escapeHtml(String(dados.varredura_mais_recente).slice(0, 16))} (UTC).` : ""}
      </p>
      ${contas.map(c => `
        <h2 style="margin-top:1.6rem;">${escapeHtml(c.nome)} <span style="font-size:0.8rem; font-weight:400; color:#666;">— ${c.anuncios_no_full} já no Full · ${c.candidatos_full.length} candidatos</span></h2>
        <div class="table-wrap"><table>
          <thead><tr><th>Anúncio</th><th>MLB</th><th>Vendas</th><th>Preço</th><th>Catálogo</th></tr></thead>
          <tbody>${c.candidatos_full.map(a => `<tr>
            <td><a href="${escapeHtml(a.permalink || "#")}" target="_blank" rel="noopener">${escapeHtml(a.titulo)}</a></td>
            <td>${escapeHtml(a.mlb)}</td><td>${a.vendas_total}</td><td>${formatarMoeda(a.preco)}</td><td>${a.catalogo ? "sim" : ""}</td></tr>`).join("") || `<tr><td colspan="5">Nenhum candidato nesta conta.</td></tr>`}</tbody>
        </table></div>`).join("")}`;
  }

  return new Response(layout("Sugestões do Duplicador", `
    <a class="voltar" href="${voltar}">&larr; Voltar ao dashboard</a>
    <h1>Sugestões do Duplicador para o Full</h1>
    ${corpo}`), { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
