// Psee — API d'authentification pré-lancement
// Valide le mot de passe et pose un cookie HttpOnly de 30 jours

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const { password } = req.body || {};
  const validPassword = process.env.PRELAUNCH_TOKEN;

  if (!validPassword) {
    console.error('[prelaunch-login] PRELAUNCH_TOKEN non défini dans les env vars');
    return res.status(500).json({ error: 'Configuration serveur manquante' });
  }

  if (password !== validPassword) {
    return res.status(401).json({ error: 'Mot de passe incorrect' });
  }

  // Pose le cookie de session pour 30 jours
  res.setHeader('Set-Cookie', `psee_prelaunch=${validPassword}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`);
  return res.status(200).json({ ok: true });
}
