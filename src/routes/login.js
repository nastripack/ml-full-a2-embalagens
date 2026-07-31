import { criarToken, cookieDeSessao, cookieDeLogout } from "../lib/sessao.js";

const DOMINIO_COOKIE = ".nastripack.com.br";
const HOST_DASHBOARD = "full.nastripack.com.br";

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function paginaLogin(erro, redirect) {
  return `<!doctype html>
<html lang="pt-br">
<head>
<meta charset="utf-8">
<title>Login - ML Full</title>
<style>
  body { font-family: system-ui, sans-serif; background: #f5f5f5; margin: 0; height: 100vh; display: flex; align-items: center; justify-content: center; }
  .caixa { background: white; border-radius: 12px; padding: 2.5rem; box-shadow: 0 2px 10px rgba(0,0,0,0.1); width: 100%; max-width: 340px; }
  h1 { font-size: 1.2rem; margin: 0 0 1.5rem; text-align: center; }
  label { display: block; font-size: 0.85rem; color: #444; margin-bottom: 0.25rem; margin-top: 1rem; }
  input { width: 100%; padding: 0.6rem 0.75rem; border: 1px solid #ccc; border-radius: 6px; font-size: 1rem; box-sizing: border-box; }
  button { width: 100%; margin-top: 1.5rem; padding: 0.7rem; background: #1a56db; color: white; border: none; border-radius: 6px; font-size: 1rem; cursor: pointer; }
  button:hover { background: #1642ad; }
  .erro { background: #fde2e1; color: #a31510; padding: 0.6rem 0.75rem; border-radius: 6px; font-size: 0.85rem; margin-top: 1rem; }
</style>
</head>
<body>
  <form class="caixa" method="POST" action="/login">
    <h1>ML Full - A2 Embalagens</h1>
    ${erro ? `<div class="erro">${escapeHtml(erro)}</div>` : ""}
    <input type="hidden" name="redirect" value="${escapeHtml(redirect || "")}">
    <label for="email">E-mail</label>
    <input type="email" id="email" name="email" required autofocus>
    <label for="senha">Senha</label>
    <input type="password" id="senha" name="senha" required>
    <button type="submit">Entrar</button>
  </form>
</body>
</html>`;
}

export async function handleLoginPage(request, env) {
  const url = new URL(request.url);
  const redirect = url.searchParams.get("redirect") || "";
  return new Response(paginaLogin(null, redirect), { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export async function handleLoginSubmit(request, env) {
  const form = await request.formData();
  const email = String(form.get("email") || "").trim();
  const senha = String(form.get("senha") || "");
  const redirect = String(form.get("redirect") || "");

  if (email !== env.LOGIN_EMAIL || senha !== env.LOGIN_SENHA) {
    return new Response(paginaLogin("E-mail ou senha incorretos.", redirect), {
      status: 401,
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  }

  const token = await criarToken(env, email);
  const destino = redirect && redirect.startsWith("/")
    ? `https://${HOST_DASHBOARD}${redirect}`
    : `https://${HOST_DASHBOARD}/`;

  return new Response(null, {
    status: 302,
    headers: {
      "Location": destino,
      "Set-Cookie": cookieDeSessao(token, DOMINIO_COOKIE)
    }
  });
}

export async function handleLogout(request, env) {
  return new Response(null, {
    status: 302,
    headers: {
      "Location": "https://full2.nastripack.com.br/login",
      "Set-Cookie": cookieDeLogout(DOMINIO_COOKIE)
    }
  });
}
