import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { action } = req.body || {};

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

  if (action === 'confirm') {
    const { email, paymentIntentId } = req.body;
    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
      if (pi.status !== 'succeeded') return res.status(402).json({ error: 'Non confirmé' });
      const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
      await sb.auth.admin.createUser({ email, password: Math.random().toString(36).slice(-8)+'Aa1!', email_confirm: true }).catch(()=>{});
      await sb.from('users').upsert({ email, status:'active', subscription_type:'checkup', created_at: new Date().toISOString() }, { onConflict:'email' }).catch(()=>{});
      await sb.auth.resetPasswordForEmail(email, { redirectTo:'https://bilanpsy.fr/login.html' }).catch(()=>{});
      return res.status(200).json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(400).json({ error: 'action invalide' });
}
