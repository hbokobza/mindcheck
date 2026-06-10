// api/payment.js
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  if (req.method !== 'POST') return res.status(405).end();

  const { action } = req.body || {};

  if (action === 'create-intent') {
    let Stripe;
    try {
      Stripe = require('stripe');
    } catch(e) {
      return res.status(500).json({ error: 'stripe_not_installed', detail: e.message });
    }

    try {
      const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
      const pi = await stripe.paymentIntents.create({
        amount: 3900,
        currency: 'eur',
        automatic_payment_methods: { enabled: true }
      });
      return res.status(200).json({ clientSecret: pi.client_secret });
    } catch(e) {
      return res.status(500).json({ error: 'stripe_error', detail: e.message });
    }
  }

  if (action === 'confirm') {
    return res.status(200).json({ success: true });
  }

  return res.status(400).json({ error: 'action invalide' });
};
