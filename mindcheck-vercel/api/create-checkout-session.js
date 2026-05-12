// /api/create-checkout-session.js
// 
// Reçoit { offer: 'decouverte' | 'annuel' } depuis paywall.html
// Crée une session Stripe Checkout en fonction de l'offre choisie
// Renvoie l'URL Stripe vers laquelle rediriger l'utilisateur

import Stripe from 'stripe';

// Initialisation Stripe avec la clé secrète (stockée en env var Vercel)
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Mapping des offres vers les Price IDs Stripe
// Les valeurs viennent des env vars Vercel pour faciliter le passage Test → Live
const PRICE_IDS = {
  decouverte: process.env.STRIPE_PRICE_DECOUVERTE,
  annuel: process.env.STRIPE_PRICE_ANNUEL,
};

// Mode Stripe selon l'offre (paiement unique vs abonnement)
const CHECKOUT_MODES = {
  decouverte: 'payment',      // paiement unique 9€
  annuel: 'subscription',     // abonnement annuel récurrent 49€
};

export default async function handler(req, res) {
  // Cette fonction n'accepte que les requêtes POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  try {
    // Récupération de l'offre choisie
    const { offer } = req.body;

    // Validation de l'offre
    if (!offer || !['decouverte', 'annuel'].includes(offer)) {
      return res.status(400).json({ 
        error: 'Offre invalide. Doit être "decouverte" ou "annuel".' 
      });
    }

    // Récupération du price_id et du mode correspondants
    const priceId = PRICE_IDS[offer];
    const mode = CHECKOUT_MODES[offer];

    if (!priceId) {
      console.error(`[create-checkout-session] Price ID manquant pour l'offre : ${offer}`);
      return res.status(500).json({ 
        error: 'Configuration tarifaire indisponible' 
      });
    }

    // Récupération de l'origine du site (psee.fr en prod, localhost en dev)
    const origin = req.headers.origin || 'https://psee.fr';

    // Création de la session Stripe Checkout
    const session = await stripe.checkout.sessions.create({
      mode: mode,
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      // URLs de redirection après paiement
      success_url: `${origin}/auth.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/paywall.html`,
      // Métadonnées pour retrouver l'offre dans le webhook
      metadata: {
        offer: offer,
      },
      // Pour les abonnements, on ajoute aussi les métadonnées au niveau subscription
      ...(mode === 'subscription' && {
        subscription_data: {
          metadata: {
            offer: offer,
          },
        },
      }),
      // Localisation et langue
      locale: 'fr',
      // Collecte automatique de l'email (qui sera utilisé pour Supabase)
      // L'utilisateur saisira son email directement dans Stripe Checkout
    });

    // Retourne l'URL Stripe au client
    return res.status(200).json({ 
      url: session.url 
    });

  } catch (error) {
    console.error('[create-checkout-session] Erreur :', error);
    return res.status(500).json({ 
      error: 'Erreur lors de la création de la session de paiement' 
    });
  }
}
