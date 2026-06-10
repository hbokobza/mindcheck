// api/payment.js — fonction unique Stripe + Supabase
// Gère deux actions via req.body.action :
//   "create-intent" → crée le PaymentIntent, retourne clientSecret
//   "confirm"       → vérifie le paiement et crée le compte Supabase
//
// Variables d'environnement Vercel :
//   STRIPE_SECRET_KEY
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { action } = req.body || {};

  // ── ACTION 1 : créer le PaymentIntent ─────────────────────
  if (action === 'create-intent') {
    const { amount = 3900, currency = 'eur' } = req.body;
    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      const pi = await stripe.paymentIntents.create({
        amount,
        currency,
        automatic_payment_methods: { enabled: true },
        metadata: { product: 'bilanpsy-checkup' }
      });
      return res.status(200).json({ clientSecret: pi.client_secret });
    } catch (err) {
      console.error('[payment] create-intent error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── ACTION 2 : confirmer le paiement + créer compte ───────
  if (action === 'confirm') {
    const { email, paymentIntentId } = req.body;
    if (!email || !paymentIntentId)
      return res.status(400).json({ error: 'email et paymentIntentId requis' });

    // Vérifier le paiement Stripe
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    let pi;
    try {
      pi = await stripe.paymentIntents.retrieve(paymentIntentId);
    } catch (err) {
      return res.status(400).json({ error: 'PaymentIntent introuvable' });
    }
    if (pi.status !== 'succeeded')
      return res.status(402).json({ error: 'Paiement non confirmé' });

    // Créer / activer le compte Supabase
    const sb = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );
    const tempPwd = Math.random().toString(36).slice(-8) + 'Aa1!';
    const { error: authErr } = await sb.auth.admin.createUser({
      email,
      password: tempPwd,
      email_confirm: true,
    });
    if (authErr && !authErr.message.includes('already registered')) {
      console.error('[payment] createUser error:', authErr.message);
      return res.status(500).json({ error: authErr.message });
    }

    // Upsert dans la table users
    await sb.from('users').upsert({
      email,
      status: 'active',
      subscription_type: 'checkup',
      stripe_payment_intent: paymentIntentId,
      created_at: new Date().toISOString(),
    }, { onConflict: 'email' });

    // Envoyer email "Définissez votre mot de passe"
    try {
      await sb.auth.resetPasswordForEmail(email, {
        redirectTo: 'https://bilanpsy.fr/login.html'
      });
    } catch (e) {
      console.error('[payment] resetPassword error:', e.message);
    }

    return res.status(200).json({ success: true });
  }

  return res.status(400).json({ error: 'action invalide' });
}
