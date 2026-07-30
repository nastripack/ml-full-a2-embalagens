import { buildAuthorizationUrl, exchangeCodeForToken, getUser } from "../lib/mercadolivre.js";
import { upsertLoja } from "../lib/db.js";

export async function handleLogin(request, env) {
  return Response.redirect(buildAuthorizationUrl(env), 302);
}

export async function handleCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const errorParam = url.searchParams.get("error");

  if (errorParam) {
    return new Response(`Autorizacao negada pelo Mercado Livre: ${errorParam}`, { status: 400 });
  }
  if (!code) {
    return new Response("Parametro 'code' ausente no callback.", { status: 400 });
  }

  const token = await exchangeCodeForToken(env, code);
  const user = await getUser(token.access_token);
  const expiresAt = new Date(Date.now() + token.expires_in * 1000).toISOString();

  await env.DB.prepare(
    `INSERT INTO ml_auth (loja_id, access_token, refresh_token, expires_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(loja_id) DO UPDATE SET
       access_token = excluded.access_token,
       refresh_token = excluded.refresh_token,
       expires_at = excluded.expires_at,
       atualizado_em = datetime('now')`
  ).bind(String(user.id), token.access_token, token.refresh_token, expiresAt).run();

  await upsertLoja(env.DB, String(user.id), user.nickname);

  return Response.redirect(`${env.ML_REDIRECT_URI.replace("/auth/callback", "")}/?loja=${user.id}&recem_conectado=1`, 302);
}
