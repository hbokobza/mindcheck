// api/create-payment-intent.js
// Crée un PaymentIntent Stripe et retourne le clientSecret au front
// Env vars Vercel à configurer : STRIPE_SECRET_KEY

import Stripe from 'stripe';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const { amount = 3900, currency = 'eur' } = req.body || {};

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount,                         // en centimes → 3900 = 39,00 €
      currency,
      automatic_payment_methods: { enabled: true },
      metadata: { product: 'bilanpsy-checkup' }
    });

    res.status(200).json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error('[stripe] create-payment-intent error:', err.message);
    res.status(500).json({ error: err.message });
  }
}
