// Sessao de login simples (uma credencial de admin compartilhada, nao multiusuario).
// Token assinado com HMAC-SHA256 para que o cookie nao possa ser forjado sem o SESSION_SECRET.

const DIAS_SESSAO = 400; // teto real aceito pelos navegadores para duracao de cookie

function bufferParaBase64(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}

// Comparacao em tempo constante - evita vazar, por tempo de resposta, quantos caracteres da
// assinatura estao corretos (ataque de timing). Sempre percorre os dois strings por completo.
function compararEmTempoConstante(a, b) {
  if (a.length !== b.length) return false;
  let diferenca = 0;
  for (let i = 0; i < a.length; i++) {
    diferenca |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diferenca === 0;
}

async function assinar(dado, segredo) {
  const chave = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(segredo),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const assinatura = await crypto.subtle.sign("HMAC", chave, new TextEncoder().encode(dado));
  return bufferParaBase64(assinatura);
}

export async function criarToken(env, email) {
  const expira = Date.now() + DIAS_SESSAO * 24 * 60 * 60 * 1000;
  const payload = `${email}:${expira}`;
  const payloadB64 = btoa(payload);
  const assinatura = await assinar(payload, env.SESSION_SECRET);
  return `${payloadB64}.${assinatura}`;
}

export async function verificarToken(env, token) {
  if (!token) return null;
  const [payloadB64, assinatura] = token.split(".");
  if (!payloadB64 || !assinatura) return null;

  let payload;
  try {
    payload = atob(payloadB64);
  } catch {
    return null;
  }

  const assinaturaEsperada = await assinar(payload, env.SESSION_SECRET);
  if (!compararEmTempoConstante(assinaturaEsperada, assinatura)) return null; // token adulterado ou assinado com outro segredo

  const [email, expiraStr] = payload.split(":");
  const expira = Number(expiraStr);
  if (!email || !expira || Date.now() > expira) return null;

  return { email };
}

export function lerCookie(request, nome) {
  const cabecalho = request.headers.get("Cookie") || "";
  const partes = cabecalho.split(";").map(p => p.trim());
  for (const parte of partes) {
    const [chave, ...resto] = parte.split("=");
    if (chave === nome) return resto.join("=");
  }
  return null;
}

export function cookieDeSessao(token, dominio) {
  const maxAge = DIAS_SESSAO * 24 * 60 * 60;
  return `sessao=${token}; Domain=${dominio}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function cookieDeLogout(dominio) {
  return `sessao=; Domain=${dominio}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
