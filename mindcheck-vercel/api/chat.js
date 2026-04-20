// api/chat.js
// Proxy securise vers l'API Anthropic pour Psee.
//
// Responsabilites :
//   1. Verifier la methode et le rate limit
//   2. Selectionner le system prompt cote serveur (pas envoye par le front)
//   3. Classifier le dernier message utilisateur
//   4. Si categorie critique/hors_perimetre/abusif/vide : repondre directement
//      sans appeler le modele
//   5. Si normal/sensible : appeler le modele, puis filtrer la sortie
//   6. Loguer les categories non-normales (catégorie + horodatage, pas le contenu)

import { COLLECTE_SYS, BILAN_BTC_SYS, BILAN_BTB_SYS } from '../lib/systemPrompts.js';
import { classifyInput, isUnsafeOutput } from '../lib/safetyRules.js';
import { POLICIES } from '../lib/responsePolicies.js';
import { allowRequest } from '../lib/rateLimit.js';

// Selection du system prompt selon le mode demande par le front.
// Le front envoie { mode: 'collecte' | 'bilan_btc' | 'bilan_btb', messages }
// Il n'envoie plus de prompt — impossible desormais de le forger.
function resolveSystemPrompt(mode) {
  switch (mode) {
    case 'bilan_btc': return BILAN_BTC_SYS;
    case 'bilan_btb': return BILAN_BTB_SYS;
    case 'collecte':
    default:          return COLLECTE_SYS;
  }
}

// Log structure minimal (categorie + horodatage + hash IP, pas de contenu)
function logIncident(category, ip) {
  const ts = new Date().toISOString();
  const ipTag = ip ? ip.split('.').slice(0, 2).join('.') + '.x.x' : 'unknown';
  console.log(`[psee-safety] ${ts} cat=${category} ip=${ipTag}`);
}

function buildReply(text, category) {
  return {
    content: [{ type: 'text', text }],
    category,
    model: 'psee-policy',
    usage: { input_tokens: 0, output_tokens: 0 }
  };
}

export default async function handler(req, res) {
  // 1. Methode
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  // 2. Rate limit par IP
  const ip = (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown')
    .toString()
    .split(',')[0]
    .trim();
  if (!allowRequest(ip)) {
    logIncident('rate_limit', ip);
    return res.status(429).json({
      error: { message: 'Trop de requetes. Reprenez dans un instant.' }
    });
  }

  // 3. Lecture du body
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const { messages, mode } = body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      error: { message: 'Messages manquants ou invalides' }
    });
  }

  // 4. Selection du system prompt (jamais depuis le front)
  const systemPrompt = resolveSystemPrompt(mode);

  // 5. Classification du dernier message utilisateur.
  //    On ne classifie que le dernier message utilisateur : les generations
  //    de bilan (mode bilan_btc / bilan_btb) passent toutes en normal car
  //    le dernier message est une instruction technique de generation.
  let category = 'normal';
  if (mode === 'collecte' || !mode) {
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    if (lastUserMsg && typeof lastUserMsg.content === 'string') {
      category = classifyInput(lastUserMsg.content);
    }
  }

  // 6. Interception selon categorie (sauf 'normal' et 'sensitive')
  if (category === 'critical') {
    logIncident('critical', ip);
    return res.status(200).json(buildReply(POLICIES.critical, 'critical'));
  }
  if (category === 'out_of_scope') {
    logIncident('out_of_scope', ip);
    return res.status(200).json(buildReply(POLICIES.out_of_scope, 'out_of_scope'));
  }
  if (category === 'abusive') {
    logIncident('abusive', ip);
    return res.status(200).json(buildReply(POLICIES.abusive, 'abusive'));
  }
  if (category === 'empty') {
    return res.status(200).json(buildReply(POLICIES.empty, 'empty'));
  }
  if (category === 'sensitive') {
    logIncident('sensitive', ip);
    // On continue, mais on a logue
  }

  // 7. Appel a l'API Anthropic
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        system: systemPrompt,
        messages: messages
      })
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    // 8. Filtrage de sortie
    const aiText = data.content?.[0]?.text || '';
    if (isUnsafeOutput(aiText)) {
      logIncident('output_filtered', ip);
      return res.status(200).json(buildReply(POLICIES.output_filtered, 'output_filtered'));
    }

    // 9. Enrichissement avec la categorie (optionnel, pour le front)
    data.category = category;
    return res.status(200).json(data);

  } catch (error) {
    console.error('[psee-safety] api error:', error?.message);
    return res.status(500).json({
      error: { message: POLICIES.fallback }
    });
  }
}
