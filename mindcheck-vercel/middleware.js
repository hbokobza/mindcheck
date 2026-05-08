// Psee — Middleware d'authentification pour le pré-lancement
// Protège tout le site par HTTP Basic Auth, sauf les routes /api/* qui restent accessibles
// (nécessaire pour que le chat Claude continue de fonctionner pendant les tests internes).
//
// Pour modifier l'identifiant ou le mot de passe :
//   Vercel Dashboard > Project Settings > Environment Variables
//   PRELAUNCH_USER     : nom d'utilisateur (par défaut "psee")
//   PRELAUNCH_PASSWORD : mot de passe (par défaut "lancement-2026")
//
// Pour DÉSACTIVER la protection après le lancement :
//   1. Supprimer ce fichier middleware.js du repo
//   2. Pousser sur GitHub → Vercel redéploie automatiquement
//   Ou plus simple : renommer en middleware.js.bak

export const config = {
  // On protège toutes les routes SAUF /api/* (les fonctions backend).
  matcher: '/((?!api/).*)',
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
