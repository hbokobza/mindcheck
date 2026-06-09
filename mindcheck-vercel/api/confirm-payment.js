// api/confirm-payment.js
// Après paiement confirmé côté front :
//   1. Vérifie le PaymentIntent Stripe (anti-fraude)
//   2. Crée (ou active) le compte Supabase avec l'email
//   3. Envoie un email "Définissez votre mot de passe" via Supabase
//
// Env vars Vercel à configurer :
//   STRIPE_SECRET_KEY
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY  ← clé service (pas la clé anon !)

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { email, paymentIntentId } = req.body || {};
  if (!email || !paymentIntentId) {
    return res.status(400).json({ error: 'email et paymentIntentId requis' });
  }

  // ── 1. Vérifier le PaymentIntent ──────────────────────────
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  let pi;
  try {
    pi = await stripe.paymentIntents.retrieve(paymentIntentId);
  } catch (err) {
    return res.status(400).json({ error: 'PaymentIntent introuvable' });
  }

  if (pi.status !== 'succeeded') {
    return res.status(402).json({ error: 'Paiement non confirmé' });
  }

  // ── 2. Créer / activer le compte Supabase ─────────────────
  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY   // service key = droits admin
  );

  // Créer l'utilisateur Auth (email confirmé d'emblée)
  const tempPwd = Math.random().toString(36).slice(-8) + 'Aa1!'; // mot de passe temporaire
  const { data: authUser, error: authErr } = await sb.auth.admin.createUser({
    email,
    password: tempPwd,
    email_confirm: true,
  });

  // Si l'user existe déjà, on ignore l'erreur et on le réactive
  if (authErr && !authErr.message.includes('already registered')) {
    console.error('[supabase] createUser error:', authErr.message);
    return res.status(500).json({ error: authErr.message });
  }

  // Upsert dans la table `users` (à adapter à votre schéma)
  const { error: dbErr } = await sb.from('users').upsert({
    email,
    status: 'active',
    subscription_type: 'checkup',
    stripe_payment_intent: paymentIntentId,
    created_at: new Date().toISOString(),
    // subscription_end: null  → checkup one-shot, pas d'expiration
  }, { onConflict: 'email' });

  if (dbErr) {
    console.error('[supabase] upsert error:', dbErr.message);
    // Non-bloquant : le compte Auth est créé, on continue
  }

  // ── 3. Envoyer le lien "Définir mon mot de passe" ─────────
  // L'utilisateur reçoit UN email (pour définir son MDP), pas un magic link quotidien
  try {
    await sb.auth.admin.generateLink({
      type: 'recovery',   // lien reset-password → "définissez votre MDP"
      email,
    });
    // Note : generateLink renvoie le lien mais ne l'envoie pas automatiquement.
    // Pour l'envoi automatique, configurer un email template dans Supabase Dashboard
    // → Authentication → Email Templates → "Reset Password"
    // OU utiliser sb.auth.resetPasswordForEmail(email) qui envoie l'email directement :
    await sb.auth.resetPasswordForEmail(email, {
      redirectTo: 'https://bilanpsy.fr/login.html'
    });
  } catch (e) {
    console.error('[supabase] sendResetEmail error:', e.message);
    // Non-bloquant
  }

  res.status(200).json({ success: true });
}
