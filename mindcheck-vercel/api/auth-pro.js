import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ ok: false, error: 'Email et mot de passe requis.' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    console.error('[auth-pro] Variables Supabase manquantes');
    return res.status(500).json({ ok: false, error: 'Configuration serveur incorrecte.' });
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey);

  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error || !data?.session) {
      console.warn('[auth-pro] Echec authentification:', error?.message);
      return res.status(401).json({ ok: false, error: 'Identifiants incorrects.' });
    }

    const supabaseAdmin = createClient(supabaseUrl, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data: praticien, error: praticienError } = await supabaseAdmin
      .from('praticiens')
      .select('nom, specialite, abonnement_actif, code, is_beta')
      .eq('email', email)
      .single();

    if (praticienError || !praticien) {
      console.warn('[auth-pro] Praticien non trouvé dans praticiens:', email);
      return res.status(403).json({ ok: false, error: 'Accès non autorisé. Contactez bilanpsy pro.' });
    }

    if (!praticien.abonnement_actif) {
      return res.status(403).json({ ok: false, error: 'Votre accès a été désactivé. Contactez bilanpsy pro.' });
    }

    return res.status(200).json({
      ok: true,
      token: data.session.access_token,
      praticienNom: praticien.nom,
      praticienCode: praticien.code,
      specialite: praticien.specialite,
      isBeta: praticien.is_beta,
      email: email
    });

  } catch (err) {
    console.error('[auth-pro] Erreur inattendue:', err.message);
    return res.status(500).json({ ok: false, error: 'Erreur serveur. Réessayez dans un instant.' });
  }
}
