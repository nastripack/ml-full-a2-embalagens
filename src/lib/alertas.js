export async function enviarAlertaFalha(env, contexto, erro) {
  if (!env.RESEND_API_KEY) return; // sem chave configurada, sem alerta (nao deve travar a sincronizacao)

  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: "ML Full A2 <alertas@smtp.nastripack.com.br>",
        to: [env.ALERT_EMAIL_TO || "andrenastri@gmail.com"],
        subject: `[ML Full A2] Falha na sincronizacao - ${contexto}`,
        html: `<p>A sincronizacao automatica falhou.</p><p><b>Contexto:</b> ${contexto}</p><p><b>Erro:</b> ${escapeHtml(erro?.message || String(erro))}</p>`
      })
    });
  } catch (e) {
    // Falha ao enviar o alerta nao deve derrubar o worker; so seguimos sem notificar.
  }
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
