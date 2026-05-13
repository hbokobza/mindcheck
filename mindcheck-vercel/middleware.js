// Psee — Middleware d'authentification pour le pré-lancement
// Protège tout le site par HTTP Basic Auth, SAUF :
//   - /api/*                    : routes backend (chat Claude)
//   - /assets/*                 : ressources statiques (icônes, manifest, images)
//   - apple-touch-icon*         : icônes iOS à la racine
//   - favicon*                  : favicons à la racine
//   - robots.txt, sitemap.xml   : fichiers SEO (utiles dès maintenant pour test crawl)
//
// Pourquoi exclure les assets ? iOS Safari fait des requêtes en mode CORS pour
// le manifest et les icônes (Add to Home Screen), et n'envoie pas les credentials
// Basic Auth dans ce mode. Résultat : 401 silencieux et icône fallback générique.
// Les assets statiques sont publics par nature, donc on les autorise sans auth.
//
// Pour modifier l'identifiant ou le mot de passe :
//   Vercel Dashboard > Project Settings > Environment Variables
//   PRELAUNCH_USER     : nom d'utilisateur (par défaut "psee")
//   PRELAUNCH_PASSWORD : mot de passe (par défaut "lancement-2026")
//
// Pour DÉSACTIVER totalement la protection après le lancement :
//   1. Supprimer ce fichier middleware.js du repo
//   2. Pousser sur GitHub → Vercel redéploie automatiquement
//   Ou plus simple : renommer en middleware.js.bak

export const config = {
  // On protège toutes les routes SAUF celles listées en lookahead négatif.
  matcher: '/((?!api/|assets/|apple-touch-icon|favicon|robots|sitemap).*)',
};

export default function middleware(request) {
  const basicAuth = request.headers.get('authorization');

  if (basicAuth) {
    const authValue = basicAuth.split(' ')[1];
    const [user, password] = atob(authValue).split(':');

    const validUser = process.env.PRELAUNCH_USER || 'psee';
    const validPassword = process.env.PRELAUNCH_PASSWORD || 'lancement-2026';

    if (user === validUser && password === validPassword) {
      // Authentification OK : Vercel sert normalement le fichier (index.html, pro.html, etc.)
      return;
    }
  }

  // Pas d'authentification ou identifiants invalides : on demande au navigateur de prompter.
  return new Response('Authentification requise', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Psee"',
    },
  });
}
