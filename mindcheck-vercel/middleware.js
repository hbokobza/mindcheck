// Psee — Middleware de pré-lancement v2 (token URL + cookie)
// 
// Première visite avec ?access=TOKEN → cookie de 30 jours posé
// Navigations suivantes : autorisées via cookie
// Sans cookie ni token → 404
//
// Configuration : Vercel > Environment Variables > PRELAUNCH_TOKEN
// Pour désactiver : supprimer ce fichier, push, Vercel redéploie

export const config = {
  matcher: '/((?!api/|assets/|apple-touch-icon|favicon|robots|sitemap).*)',
};

export default function middleware(request) {
  const url = new URL(request.url);
  const accessParam = url.searchParams.get('access');
  const cookie = request.cookies.get('psee_prelaunch');

  const validToken = process.env.PRELAUNCH_TOKEN || 'change-me-in-vercel';

  // Cookie déjà posé et valide → laisser passer
  if (cookie && cookie.value === validToken) {
    return;
  }

  // Token valide dans l'URL → poser le cookie et rediriger sans le param
  if (accessParam === validToken) {
    url.searchParams.delete('access');
    return new Response(null, {
      status: 302,
      headers: {
        'Location': url.toString(),
        'Set-Cookie': `psee_prelaunch=${validToken}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`,
      },
    });
  }

  // Aucun accès valide → 404 (on ne révèle même pas l'existence du site)
  return new Response('Page non trouvée', { status: 404 });
}
