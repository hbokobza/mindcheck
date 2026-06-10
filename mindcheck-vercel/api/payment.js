// api/payment.js — CommonJS (compatible tous projets Vercel)
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
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

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    let pi;
    try {
      pi = await stripe.paymentIntents.retrieve(paymentIntentId);
    } catch (err) {
      return res.status(400).json({ error: 'PaymentIntent introuvable' });
    }
    if (pi.status !== 'succeeded')
      return res.status(402).json({ error: 'Paiement non confirmé' });

    const sb = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const tempPwd = Math.random().toString(36).slice(-8) + 'Aa1!';
    await sb.auth.admin.createUser({
      email,
      password: tempPwd,
      email_confirm: true,
    }).catch(() => {});

    await sb.from('users').upsert({
      email,
      status: 'active',
      subscription_type: 'checkup',
      stripe_payment_intent: paymentIntentId,
      created_at: new Date().toISOString(),
    }, { onConflict: 'email' }).catch(() => {});

    try {
      await sb.auth.resetPasswordForEmail(email, {
        redirectTo: 'https://bilanpsy.fr/login.html'
      });
    } catch (e) {}

    return res.status(200).json({ success: true });
  }

  return res.status(400).json({ error: 'action invalide' });
};
