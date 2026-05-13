import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

// Client admin (service_role) — opérations privilégiées (créer user, upsert)
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// Client public (anon) — signInWithOtp envoie réellement l'email
const supabasePublic = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

export const config = {
  api: { bodyParser: false },
};

async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const sig = req.headers['stripe-signature'];
  if (!sig) {
    console.error('[stripe-webhook] Signature manquante');
    return res.status(400).json({ error: 'Signature manquante' });
  }

  let event;
  try {
    const rawBody = await buffer(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('[stripe-webhook] Vérification signature échouée :', err.message);
    return res.status(400).json({ error: `Erreur webhook : ${err.message}` });
  }

  console.log(`[stripe-webhook] Événement reçu : ${event.type} (id : ${event.id})`);

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object);
        break;
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object);
        break;
      default:
        console.log(`[stripe-webhook] Type non géré : ${event.type}`);
    }
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error(`[stripe-webhook] Erreur traitement ${event.type} :`, err);
    return res.status(500).json({ error: 'Erreur traitement webhook' });
  }
}

async function handleCheckoutCompleted(session) {
  const email = session.customer_details?.email || session.customer_email;
  const offer = session.metadata?.offer;
  const stripeCustomerId = session.customer;

  if (!email || !offer) {
    throw new Error(`email ou offer manquant dans session ${session.id}`);
  }

  console.log(`[stripe-webhook] Paiement confirmé : ${email} / ${offer}`);

  // 1. Récupérer ou créer l'utilisateur dans auth.users
  const { data: listData, error: listError } = await supabaseAdmin.auth.admin.listUsers();
  if (listError) throw new Error(`listUsers : ${listError.message}`);

  let userId;
  const existing = listData.users.find((u) => u.email === email);
  if (existing) {
    userId = existing.id;
    console.log(`[stripe-webhook] Utilisateur existant : ${userId}`);
  } else {
    const { data: created, error: createError } = await supabaseAdmin.auth.admin.createUser({
      email,
      email_confirm: true,
    });
    if (createError) throw new Error(`createUser : ${createError.message}`);
    userId = created.user.id;
    console.log(`[stripe-webhook] Nouvel utilisateur créé : ${userId}`);
  }

  // 2. Upsert dans la table `users` (abonnement + email + stripe_customer_id)
  const now = new Date();
  const days = offer === 'decouverte' ? 30 : 365;
  const subEnd = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  const { error: upsertError } = await supabaseAdmin
    .from('users')
    .upsert(
      {
        user_id: userId,
        email,
        stripe_customer_id: stripeCustomerId,
        subscription_type: offer,
        subscription_start: now.toISOString(),
        subscription_end: subEnd.toISOString(),
        status: 'active',
        updated_at: now.toISOString(),
      },
      { onConflict: 'user_id' }
    );

  if (upsertError) throw new Error(`upsert users : ${upsertError.message}`);
  console.log(`[stripe-webhook] Abonnement enregistré pour ${email}`);

  // 3. Envoyer le magic link via signInWithOtp (envoi email automatique)
  const { error: otpError } = await supabasePublic.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: 'https://psee.fr/auth.html',
      shouldCreateUser: false,
    },
  });

  if (otpError) throw new Error(`signInWithOtp : ${otpError.message}`);
  console.log(`[stripe-webhook] Magic link envoyé à ${email}`);
}

async function handleSubscriptionUpdated(subscription) {
  console.log(`[stripe-webhook] Abonnement mis à jour : ${subscription.id}, statut : ${subscription.status}`);

  if (['canceled', 'unpaid', 'incomplete_expired'].includes(subscription.status)) {
    const { error } = await supabaseAdmin
      .from('users')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('stripe_customer_id', subscription.customer);
    if (error) throw new Error(`update subscription updated : ${error.message}`);
  }
}

async function handleSubscriptionDeleted(subscription) {
  console.log(`[stripe-webhook] Abonnement supprimé : ${subscription.id}`);

  const { error } = await supabaseAdmin
    .from('users')
    .update({
      status: 'cancelled',
      subscription_end: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('stripe_customer_id', subscription.customer);

  if (error) throw new Error(`update subscription deleted : ${error.message}`);
}
