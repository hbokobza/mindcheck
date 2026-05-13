// Psee — Middleware de pré-lancement v3 (page de login + cookie)
//
// Sans cookie valide → redirection vers /login.html
// Avec cookie valide → accès au site
//
// Configuration : Vercel > Environment Variables > PRELAUNCH_TOKEN
// Désactivation : supprimer ce fichier, push, Vercel redéploie

export const config = {
  matcher: '/((?!api/|assets/|login\\.html|apple-touch-icon|favicon|robots|sitemap).*)',
};

function parseCookies(cookieHeader) {
  if (!cookieHeader) return {};
  const cookies = {};
  cookieHeader.split(';').forEach((cookie) => {
    const [name, ...rest] = cookie.trim().split('=');
    if (name) cookies[name] = rest.join('=');
  });
  return cookies;
}

export default function middleware(request) {
  const cookies = parseCookies(request.headers.get('cookie'));
  const validToken = process.env.PRELAUNCH_TOKEN || 'change-me-in-vercel';

  // Cookie valide → laisser passer
  if (cookies.psee_prelaunch === validToken) {
    return;
  }

  // Sinon → redirection vers la page de login
  const url = new URL(request.url);
  url.pathname = '/login.html';
  url.search = '';
  return Response.redirect(url.toString(), 302);
}
