import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { action } = req.body || {};

  // ── Paiement unique 39€ ──────────────────────────────────
  if (action === 'create-intent') {
    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      const pi = await stripe.paymentIntents.create({
        amount: 3900, currency: 'eur',
        automatic_payment_methods: { enabled: true }
      });
      return res.status(200).json({ clientSecret: pi.client_secret });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── Abonnement 9€/mois ───────────────────────────────────
  if (action === 'create-subscription') {
    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      const customer = await stripe.customers.create({});
      const subscription = await stripe.subscriptions.create({
        customer: customer.id,
        items: [{ price: process.env.STRIPE_PRICE_ANNUEL }],
        payment_behavior: 'default_incomplete',
        payment_settings: { save_default_payment_method: 'on_subscription' },
        expand: ['latest_invoice.payment_intent'],
      });
      return res.status(200).json({
        clientSecret: subscription.latest_invoice.payment_intent.client_secret,
        subscriptionId: subscription.id
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── Confirmation + création compte ──────────────────────
  if (action === 'confirm') {
    const { email, paymentIntentId, subscriptionId, plan } = req.body;
    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

      // Vérifier le paiement
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
      if (pi.status !== 'succeeded') return res.status(402).json({ error: 'Non confirmé' });

      // Mettre à jour l'email du customer si abonnement
      if (subscriptionId) {
        const sub = await stripe.subscriptions.retrieve(subscriptionId);
        await stripe.customers.update(sub.customer, { email });
      }

      // Créer compte Supabase
      const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
      const tempPwd = Math.random().toString(36).slice(-8) + 'Aa1!';
      await sb.auth.admin.createUser({ email, password: tempPwd, email_confirm: true }).catch(() => {});
      await sb.from('users').upsert({
        email,
        status: 'active',
        subscription_type: plan === 'plus' ? 'checkup_plus' : 'checkup',
        stripe_payment_intent: paymentIntentId,
        stripe_subscription_id: subscriptionId || null,
        created_at: new Date().toISOString()
      }, { onConflict: 'email' }).catch(() => {});

      await sb.auth.resetPasswordForEmail(email, {
        redirectTo: 'https://bilanpsy.fr/login.html'
      }).catch(() => {});

      return res.status(200).json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(400).json({ error: 'action invalide' });
}
