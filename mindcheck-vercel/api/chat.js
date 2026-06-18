// deploy
// api/chat.js
// Proxy securise vers l'API Anthropic pour PSEE
// + detection de suspicion clinique
// + integration invisible des modules psychometriques (PHQ9, GAD7, PSS10)
// + controle qualite de passation
// + synthese finale prudente

import {
  COLLECTE_SYS,
  BILAN_BTC_SYS,
  BILAN_BTB_SYS,
  PASSATION_FINALE_SYS,
  EXTRACTION_SYS,
  GENERATION_NARRATIVE_BTC_SYS,
  GENERATION_NARRATIVE_BTB_SYS,
  buildCollectePrompt
} from './systemPrompts.js';
import { applyClinicalRules } from './ruleEngine.js';
import { classifyInput, isUnsafeOutput } from './safetyRules.js';
import { POLICIES } from './responsePolicies.js';
import { allowRequest } from './rateLimit.js';

import { detectSuspicion, chooseNextModule } from './suspicionEngine.js';
import {
  getPsychometricModule,
  buildPsychometricResult,
  PHQ9,
  GAD7,
  PSS10,
  scoreModule,
  interpretModule
} from './psychometrics.js';
import {
  buildPassationMetrics,
  computePassationQuality
} from './passationQuality.js';
import { buildClinicalSynthesis } from './clinicalSynthesis.js';
import { Resend } from 'resend';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';

// ---- Helpers mode clinique BTB ----
const resendClient = new Resend(process.env.RESEND_API_KEY);

function scoreLabel(score) {
  const labels = { 1: 'Fragile', 2: 'En tension', 3: 'Stable', 4: 'Solide' };
  return labels[Math.round(score)] || '—';
}

function scoreColor(score) {
  const colors = { 1: '#D94F3D', 2: '#E8943A', 3: '#4A90A4', 4: '#4A7C59' };
  return colors[Math.round(score)] || '#888';
}

function buildBTBEmailHTML(btb, praticienNom, sessionCode) {
  const axes = btb.axes || [];
  const profil = btb.profil_clinique || {};
  const mecanismes = btb.mecanismes_transdiagnostiques || [];
  const pistes = btb.pistes_exploration || [];
  const themes = btb.themes_attention || [];
  const ressourcesObs = btb.ressources_observees || {};
  const analyseLing = btb.analyse_linguistique || {};
  const now = new Date().toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });

  const axesHTML = axes.map(axe => `
    <tr>
      <td style="padding:8px 12px;font-size:13px;color:#1A1A18;border-bottom:1px solid #EDE8E0;">${axe.label || axe.num}</td>
      <td style="padding:8px 12px;text-align:center;border-bottom:1px solid #EDE8E0;">
        <span style="display:inline-block;padding:2px 10px;border-radius:12px;font-size:12px;font-weight:600;background:${scoreColor(axe.score)}20;color:${scoreColor(axe.score)}">${scoreLabel(axe.score)}</span>
      </td>
      <td style="padding:8px 12px;font-size:12px;color:#5A5A58;border-bottom:1px solid #EDE8E0;">${axe.manifestations || ''}</td>
    </tr>`).join('');

  const tagHTML = (str, color) => (str || '').split(',').map(t => t.trim()).filter(Boolean)
    .map(t => `<span style="display:inline-block;margin:3px 4px 3px 0;padding:3px 10px;border-radius:12px;font-size:12px;background:${color}15;color:${color};border:1px solid ${color}30">${t}</span>`).join('');

  // Mécanismes transdiagnostiques — nouveau format (processus / salience / boucle_courte)
  const salienceLabel = s => s >= 3 ? 'élevée' : s >= 2 ? 'modérée' : 'faible';
  const mecanismesHTML = mecanismes.map(m => `
    <div style="margin-bottom:10px;padding:10px 14px;background:#F7F4EF;border-radius:8px;border-left:3px solid #E8943A">
      <div style="font-size:13px;font-weight:600;color:#1A1A18">${m.processus || m.nom || ''} <span style="font-weight:400;font-size:12px;color:#888">— saillance ${salienceLabel(m.salience ?? m.saillance)}</span></div>
      <div style="font-size:12px;color:#5A5A58;margin-top:3px">${m.boucle_courte || ''}</div>
    </div>`).join('');

  // Pistes d'exploration
  const pistesHTML = pistes.length > 0 ? pistes.map(p => `
    <li style="margin-bottom:10px;font-size:13px;color:#1A1A18;line-height:1.6">${p}</li>`).join('') : '';

  // Thèmes d'attention
  const themesHTML = themes.map(t => `
    <div style="margin-bottom:14px;padding:12px 16px;background:#F7F4EF;border-radius:8px;border-left:3px solid #C04A1A">
      <div style="font-size:13px;font-weight:600;color:#1A1A18;margin-bottom:4px">${t.titre || ''}</div>
      <div style="font-size:12px;color:#5A5A58;margin-bottom:3px">${t.manifestations || ''}</div>
      <div style="font-size:12px;color:#888;font-style:italic">${t.observation_clinique || ''}</div>
    </div>`).join('');

  // Ressources observées
  const resElements = (ressourcesObs.elements || []).map(e => `
    <div style="margin-bottom:10px;padding:10px 14px;background:#EEF7EE;border-radius:8px;border-left:3px solid #4A7C59">
      <div style="font-size:13px;font-weight:600;color:#1A4A2E">${e.titre || ''}</div>
      <div style="font-size:12px;color:#5A5A58;margin-top:3px">${e.detail || ''}</div>
    </div>`).join('');

  // Analyse linguistique
  const lingHTML = analyseLing.synthese ? `
    <div style="margin-bottom:28px">
      <div style="font-size:10px;font-weight:600;letter-spacing:0.1em;color:#888;text-transform:uppercase;margin-bottom:10px">Analyse linguistique implicite</div>
      <div style="font-size:13px;color:#1A1A18;line-height:1.7;padding:14px;background:#F7F4EF;border-radius:8px">${analyseLing.synthese}</div>
    </div>` : '';

  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#F0EBE3;font-family:'Helvetica Neue',Arial,sans-serif">
<div style="max-width:680px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08)">
  <div style="background:#1A2E1A;padding:24px 32px">
    <div style="font-size:22px;font-weight:700;color:#fff">bilanpsy<span style="color:#FF4B28">.</span> <span style="font-size:13px;font-weight:400;color:#AAC4AA">PRO</span></div>
    <div style="font-size:12px;color:#AAC4AA;margin-top:4px">BILAN CLINIQUE — Aide à la lecture pré-consultation · Code : ${sessionCode} · ${now}</div>
  </div>
  <div style="padding:32px">
    <div style="margin-bottom:24px;padding:12px 16px;background:#F7F4EF;border-radius:8px;font-size:13px;color:#5A5A58">À l'attention de <strong style="color:#1A1A18">${praticienNom}</strong> — Bilan transmis automatiquement via BilanPsy</div>

    <div style="margin-bottom:28px">
      <div style="font-size:10px;font-weight:600;letter-spacing:0.1em;color:#888;text-transform:uppercase;margin-bottom:10px">Synthèse clinique</div>
      <div style="font-size:14px;color:#1A1A18;line-height:1.7;font-style:italic;padding:16px;background:#F7F4EF;border-radius:8px;border-left:3px solid #4A7C59">${btb.synthese_clinique || btb.synthese || ''}</div>
    </div>

    <div style="margin-bottom:28px">
      <div style="font-size:10px;font-weight:600;letter-spacing:0.1em;color:#888;text-transform:uppercase;margin-bottom:10px">Cartographie 6 axes</div>
      <table style="width:100%;border-collapse:collapse;background:#F7F4EF;border-radius:8px;overflow:hidden">
        <thead><tr style="background:#EDE8E0">
          <th style="padding:10px 12px;text-align:left;font-size:11px;color:#888;font-weight:600;text-transform:uppercase">Axe</th>
          <th style="padding:10px 12px;text-align:center;font-size:11px;color:#888;font-weight:600;text-transform:uppercase">Score</th>
          <th style="padding:10px 12px;text-align:left;font-size:11px;color:#888;font-weight:600;text-transform:uppercase">Manifestations</th>
        </tr></thead>
        <tbody>${axesHTML}</tbody>
      </table>
    </div>

    <div style="margin-bottom:28px">
      <div style="font-size:10px;font-weight:600;letter-spacing:0.1em;color:#888;text-transform:uppercase;margin-bottom:10px">Profil clinique observé</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div style="padding:14px;background:#F7F4EF;border-radius:8px"><div style="font-size:11px;font-weight:600;color:#4D3728;text-transform:uppercase;margin-bottom:8px">Structure psychique</div>${tagHTML(profil.structure, '#4D3728')}</div>
        <div style="padding:14px;background:#F7F4EF;border-radius:8px"><div style="font-size:11px;font-weight:600;color:#4A5728;text-transform:uppercase;margin-bottom:8px">Événements structurants</div>${tagHTML(profil.evenements, '#4A5728')}</div>
        <div style="padding:14px;background:#F7F4EF;border-radius:8px;border:1px solid #E8943A40"><div style="font-size:11px;font-weight:600;color:#7A4010;text-transform:uppercase;margin-bottom:8px">Conflit central</div><div style="font-size:13px;font-weight:600;color:#1A1A18">${profil.conflit_central || '—'}</div></div>
        <div style="padding:14px;background:#F7F4EF;border-radius:8px"><div style="font-size:11px;font-weight:600;color:#1A4A2E;text-transform:uppercase;margin-bottom:8px">Ressources structurantes</div>${tagHTML(profil.ressources, '#1A4A2E')}</div>
      </div>
    </div>

    ${lingHTML}

    ${mecanismes.length > 0 ? `<div style="margin-bottom:28px"><div style="font-size:10px;font-weight:600;letter-spacing:0.1em;color:#888;text-transform:uppercase;margin-bottom:10px">Mécanismes transdiagnostiques</div>${mecanismesHTML}</div>` : ''}

    ${pistes.length > 0 ? `<div style="margin-bottom:28px"><div style="font-size:10px;font-weight:600;letter-spacing:0.1em;color:#888;text-transform:uppercase;margin-bottom:10px">Pistes d'exploration</div><ul style="margin:0;padding:16px 16px 16px 32px;background:#F7F4EF;border-radius:8px">${pistesHTML}</ul></div>` : ''}

    ${themes.length > 0 ? `<div style="margin-bottom:28px"><div style="font-size:10px;font-weight:600;letter-spacing:0.1em;color:#888;text-transform:uppercase;margin-bottom:10px">Points d'attention</div>${themesHTML}</div>` : ''}

    ${resElements ? `<div style="margin-bottom:28px"><div style="font-size:10px;font-weight:600;letter-spacing:0.1em;color:#888;text-transform:uppercase;margin-bottom:10px">Ressources observées</div>${resElements}</div>` : ''}

    <div style="margin-top:32px;padding-top:20px;border-top:1px solid #EDE8E0">
      <p style="font-size:11px;color:#888;line-height:1.6;margin:0">Ce bilan combine : psychométrie validée (PHQ-9, GAD-7, PSS-10), analyse linguistique implicite (INSERM/Paris-Cité), paradigme AAP (JMIR Mental Health, 2026). Outil d'aide à la lecture pré-consultation, visée observationnelle. Ne pose aucun diagnostic. Ne se substitue pas à l'évaluation clinique du praticien.</p>
      <p style="font-size:11px;color:#BB8866;margin:10px 0 0 0">BilanPsy n'est pas un service d'urgence — en cas de crise active, le 3114 et le 15 sont les recours appropriés.</p>
    </div>
  </div>
</div>
<div style="text-align:center;padding:16px;font-size:11px;color:#888">BilanPsy · Usage strictement professionnel et confidentiel · bilanpsy.fr</div>
</body></html>`;
}

async function handleGetBilan(req, res) {
  // Lire sessionCode depuis le body en priorité (POST JSON), puis query en fallback.
  // Bug corrigé : `req.query || req.body` retournait toujours req.query (objet vide
  // mais truthy), ce qui faisait échouer la lecture quand sessionCode est dans le body.
  const sessionCode = (req.body && req.body.sessionCode) || (req.query && req.query.sessionCode) || null;
  if (!sessionCode) {
    return res.status(400).json({ error: 'sessionCode requis' });
  }
  try {
    const supabase = createSupabaseClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data, error } = await supabase
      .from('clinical_extractions')
      .select('json_clinical, created_at')
      .eq('session_id', sessionCode)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    if (error || !data) {
      return res.status(404).json({ error: 'Bilan introuvable' });
    }
    return res.status(200).json({ btb: data.json_clinical, created_at: data.created_at });
  } catch(err) {
    console.error('[get-bilan] Erreur:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleSendBTB(req, res) {
  const { cliniqueCode, btbData, sessionCode } = req.body;
  if (!cliniqueCode || !btbData) {
    return res.status(400).json({ error: 'cliniqueCode et btbData requis' });
  }
  try {
    const supabase = createSupabaseClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data: praticien, error } = await supabase
      .from('praticiens_test')
      .select('email, nom, actif')
      .eq('code', cliniqueCode)
      .single();
    if (error || !praticien) return res.status(404).json({ error: 'Code praticien invalide' });
    if (!praticien.actif) return res.status(403).json({ error: 'Code praticien désactivé' });

    const btb = typeof btbData === 'string' ? JSON.parse(btbData) : btbData;
    const code = sessionCode || ('BP-' + Date.now().toString(36).toUpperCase());
    const nowISO = new Date().toISOString();

    // 1. Stocker le JSON BTB dans clinical_extractions (colonnes natives).
    //    Toutes les colonnes NOT NULL sont remplies explicitement.
    const { error: insertError } = await supabase
      .from('clinical_extractions')
      .insert({
        extraction_id: code + '-btb',
        session_id: code,
        json_clinical: btb,
        schema_version: 'btb-clinique-v1',
        model_used: 'claude-haiku-4-5-20251001',
        structural_conformity: true,
        extracted_at: nowISO,
        is_test_case: String(cliniqueCode).startsWith('BP-TEST-'),
        praticien_code: cliniqueCode,
        user_id: null
      });
    if (insertError) {
      console.error('[send-btb] Supabase insert ERREUR:', insertError.message);
      // Bloquant : sans stockage, le praticien ne pourra pas consulter le bilan
      return res.status(500).json({ error: 'Stockage du bilan impossible', debug: insertError.message });
    }

    // 2. Construire le lien d'accès au bilan complet
    const bilanUrl = `https://bilanpsy.fr/bilan-clinique.html?session=${encodeURIComponent(code)}`;
    const now = new Date().toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });

    // 3. Email sobre avec lien vers le bilan complet
    const emailHTML = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#F0EBE3;font-family:'Helvetica Neue',Arial,sans-serif">
<div style="max-width:600px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08)">
  <div style="background:#1A2E1A;padding:24px 32px">
    <div style="font-size:22px;font-weight:700;color:#fff">bilanpsy<span style="color:#FF4B28">.</span> <span style="font-size:13px;font-weight:400;color:#AAC4AA">PRO</span></div>
    <div style="font-size:12px;color:#AAC4AA;margin-top:4px">Nouveau bilan clinique disponible · ${now}</div>
  </div>
  <div style="padding:32px">
    <p style="font-size:15px;color:#1A1A18;margin:0 0 16px">Bonjour ${praticien.nom},</p>
    <p style="font-size:14px;color:#444;line-height:1.7;margin:0 0 28px">Un nouveau bilan BilanPsy est disponible pour votre prochain rendez-vous. Le bilan complet (cartographie 6 axes, profil clinique, mécanismes, pistes d'exploration) est accessible en cliquant sur le bouton ci-dessous.</p>
    <div style="text-align:center;margin:0 0 32px">
      <a href="${bilanUrl}" style="display:inline-block;background:#1A2E1A;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:600;letter-spacing:0.2px">Consulter le bilan complet →</a>
    </div>
    <div style="background:#F7F4EF;border-radius:8px;padding:14px 18px;font-size:12px;color:#888;line-height:1.6">
      Code session : <strong style="color:#1A1A18;font-family:monospace">${code}</strong><br>
      Lien direct : <a href="${bilanUrl}" style="color:#4A7C59">${bilanUrl}</a>
    </div>
    <div style="margin-top:28px;padding-top:20px;border-top:1px solid #EDE8E0">
      <p style="font-size:11px;color:#888;line-height:1.6;margin:0">Ce bilan est un outil d'aide à la lecture pré-consultation, à visée observationnelle. Il ne pose aucun diagnostic et ne se substitue pas à votre évaluation clinique.</p>
      <p style="font-size:11px;color:#BB8866;margin:8px 0 0 0">BilanPsy n'est pas un service d'urgence — en cas de crise active, le 3114 et le 15 sont les recours appropriés.</p>
    </div>
  </div>
</div>
<div style="text-align:center;padding:16px;font-size:11px;color:#888">BilanPsy · Usage strictement professionnel et confidentiel · bilanpsy.fr</div>
</body></html>`;

    const emailResponse = await resendClient.emails.send({
      from: 'BilanPsy <bilan@bilanpsy.fr>',
      to: [praticien.email],
      subject: `BilanPsy Pro — Nouveau bilan clinique · ${code}`,
      html: emailHTML
    });

    if (emailResponse.error) {
      console.error('[send-btb] Erreur Resend:', emailResponse.error);
      return res.status(500).json({ error: 'Erreur envoi email' });
    }

    console.log(`[send-btb] BTB envoyé à ${praticien.email} · session ${code}`);
    return res.status(200).json({ success: true, praticienNom: praticien.nom });
  } catch(err) {
    console.error('[send-btb] Erreur:', err);
    return res.status(500).json({ error: err.message });
  }
}
// ---- Fin helpers mode clinique BTB ----

const MAX_MODULES_PER_SESSION = 2;

// ============================================================================
// FEATURE FLAG — PIPELINE V1.3 SÉQUENTIEL (Chantier 3)
// ============================================================================
// Quand true : le bilan BtC est généré par le pipeline séquentiel V1.3
//   transcript → EXTRACTION_SYS → ruleEngine → GENERATION_NARRATIVE_BTC_SYS
// Quand false : le bilan BtC est généré par le pipeline classique
//   (buildBilanPayload actuel, appel BILAN_BTC_SYS sur transcript brut)
//
// Le pipeline V1.3 est SÉQUENTIEL : un seul appel Anthropic à la fois,
// ce qui évite la saturation du rate limit (50k tokens/min).
//
// Le mode bilan_btb n'est PAS affecté par ce flag — il continue d'utiliser
// le pipeline classique tant que le Chantier BtB n'est pas fait.
//
// Pour activer en production : passer à true et redéployer.
// Pour rollback instantané : repasser à false et redéployer.
// ============================================================================
const USE_V13_PIPELINE = false;

// -----------------------------
// SYSTEM PROMPT
// -----------------------------
function resolveSystemPrompt(mode, triggeredModules = [], passationContext = null) {
  switch (mode) {
    case 'bilan_btc': return BILAN_BTC_SYS;
    case 'bilan_btb': return BILAN_BTB_SYS;
    case 'passation_finale': return buildPassationFinalePrompt(passationContext);
    case 'collecte':
    default: return buildCollectePrompt(triggeredModules);
  }
}

// Construit dynamiquement le prompt passation_finale en injectant le contexte
// du module en cours (PHQ-9 / GAD-7 / PSS-10) et de l'item courant.
function buildPassationFinalePrompt(ctx) {
  const hasValidIndex = ctx && typeof ctx.currentItemIndex === 'number' && ctx.currentItemIndex >= 0;
  if (!ctx || !ctx.moduleId || !hasValidIndex) {
    // Fallback : on retourne le prompt brut (Haiku saura repondre raisonnablement)
    return PASSATION_FINALE_SYS;
  }

  const moduleSpecs = {
    PHQ9: {
      title: 'PHQ-9',
      timeframe: '14 derniers jours',
      scaleLabels: 'jamais, quelques jours, plus de la moitie des jours, presque tous les jours',
      items: PHQ9.items
    },
    GAD7: {
      title: 'GAD-7',
      timeframe: '14 derniers jours',
      scaleLabels: 'jamais, quelques jours, plus de la moitie des jours, presque tous les jours',
      items: GAD7.items
    },
    PSS10: {
      title: 'PSS-10',
      timeframe: 'dernier mois',
      scaleLabels: 'jamais, presque jamais, parfois, assez souvent, tres souvent',
      items: PSS10.items
    }
  };

  const spec = moduleSpecs[ctx.moduleId];
  if (!spec) return PASSATION_FINALE_SYS;

  const item = spec.items[ctx.currentItemIndex];
  const totalItems = spec.items.length;
  const itemNumber = ctx.currentItemIndex + 1;

  // Cas particulier : item 9 PHQ-9 (ideation suicidaire). Le libelle officiel
  // ("pensees qu'il vaudrait mieux disparaitre ou se faire du mal") est brutal
  // a poser a froid. On instruit Haiku de le reformuler avec delicatesse,
  // tout en gardant la rigueur clinique de la question et de l'echelle.
  const isPHQ9Item9 = ctx.moduleId === 'PHQ9' && ctx.currentItemIndex === 8;
  const sensitiveInstruction = isPHQ9Item9 ? `

INSTRUCTION SUPPLEMENTAIRE — ITEM SENSIBLE
Cet item porte sur les pensees de mort ou d'auto-dommage. C'est une question importante a poser, mais elle merite une formulation chaleureuse plutot que clinique brute. Tu peux ouvrir avec une transition courte du type "Je vais vous poser une derniere question importante." puis formuler quelque chose comme : "Au cours des 14 derniers jours, vous est-il arrive — meme de maniere fugace — d'avoir des pensees sombres, du genre 'ce serait plus simple si je n'etais plus la' ou 'je voudrais disparaitre' ?" Reste fidele a l'echelle (jamais, quelques jours, plus de la moitie des jours, presque tous les jours). Ne dramatise pas. Ne minimise pas. La personne peut repondre "jamais" et c'est une reponse valide, attendue dans la majorite des cas.
` : '';

  const contextBlock = `

CONTEXTE DE L'ITEM EN COURS
Module : ${spec.title}
Periode : ${spec.timeframe}
Item courant : ${itemNumber}/${totalItems}
Texte de l'item : "${item}"
Echelle de reponse : ${spec.scaleLabels}

INSTRUCTION SPECIFIQUE A CE TOUR
Pose UNIQUEMENT cet item courant, en le reformulant naturellement (voir les regles de formulation). Termine en proposant explicitement les options de l'echelle.
N'enchaine pas plusieurs items. Attends la reponse de la personne.${sensitiveInstruction}
`;

  return PASSATION_FINALE_SYS + contextBlock;
}

// -----------------------------
// LOGGING
// -----------------------------
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

// -----------------------------
// HANDLER
// -----------------------------
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  // ---- Routes mode clinique ----
  if (req.body && req.body.mode === 'send_btb') {
    return handleSendBTB(req, res);
  }
  if ((req.query && req.query.mode === 'get_bilan') || (req.body && req.body.mode === 'get_bilan')) {
    return handleGetBilan(req, res);
  }
  // ---- Fin routes clinique ----

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

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }

  const {
    messages,
    mode,
    action = 'message',
    sessionState = {},
    moduleSubmission = null,
    passationContext = null
  } = body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      error: { message: 'Messages manquants ou invalides' }
    });
  }

  const state = normalizeSessionState(sessionState);

  // 1. Classification securite du dernier message utilisateur
  // En mode passation_finale, les reponses du patient sont des reponses d'echelle
  // (jamais, quelques jours, ok, etc.) qui ne doivent PAS etre classees empty/
  // out_of_scope/abusive — sinon la passation est court-circuitee par un message
  // generique au lieu de poser l'item suivant. On ne garde que la detection de
  // crise (critical), qui reste prioritaire meme en passation.
  let category = 'normal';
  if (mode === 'collecte' || !mode) {
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    if (lastUserMsg && typeof lastUserMsg.content === 'string') {
      category = classifyInput(lastUserMsg.content);
    }
  } else if (mode === 'passation_finale') {
    // En passation : on ne classe que pour detecter une crise, rien d'autre.
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    if (lastUserMsg && typeof lastUserMsg.content === 'string') {
      const c = classifyInput(lastUserMsg.content);
      if (c === 'critical') category = 'critical';
    }
  }

  if (category === 'critical') {
    logIncident('critical', ip);
    // Refonte : on ne court-circuite plus systematiquement avec un message
    // de rejet. Le prompt COLLECTE_SYS gere desormais 3 niveaux d'ideation
    // (passive / active avec plan / urgence vitale) avec des reponses
    // adaptees. Haiku decide en contexte si l'entretien continue (niveau 1),
    // s'interromp avec respect (niveau 2), ou redirige en urgence (niveau 3).
    // Le shortcut hardcoded reste pour les modes non-collecte (bilan, passation)
    // ou un rejet brut est plus prudent.
    if (mode && mode !== 'collecte') {
      return res.status(200).json(buildReply(POLICIES.critical, 'critical'));
    }
    // Sinon : on laisse passer a Haiku qui gerera selon les nouvelles regles.
    // Le logging d'incident est conserve pour l'audit safety.
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
  }

  // 2. Texte utilisateur cumule
  const fullUserText = messages
    .filter(m => m?.role === 'user')
    .map(m => String(m.content || ''))
    .join('\n');

  const clinicalFlags = extractClinicalFlags(fullUserText);
  const axes = updateAxesFromFlags(state.axes, clinicalFlags);

  // 3. Soumission d'un module psychometrique
  if (action === 'submit_module' && moduleSubmission?.moduleId) {
    const { moduleId, answers = [] } = moduleSubmission;
    const result = buildPsychometricResult(moduleId, answers);

    if (!result) {
      return res.status(400).json({
        error: { message: 'Module psychometrique invalide' }
      });
    }

    const updatedCompletedModules = dedupe([
      ...state.completedModules,
      moduleId
    ]);

    const updatedModuleResults = [
      ...(state.moduleResults || []).filter(r => r.moduleId !== moduleId),
      result
    ];

    return res.status(200).json({
      type: 'assistant_message',
      message:
        'Merci. Ce module complementaire a ete integre au bilan. Vous pouvez poursuivre l’echange ou demander la synthese finale.',
      psychometricResult: result,
      category,
      sessionState: {
        ...state,
        axes,
        clinicalFlags,
        pendingModule: null,
        completedModules: updatedCompletedModules,
        moduleResults: updatedModuleResults
      }
    });
  }

  // 3bis. Audit pre-passation : determine quels items psychometriques restent
  // a poser apres la collecte conversationnelle. Si la conversation a deja
  // couvert tous les items via scoring LLM sur le transcript, on saute la
  // passation. Sinon on ne pose que les items residuels (max ~5).
  // Regle de securite non negociable : item 9 PHQ-9 (ideation suicidaire)
  // toujours pose si non explicitement aborde dans le transcript.
  if (action === 'pre_passation_audit') {
    try {
      const modulesToAudit = Array.isArray(body.modulesToAudit) && body.modulesToAudit.length > 0
        ? body.modulesToAudit
        : detectSuspicion(clinicalFlags);

      // Aucun module suspect -> on saute la passation entierement
      if (modulesToAudit.length === 0) {
        return res.status(200).json({
          type: 'pre_passation_audit',
          residualItems: {},
          rawScoring: {},
          coverage: {},
          skipPassation: true,
          sessionState: { ...state, axes, clinicalFlags }
        });
      }

      const transcript = buildTranscriptFromMessages(messages);
      const auditId = Math.random().toString(36).slice(2, 10);

      console.log('[psee-pre-passation] ' + JSON.stringify({
        auditId,
        event: 'start',
        modules: modulesToAudit,
        transcriptLength: transcript.length
      }));

      // Appel LLM pour scorer chaque item du transcript
      const scoringPrompt = buildScoringPrompt(modulesToAudit);
      const userMsg = [{
        role: 'user',
        content: `Voici le transcript de l entretien. Score les modules demandes.\n\n----- TRANSCRIPT -----\n${transcript}\n----- FIN TRANSCRIPT -----`
      }];

      const { parsed } = await callHaikuJson(scoringPrompt, userMsg);

      const COVERAGE_SKIP_THRESHOLD = 0.8;
      const residualItems = {};
      const rawScoring = {};
      const coverage = {};

      for (const moduleId of modulesToAudit) {
        const arr = parsed[moduleId];
        const module = getPsychometricModule(moduleId);
        const totalItems = module ? module.items.length : 0;

        if (!Array.isArray(arr) || arr.length !== totalItems) {
          // Le LLM n'a rien retourne d'exploitable -> fallback : poser tous les items
          residualItems[moduleId] = module ? module.items.map((_, i) => i) : [];
          rawScoring[moduleId] = [];
          coverage[moduleId] = 0;
          console.warn('[psee-pre-passation] LLM returned invalid array for ' + moduleId + ' | fallback to full passation');
          continue;
        }

        rawScoring[moduleId] = arr;

        // Items null = residuels (non couverts par le LLM)
        const nullIndexes = arr
          .map((v, i) => ({ v, i }))
          .filter(({ v }) => v === null || v === undefined || !Number.isFinite(Number(v)))
          .map(({ i }) => i);

        const validCount = totalItems - nullIndexes.length;
        coverage[moduleId] = totalItems > 0 ? validCount / totalItems : 0;

        // Regle de securite non negociable : item 9 PHQ-9 (index 8, ideation
        // suicidaire) doit toujours etre explicitement aborde. Si le LLM a
        // mis un nombre mais que le transcript ne contient AUCUN marqueur
        // explicite d'ideation, on force la question.
        if (moduleId === 'PHQ9' && !nullIndexes.includes(8)) {
          const ideationMarkers = /suicid|idee.{0,5}noir|pens(e|é)e.{0,15}(noir|sombre|mort|disparait)|en finir|me tuer|mort serait|m auto|me faire du mal|plus etre la|disparaitre/i;
          const explicitlyAddressed = ideationMarkers.test(transcript);
          if (!explicitlyAddressed) {
            nullIndexes.push(8);
            console.log('[psee-pre-passation] PHQ9 item 9 forced (safety rule, not explicitly addressed) | auditId=' + auditId);
          }
        }

        residualItems[moduleId] = nullIndexes.sort((a, b) => a - b);
      }

      // Decision : skip la passation entierement si tous les modules ont une
      // couverture >= seuil ET aucun item residuel (incluant la regle de
      // securite item 9 PHQ-9)
      const totalResidualItems = Object.values(residualItems).reduce((sum, arr) => sum + arr.length, 0);
      const allModulesWellCovered = Object.values(coverage).every(c => c >= COVERAGE_SKIP_THRESHOLD);
      const skipPassation = totalResidualItems === 0 && allModulesWellCovered;

      console.log('[psee-pre-passation] ' + JSON.stringify({
        auditId,
        event: 'result',
        coverage,
        residualItemsCount: Object.fromEntries(
          Object.entries(residualItems).map(([k, v]) => [k, v.length])
        ),
        skipPassation
      }));

      return res.status(200).json({
        type: 'pre_passation_audit',
        residualItems,
        rawScoring,
        coverage,
        skipPassation,
        auditId,
        sessionState: {
          ...state,
          axes,
          clinicalFlags,
          // On stocke le rawScoring en session pour que buildBilanPayload
          // puisse fusionner avec les eventuelles reponses residuelles plus tard
          prePassationScoring: rawScoring
        }
      });
    } catch (err) {
      console.error('[psee-pre-passation] failed:', err.message, '| stack:', err.stack);
      // Fallback : on retourne tous les items, comportement legacy
      const triggered = detectSuspicion(clinicalFlags);
      const allItems = {};
      triggered.forEach(m => {
        const module = getPsychometricModule(m);
        if (module) allItems[m] = module.items.map((_, i) => i);
      });
      return res.status(200).json({
        type: 'pre_passation_audit',
        residualItems: allItems,
        rawScoring: {},
        coverage: {},
        skipPassation: false,
        error: 'audit_failed_fallback_full_passation',
        sessionState: { ...state, axes, clinicalFlags }
      });
    }
  }

  // 3ter. Extraction clinique : prend le transcript complet (collecte +
  // passation), produit un JSON clinique V1.3 conforme au schema Psee
  // (14 dimensions en 4 couches, contre-indicateurs actifs, regles d'arbitrage,
  // perimetre de restitution patient strict). Ce JSON est destine au rule
  // engine deterministe (a coder) puis a la generation du bilan narratif.
  // Le front est responsable de l'insertion en base Supabase (table
  // clinical_extractions) apres reception.
  if (action === 'clinical_extraction') {
    try {
      const extractionId = 'ext_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);

      // Construire un transcript propre pour l'extraction. On inclut tous les
      // messages user + assistant pour donner au LLM le contexte complet de
      // la conversation. On ajoute aussi quelques meta utiles pour le scoring.
      const transcriptLines = messages.map(m => {
        const role = m.role === 'user' ? 'UTILISATEUR' : 'PSEE';
        const content = String(m.content || '').trim();
        return `${role}: ${content}`;
      });

      const turnCount = messages.length;
      const userMessageCount = messages.filter(m => m.role === 'user').length;
      const sessionId = body.sessionId || state.sessionId || 'unknown';

      // Resultats psychometriques eventuellement deja calcules (PHQ-9, GAD-7
      // depuis la passation finale, etc.). On les passe au LLM pour qu'il
      // les integre comme psychometric_anchor dans le JSON.
      const moduleResults = state.moduleResults || [];
      const moduleResultsBlock = moduleResults.length > 0
        ? '\n\nRESULTATS PSYCHOMETRIQUES DEJA CALCULES :\n' + JSON.stringify(moduleResults, null, 2)
        : '';

      const userMessage = `TRANSCRIPT COMPLET DE LA SESSION PSEE

Session ID : ${sessionId}
Date : ${new Date().toISOString()}
Tours total : ${turnCount}
Messages utilisateur : ${userMessageCount}${moduleResultsBlock}

TRANSCRIPT :

${transcriptLines.join('\n\n')}

---

Produis maintenant le JSON clinique V1.3 conforme au schema decrit dans le system prompt. Aucun texte avant ni apres le JSON.`;

      console.log('[psee-clinical-extraction] ' + JSON.stringify({
        extractionId,
        sessionId,
        turnCount,
        userMessageCount,
        moduleResultsCount: moduleResults.length
      }));

      // Appel Anthropic via la fonction existante callHaikuJson qui gere
      // deja le parsing robuste (markdown fences, virgules trainantes,
      // troncation max_tokens).
      const { parsed: jsonClinical, raw } = await callHaikuJson(
        EXTRACTION_SYS,
        [{ role: 'user', content: userMessage }]
      );

      // Validation de structure minimale : on s'assure que les blocs
      // critiques V1.3 sont presents. Si un bloc manque, on log mais on
      // retourne quand meme (politique V1 tolerante).
      const requiredFields = [
        'schema_version',
        'session_meta',
        'passation_quality',
        'axes_psee_visible_layer',
        'couche_0_securite_deterministe',
        'couche_1_differentiels_psychiatriques',
        'couche_2_dimensions_structurelles',
        'contextes_declencheurs',
        'resources',
        'rule_engine_arbitrations',
        'orientation_engine_output',
        'profile_typology'
      ];

      const missingFields = requiredFields.filter(f => !jsonClinical[f]);
      if (missingFields.length > 0) {
        console.warn('[psee-clinical-extraction] missing required fields:', missingFields);
      }

      // Enrichissement avec metadata cote serveur
      const enrichedJson = {
        ...jsonClinical,
        _extraction_meta: {
          extraction_id: extractionId,
          session_id: sessionId,
          model_used: 'claude-haiku-4-5-20251001',
          extracted_at: new Date().toISOString(),
          tokens_input: raw?.usage?.input_tokens || null,
          tokens_output: raw?.usage?.output_tokens || null,
          missing_required_fields: missingFields,
          structural_conformity: missingFields.length === 0
        }
      };

      console.log('[psee-clinical-extraction] success ' + JSON.stringify({
        extractionId,
        sessionId,
        tokensInput: raw?.usage?.input_tokens,
        tokensOutput: raw?.usage?.output_tokens,
        structuralConformity: missingFields.length === 0,
        missingFieldsCount: missingFields.length
      }));

      return res.status(200).json({
        type: 'clinical_extraction',
        success: true,
        extractionId,
        jsonClinical: enrichedJson,
        warnings: missingFields.length > 0 ? { missingFields } : null,
        sessionState: { ...state, axes, clinicalFlags, lastExtractionId: extractionId }
      });

    } catch (err) {
      console.error('[psee-clinical-extraction] failed:', err.message, err.stack);
      return res.status(200).json({
        type: 'clinical_extraction',
        success: false,
        error: 'extraction_failed',
        errorMessage: err.message,
        rawText: err.rawText || null,
        rawJsonStr: err.rawJsonStr || null,
        sessionState: { ...state, axes, clinicalFlags }
      });
    }
  }

  // 4. Rapport final
  if (action === 'finalize') {
    const answers = messages
      .filter(m => m?.role === 'user')
      .map(m => String(m.content || '').trim());

    const inconsistencies = detectInconsistencies(messages);

    const passationMetrics = buildPassationMetrics({
      messages,
      answers,
      responseTimes: state.responseTimes || [],
      inconsistencies,
      attentionCheckFailed: Boolean(state.attentionCheckFailed)
    });

    const passationQuality = computePassationQuality(passationMetrics);

    const synthesis = buildClinicalSynthesis({
      axes,
      psychometrics: state.moduleResults || [],
      passationQuality,
      clinicalFlags,
      safety: {
        suicidalIdeation: Boolean(clinicalFlags.suicidalIdeation)
      }
    });

    return res.status(200).json({
      type: 'final_report',
      synthesis,
      axes,
      psychometricResults: state.moduleResults || [],
      passationQuality,
      category,
      sessionState: {
        ...state,
        axes,
        clinicalFlags,
        passationQuality
      }
    });
  }

  // 5. Detection des modules psychometriques a integrer (philo A : invisible)
  // Plus de bypass Haiku : on enrichit le system prompt avec les items des
  // modules detectes. Haiku integre les questions naturellement dans le flux.
  const triggeredModules = detectSuspicion(clinicalFlags);

  // 5bis. Mode bilan : route specifique avec scoring rigoureux + passation
  if (mode === 'bilan_btc' || mode === 'bilan_btb') {
    try {
      const result = await buildBilanPayload({
        mode,
        messages,
        state,
        axes,
        clinicalFlags,
        ip
      });

      // On retourne dans le format attendu par le front : la partie text
      // contient le JSON serialise du payload fusionne (narratif + indicateurs
      // + passation), comme si Haiku avait genere directement ce format.
const responseText = JSON.stringify(result.payload);

      // Si on vient de generer un BtoC, on stocke les scores axes en session
      // pour que le BtoB ulterieur puisse les reutiliser et garantir la coherence.
      const updatedSessionState = {
        ...state,
        axes,
        clinicalFlags
      };
      if (mode === 'bilan_btc' && result.axisScores) {
        updatedSessionState.btcAxisScores = result.axisScores;
      }

      return res.status(200).json({
        content: [{ type: 'text', text: responseText }],
        category,
        model: result.raw?.model || 'claude-haiku-4-5-20251001',
        usage: result.raw?.usage || { input_tokens: 0, output_tokens: 0 },
        sessionState: updatedSessionState,
        bilanDebug: result.debug
      });
    } catch (err) {
      console.error('[psee-bilan] failed:', err.message, '| stack:', err.stack);
      return res.status(500).json({
        error: {
          message: 'Generation du bilan impossible. Reessayez dans un instant.',
          // Detail technique pour DevTools (visible cote console front)
          debug: err.message
        }
      });
    }
  }

  // 6. Sinon appel Anthropic habituel
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
        max_tokens: 8192, // Augmenté V3.5 — BtC JSON enrichi peut dépasser 4096 (actions tronqué)
        // Prompt caching : le prompt système de collecte est mis en cache 5 min,
        // réduisant la consommation tokens/min sur toute la durée de la conversation.
        system: [{ type: 'text', text: resolveSystemPrompt(mode, triggeredModules, passationContext), cache_control: { type: 'ephemeral' } }],
        messages: messages
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    const aiText = data.content?.[0]?.text || '';
    if (isUnsafeOutput(aiText)) {
      logIncident('output_filtered', ip);
      return res.status(200).json(buildReply(POLICIES.output_filtered, 'output_filtered'));
    }

    data.category = category;
    data.sessionState = {
      ...state,
      axes,
      clinicalFlags
    };
    // Liste des modules psychometriques pour lesquels une passation finale
    // serait pertinente. Le front l'utilise quand COMPLET:[oui] est detecte
    // pour basculer en mode passation_finale avant de generer le bilan.
    data.triggeredModules = triggeredModules;

    return res.status(200).json(data);

  } catch (error) {
    console.error('[psee-safety] api error:', error?.message);
    return res.status(500).json({
      error: { message: POLICIES.fallback }
    });
  }
}

// -----------------------------
// SESSION STATE
// -----------------------------
function normalizeSessionState(sessionState = {}) {
  return {
    axes: sessionState.axes || {
      axis1: null,
      axis2: null,
      axis3: null,
      axis4: null,
      axis5: null,
      axis6: null
    },
    completedModules: Array.isArray(sessionState.completedModules)
      ? sessionState.completedModules
      : [],
    moduleResults: Array.isArray(sessionState.moduleResults)
      ? sessionState.moduleResults
      : [],
    responseTimes: Array.isArray(sessionState.responseTimes)
      ? sessionState.responseTimes
      : [],
    attentionCheckFailed: Boolean(sessionState.attentionCheckFailed),
    pendingModule: sessionState.pendingModule || null,
   clinicalFlags: sessionState.clinicalFlags || {},
    btcAxisScores: sessionState.btcAxisScores || null
  };
}

// -----------------------------
// CLINICAL FLAGS
// -----------------------------
function extractClinicalFlags(text = '') {
  const t = normalize(text);

  return {
    sadness: hasAny(t, ['triste', 'tristesse', 'abattu', 'deprim', 'desesp', 'vide']),
    anhedonia: hasAny(t, ['plus envie', 'plus de plaisir', 'aucun plaisir', 'rien ne m interesse', 'perte d envie']),
    fatigue: hasAny(t, ['fatigu', 'epuis', 'sans energie', 'vide']),
    guilt: hasAny(t, ['culpabil', 'je m en veux', 'honte', 'echec']),
    hopelessness: hasAny(t, ['sans espoir', 'aucun avenir', 'ca ne sert a rien']),
    lowSelfWorth: hasAny(t, ['nul', 'sans valeur', 'je ne vaux rien', 'inutil']),
    sleepIssues: hasAny(t, ['insom', 'je dors mal', 'reveils nocturnes', 'sommeil']),

    worry: hasAny(t, ['inquiet', 'inquiete', 'angoiss', 'anxie']),
    rumination: hasAny(t, ['rumin', 'je pense trop', 'pensees qui tournent', 'obsed']),
    tension: hasAny(t, ['tendu', 'stresse', 'pression', 'oppression']),
    hypervigilance: hasAny(t, ['hypervigil', 'sur le qui vive', 'alerte en permanence']),
    irritability: hasAny(t, ['irritable', 'je m agace', 'enerve']),
    restlessness: hasAny(t, ['agite', 'impossible de me poser', 'je tourne en rond']),
    panicLikeSymptoms: hasAny(t, ['crise d angoisse', 'panique', 'palpitations']),

    overload: hasAny(t, ['debord', 'submerg', 'trop de choses', 'satur']),
    lossOfControl: hasAny(t, ['perds le controle', 'je n y arrive plus', 'je ne maitrise plus']),
    mentalLoad: hasAny(t, ['charge mentale', 'pression mentale', 'trop dans la tete']),
    exhaustion: hasAny(t, ['epuis', 'lessive', 'burn out', 'burnout']),
    burnoutFeeling: hasAny(t, ['au bord', 'craqu', 'effondre']),

    suicidalIdeation: hasAny(t, ['envie d en finir', 'suicide', 'me tuer', 'disparaitre', 'mort serait plus simple'])
  };
}

// -----------------------------
// AXES
// -----------------------------
function updateAxesFromFlags(previousAxes = {}, flags = {}) {
  return {
    axis1: scoreAxis1(flags, previousAxes.axis1),
    axis2: scoreAxis2(flags, previousAxes.axis2),
    axis3: scoreAxis3(flags, previousAxes.axis3),
    axis4: scoreAxis4(flags, previousAxes.axis4),
    axis5: scoreAxis5(flags, previousAxes.axis5),
    axis6: scoreAxis6(flags, previousAxes.axis6)
  };
}

function scoreAxis1(flags, prev) {
  let score = base(prev);
  if (flags.rumination) score += 1;
  if (flags.guilt) score += 1;
  if (flags.hopelessness) score += 1;
  return clamp(score, 0, 4);
}

function scoreAxis2(flags, prev) {
  let score = base(prev);
  if (flags.fatigue) score += 1;
  if (flags.anhedonia) score += 1;
  if (flags.hopelessness) score += 1;
  return clamp(score, 0, 4);
}

function scoreAxis3(flags, prev) {
  let score = base(prev);
  if (flags.restlessness) score += 1;
  if (flags.irritability) score += 1;
  if (flags.overload) score += 1;
  return clamp(score, 0, 4);
}

function scoreAxis4(flags, prev) {
  let score = base(prev);
  if (flags.sadness) score += 1;
  if (flags.worry) score += 1;
  if (flags.tension) score += 1;
  return clamp(score, 0, 4);
}

function scoreAxis5(flags, prev) {
  let score = base(prev);
  if (flags.sleepIssues) score += 1;
  if (flags.tension) score += 1;
  if (flags.panicLikeSymptoms) score += 1;
  return clamp(score, 0, 4);
}

function scoreAxis6(flags, prev) {
  let score = base(prev);
  if (flags.overload) score += 1;
  if (flags.mentalLoad) score += 1;
  if (flags.lossOfControl) score += 1;
  return clamp(score, 0, 4);
}

// -----------------------------
// INCONSISTENCIES
// -----------------------------
function detectInconsistencies(messages = []) {
  const text = messages
    .filter(m => m?.role === 'user')
    .map(m => String(m.content || ''))
    .join('\n')
    .toLowerCase();

  const inconsistencies = [];

  if (text.includes('je dors bien') && /je dors mal|insom|reveils nocturnes/.test(text)) {
    inconsistencies.push('Sommeil contradictoire');
  }

  if (text.includes('je vais bien') && /triste|angoiss|epuis|desesp/.test(text)) {
    inconsistencies.push('Auto-evaluation globale contradictoire');
  }

  if (text.includes('aucune anxi') && /angoiss|panique|inquiet/.test(text)) {
    inconsistencies.push('Anxiete contradictoire');
  }

  return inconsistencies;
}

// -----------------------------
// BILAN (BTC / BTB) - orchestration
// -----------------------------
// Cette section gere la generation du bilan final. Elle fait deux appels
// Haiku en parallele :
//   1. Appel narratif : le LLM produit la partie texte (synthese, axes, etc.)
//      en suivant strictement le format JSON impose par BILAN_BTC_SYS ou BILAN_BTB_SYS.
//   2. Appel scoring : le LLM lit le transcript et score item par item les
//      modules psychometriques triggeres pour cette session. On lui laisse
//      mettre null pour les items non couverts par le recit.
// Puis le serveur :
//   - Calcule les scores totaux via les formules officielles (psychometrics.js).
//   - Extrapole proportionnellement si >= 60% d items couverts.
//   - Calcule la passation via passationQuality.js.
//   - Fusionne le tout dans un payload unifie.

// CHANTIER 2.2 : seuil baisse de 0.6 a 0.4 pour permettre des scores
// indicatifs plus tot. Avec 0.6, sur Fanny (GAD7 1/7 = 0.14) le bilan
// affichait "a completer" meme apres passation. Avec 0.4, des qu on a
// ~3 items sur 7, on produit un score indicatif (clairement marque
// "estimation indicative" cote UI) plutot que de cacher le module.
// La balise isPartial reste affichee, donc l utilisateur sait que c est
// une estimation et non un score formel.
const BILAN_COVERAGE_THRESHOLD = 0.4;

function buildScoringPrompt(modulesToScore) {
  const moduleSpecs = {
    PHQ9: {
      title: 'PHQ-9',
      scale: '0=jamais, 1=quelques jours, 2=plus de la moitie des jours, 3=presque tous les jours',
      timeframe: '14 derniers jours',
      items: PHQ9.items
    },
    GAD7: {
      title: 'GAD-7',
      scale: '0=jamais, 1=quelques jours, 2=plus de la moitie des jours, 3=presque tous les jours',
      timeframe: '14 derniers jours',
      items: GAD7.items
    },
    PSS10: {
      title: 'PSS-10',
      scale: '0=jamais, 1=presque jamais, 2=parfois, 3=assez souvent, 4=tres souvent',
      timeframe: 'dernier mois',
      items: PSS10.items
    }
  };

  const sections = modulesToScore.map(id => {
    const spec = moduleSpecs[id];
    if (!spec) return '';
    const itemsList = spec.items
      .map((item, i) => `  ${i}: "${item}"`)
      .join('\n');
    return `MODULE ${id} (${spec.title})
Echelle : ${spec.scale}
Periode : ${spec.timeframe}
Items :
${itemsList}`;
  }).join('\n\n');

  return `Tu es l'evaluateur psychometrique Psee. Tu lis un transcript d entretien et tu scores chaque item des modules indiques en te basant UNIQUEMENT sur ce que la personne a dit.

REGLES DE SCORING
- Tu retournes UNIQUEMENT du JSON valide, sans texte avant ni apres, sans markdown.
- Pour chaque item, tu mets soit un nombre selon l echelle officielle, soit null si le sujet de l item n est PAS DU TOUT aborde dans le recit.
- Pour PSS-10 items 4, 5, 7, 8 (capacites preservees), tu scores la capacite telle qu elle est rapportee, sans inverser : l inversion est appliquee plus tard cote serveur.

QUAND SCORER (CALIBRATION IMPORTANTE)
- Si la personne nomme explicitement le symptome de l item avec une frequence claire ("je dors mal presque tous les jours") -> tu scores selon la frequence rapportee.
- Si la personne decrit le PROCESSUS sous-jacent a l item meme sans utiliser le mot exact, tu scores en estimant la frequence sur la base du contexte. Quelques exemples concrets :
  * "j ai du mal a etre presente" / "pensees qui s eparpillent" / "vide mental" -> couvre l item "difficultes de concentration"
  * "pas de plaisir a manger" / "j ai perdu le gout" -> couvre l item "perte d appetit"
  * "je ne dors pas bien" / "cauchemars qui me reveillent" / "1h pour me rendormir" -> couvre l item "difficultes a s endormir / rester endormi"
  * "angoisse plusieurs fois par semaine" / "moments d anxiete" -> couvre l item "nervosite, anxiete, sensation d etre sur les nerfs"
  * "je n arrive plus a me detendre" / "tension permanente" -> couvre l item "difficulte a se detendre"
  * "j ai peur que ca recommence" / "vigilance constante" -> couvre l item "peur qu un evenement grave puisse se produire"
- Frequence implicite : si la personne dit "plusieurs fois par semaine" -> niveau 2 ; "tous les jours" / "presque tous les jours" / "constamment" -> niveau 3 ; "quelques fois" / "parfois" -> niveau 1 ; "depuis X mois sans interruption" -> niveau 3.
- Si la personne mentionne le sujet mais sans aucune indication de frequence ni d intensite -> tu peux scorer 1 par defaut (presence faible documentee).

QUAND METTRE null
- Reserve null aux items dont le SUJET n est pas du tout aborde dans le recit. Pas de mention directe, pas de mention indirecte, pas de description du processus sous-jacent.
- Tu ne devines pas et tu n inferes pas a partir d un diagnostic suppose. Le recit doit toucher le sujet de l item d une maniere ou d une autre.

MODULES A SCORER

${sections}

FORMAT DE SORTIE
Retourne un JSON exactement de cette forme (avec uniquement les modules demandes) :
{
${modulesToScore.map(id => `  "${id}": [${moduleSpecs[id]?.items.map(() => 'number_or_null').join(', ') || ''}]`).join(',\n')}
}

Chaque tableau doit avoir EXACTEMENT le bon nombre d items dans l ordre de la liste ci-dessus.`;
}

async function callHaikuJson(systemPrompt, userMessages) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 16000, // Augmente pour bilans BtoB enrichis V3.5 (anciennement 8192, tronqué à ~27000 chars)
      // Prompt caching : le prompt système (~24K chars BILAN_BTB_SYS) est mis en
      // cache 5 min côté Anthropic. Les appels suivants ne le recomptent plus dans
      // la limite tokens/min, ce qui évite le dépassement du rate limit.
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: userMessages
    })
  });

  const data = await response.json();
  if (!response.ok) {
    console.error('[psee-haiku-json] HTTP error', response.status, data?.error?.message || data);
    const err = new Error(data?.error?.message || 'Haiku call failed (HTTP ' + response.status + ')');
    err.status = response.status;
    err.data = data;
    throw err;
  }

  const text = data.content?.[0]?.text || '';
  if (!text) {
    console.error('[psee-haiku-json] empty response | stop_reason=', data.stop_reason, '| usage=', data.usage);
    throw new Error('Haiku response is empty (stop_reason: ' + (data.stop_reason || 'unknown') + ')');
  }

  // Detection de troncation (max_tokens atteint sans fin de generation)
  if (data.stop_reason === 'max_tokens') {
    console.warn('[psee-haiku-json] response was truncated by max_tokens, attempting to parse anyway');
  }

  // Strategie de parsing robuste :
  // 1. Strip markdown fences (```json ... ```)
  // 2. Trouve le PREMIER { et le DERNIER } (greedy match)
  // 3. Tente le parse, et en cas d'echec, tente une reparation simple
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');

  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    console.error('[psee-haiku-json] no JSON braces found | text_preview=', text.slice(0, 300));
    throw new Error('Haiku response contains no JSON: ' + text.slice(0, 200));
  }

  const jsonStr = cleaned.slice(firstBrace, lastBrace + 1);

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    // Tentative de reparation : retire les virgules en trop avant } ou ]
    const repaired = jsonStr.replace(/,(\s*[}\]])/g, '$1');
    try {
      parsed = JSON.parse(repaired);
      console.warn('[psee-haiku-json] JSON parse succeeded after repair (trailing comma fix)');
    } catch (e2) {
      console.error('[psee-haiku-json] JSON parse failed | error=', e.message, '| jsonStr length=', jsonStr.length, '| preview=', jsonStr.slice(0, 500), '| end=', jsonStr.slice(-200));
      const err = new Error('Haiku JSON parse failed: ' + e.message);
      err.rawText = text;
      err.rawJsonStr = jsonStr;
      throw err;
    }
  }
  return { parsed, raw: data };
}

// Variante Sonnet pour les tâches nécessitant des outputs JSON longs et stables.
// Utilisée uniquement pour l'extraction clinique V1.3 (JSON ~25k chars).
async function callSonnetJson(systemPrompt, userMessages) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5-20251022',
      max_tokens: 16000,
      // Prompt caching : le prompt système est mis en cache 5 min côté Anthropic
      // pour ne plus le recompter dans la limite tokens/min sur les appels suivants.
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: userMessages
    })
  });

  const data = await response.json();
  if (!response.ok) {
    console.error('[psee-sonnet-json] HTTP error', response.status, data?.error?.message || data);
    const err = new Error(data?.error?.message || 'Sonnet call failed (HTTP ' + response.status + ')');
    err.status = response.status;
    err.data = data;
    throw err;
  }

  const text = data.content?.[0]?.text || '';
  if (!text) {
    console.error('[psee-sonnet-json] empty response | stop_reason=', data.stop_reason);
    throw new Error('Sonnet response is empty (stop_reason: ' + (data.stop_reason || 'unknown') + ')');
  }

  if (data.stop_reason === 'max_tokens') {
    console.warn('[psee-sonnet-json] response was truncated by max_tokens');
  }

  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');

  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    console.error('[psee-sonnet-json] no JSON braces found | text_preview=', text.slice(0, 300));
    throw new Error('Sonnet response contains no JSON: ' + text.slice(0, 200));
  }

  const jsonStr = cleaned.slice(firstBrace, lastBrace + 1);

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    const repaired = jsonStr.replace(/,(\s*[}\]])/g, '$1');
    try {
      parsed = JSON.parse(repaired);
      console.warn('[psee-sonnet-json] JSON parse succeeded after repair');
    } catch (e2) {
      console.error('[psee-sonnet-json] JSON parse failed | error=', e.message, '| length=', jsonStr.length);
      const err = new Error('Sonnet JSON parse failed: ' + e.message);
      err.rawText = text;
      throw err;
    }
  }

  console.log('[psee-sonnet-json] success | tokens_in=', data.usage?.input_tokens, '| tokens_out=', data.usage?.output_tokens);
  return { parsed, raw: data };
}

function buildIndicateurFromScoring(moduleId, scoredArray, auditId = null) {
  const module = getPsychometricModule(moduleId);
  if (!module) return null;

  const totalItems = module.items.length;
  const validValues = [];
  const validIndexes = [];
  const nullIndexes = [];

  scoredArray.forEach((v, i) => {
    if (v !== null && v !== undefined && Number.isFinite(Number(v))) {
      validValues.push(Number(v));
      validIndexes.push(i);
    } else {
      nullIndexes.push(i);
    }
  });

  const itemsCovered = validValues.length;
  const coverage = totalItems > 0 ? itemsCovered / totalItems : 0;

  // Definition du max selon l echelle du module
  const maxPerItem = moduleId === 'PSS10' ? 4 : 3;
  const maxTotal = totalItems * maxPerItem;

  // Helper de log d'audit (anonyme, RGPD-friendly)
  const logAudit = (decision, finalScore) => {
    console.log('[psee-psychometrics-audit] ' + JSON.stringify({
      auditId,
      module: moduleId,
      itemsCovered,
      itemsTotal: totalItems,
      coverage: Math.round(coverage * 100) / 100,
      nullIndexes,
      rawValues: scoredArray.map(v =>
        v !== null && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : null
      ),
      decision,
      finalScore
    }));
  };

  // Si couverture insuffisante : pas de score, indicateur partiel
  if (coverage < BILAN_COVERAGE_THRESHOLD) {
    logAudit('incomplete', null);
    return {
      id: moduleId,
      label: module.title,
      timeframe: module.timeframe,
      score: null,
      max: maxTotal,
      interpretation: 'passation incomplete (signaux reperes mais nombre d items insuffisant pour scorer)',
      items_couverts: itemsCovered,
      items_total: totalItems,
      coverage_ratio: Math.round(coverage * 100) / 100,
      caution: 'Ce module n a pas pu etre score completement faute d elements suffisants dans l entretien. Une passation formelle est recommandee.'
    };
  }

  // Couverture suffisante : on calcule le score sur les items repondus,
  // puis on extrapole proportionnellement au total du module.
  // Pour PSS10, scoreModule applique deja l inversion sur les indexes de
  // reverseScoredIndexes — il faut donc passer un tableau de la bonne
  // longueur avec des 0 sur les positions manquantes pour ne pas casser
  // l index de reference. Strategie : on remplit les manquants avec la
  // moyenne des reponses obtenues pour ne pas biaiser, puis on score.
  const meanValid = validValues.reduce((a, b) => a + b, 0) / validValues.length;

  const filledArray = scoredArray.map((v, i) => {
    if (validIndexes.includes(i)) return Number(v);
    return meanValid; // imputation par la moyenne des reponses obtenues
  });

  const score = scoreModule(moduleId, filledArray);
  const interpretation = interpretModule(moduleId, score);

  const decision = itemsCovered === totalItems ? 'complete' : 'extrapolated';
  logAudit(decision, Math.round(score));

  return {
    id: moduleId,
    label: module.title,
    timeframe: module.timeframe,
    score: Math.round(score),
    max: maxTotal,
    interpretation,
    items_couverts: itemsCovered,
    items_total: totalItems,
    coverage_ratio: Math.round(coverage * 100) / 100,
    caution: itemsCovered === totalItems
      ? 'Score complet base sur les elements rapportes dans l entretien.'
      : `Score extrapole : ${itemsCovered}/${totalItems} items couverts par l entretien, les items manquants ont ete imputes par la moyenne des reponses obtenues.`
  };
}

async function scoreModulesFromTranscript(transcript, modulesToScore, auditId = null) {
  if (!modulesToScore || modulesToScore.length === 0) return [];

  try {
    const scoringPrompt = buildScoringPrompt(modulesToScore);
    const userMsg = [{
      role: 'user',
      content: `Voici le transcript de l entretien. Score les modules demandes.\n\n----- TRANSCRIPT -----\n${transcript}\n----- FIN TRANSCRIPT -----`
    }];

    const { parsed } = await callHaikuJson(scoringPrompt, userMsg);

    const indicateurs = [];
    for (const moduleId of modulesToScore) {
      const arr = parsed[moduleId];
      if (!Array.isArray(arr)) continue;
      const indicateur = buildIndicateurFromScoring(moduleId, arr, auditId);
      if (indicateur) indicateurs.push(indicateur);
    }
    return indicateurs;
  } catch (err) {
    console.error('[psee-bilan] scoring failed:', err.message);
    return []; // en cas d echec, on retourne vide plutot que casser le bilan
  }
}

function buildTranscriptFromMessages(messages) {
  return messages
    .filter(m => m?.role === 'user' || m?.role === 'assistant')
    .map(m => {
      const role = m.role === 'user' ? 'PERSONNE' : 'PSEE';
      // On retire les balises AXES:[...] COMPLET:[...] pour alleger
      const content = String(m.content || '')
        .replace(/AXES:\[[^\]]*\]\s*COMPLET:\[[^\]]*\]\s*$/i, '')
        .trim();
      return `${role}: ${content}`;
    })
    .join('\n\n');
}

// -----------------------------------------------------------------------------
// COHERENCE BTC/BTB : extraction et reutilisation des scores axes
// -----------------------------------------------------------------------------
// Les bilans BtoC et BtoB sont generes par deux appels API separes au LLM.
// Sans precaution, le LLM peut produire des scores differents pour les memes
// axes (notamment Environnement qui n'a pas de garde-fou psychometrique).
// Solution : extraire les scores du BtoC apres generation, les stocker en
// sessionState, et les reinjecter dans le prompt BtoB pour garantir la coherence.

function extractAxisScores(narrative) {
  if (!narrative || !Array.isArray(narrative.axes)) return null;
  const scores = {};
  narrative.axes.forEach(axe => {
    if (axe && typeof axe.num === 'number' && typeof axe.score === 'number') {
      scores[`axis${axe.num}`] = axe.score;
    }
  });
  return Object.keys(scores).length === 6 ? scores : null;
}

function buildBtbScoreInjection(referenceScores) {
  if (!referenceScores) return '';
  const lines = Object.entries(referenceScores).map(([key, score]) => {
    const num = key.replace('axis', '');
    return `Axe ${num} : score ${score}/4`;
  });
  return `

REFERENCE DE SCORING — COHERENCE AVEC LE BILAN PATIENT (REGLE PRIORITAIRE)
Les scores des 6 axes ont ete etablis lors de la generation du bilan patient (BtoC) pour cette meme session.
Tu DOIS reutiliser EXACTEMENT ces scores. C'est une question de coherence : le therapeute et le patient doivent voir les memes scores pour pouvoir dialoguer.
Scores de reference :
${lines.join('\n')}
Ton role est de fournir UNIQUEMENT le wording (manifestations, systemes, lecture clinique, redflags, axes therapeutiques, forces, vigilance) AUTOUR de ces scores. Ne les modifie jamais, meme si tu pense qu'ils devraient etre differents.
`;
}

function applyReferenceScores(narrative, referenceScores) {
  if (!narrative || !Array.isArray(narrative.axes) || !referenceScores) return narrative;
  narrative.axes = narrative.axes.map(axe => {
    if (axe && typeof axe.num === 'number') {
      const refScore = referenceScores[`axis${axe.num}`];
      if (typeof refScore === 'number') {
        return { ...axe, score: refScore };
      }
    }
    return axe;
  });
  return narrative;
  }
// ============================================================================
// PIPELINE V1.3 SÉQUENTIEL — buildBilanPayloadV13 (Chantier 3)
// ============================================================================
// Pipeline en 3 étapes SÉQUENTIELLES (un appel Anthropic à la fois) :
//   1. EXTRACTION_SYS         : transcript → JSON clinique V1.3 brut
//   2. applyClinicalRules     : JSON brut → jsonFull + jsonForNarrative (déterministe, pas d'appel API)
//   3. GENERATION_NARRATIVE_BTC_SYS : jsonForNarrative → bilan patient
//
// Avantage vs pipeline classique : pas de double appel parallèle, donc pas
// de saturation du rate limit Anthropic. Cohérence garantie entre le JSON
// clinique (analyse différentielle) et le bilan (prose patient).
//
// Le format de sortie est IDENTIQUE à buildBilanPayload classique pour que
// le front et le rendu PDF fonctionnent sans modification.
// ============================================================================
async function buildBilanPayloadV13({ messages, state, axes, clinicalFlags }) {
  const auditId = Math.random().toString(36).slice(2, 10);
  const sessionId = state.sessionId || 'unknown';

  console.log('[psee-bilan-v13] ' + JSON.stringify({ auditId, event: 'start', sessionId, turnCount: messages.length }));

  // --- ÉTAPE 1 : EXTRACTION CLINIQUE V1.3 ---
  const transcriptLines = messages.map(m => {
    const role = m.role === 'user' ? 'UTILISATEUR' : 'PSEE';
    return `${role}: ${String(m.content || '').trim()}`;
  });

  const moduleResults = state.moduleResults || [];
  const moduleResultsBlock = moduleResults.length > 0
    ? '\n\nRESULTATS PSYCHOMETRIQUES DEJA CALCULES :\n' + JSON.stringify(moduleResults, null, 2)
    : '';

  const extractionUserMessage = `TRANSCRIPT COMPLET DE LA SESSION PSEE

Session ID : ${sessionId}
Date : ${new Date().toISOString()}
Tours total : ${messages.length}
Messages utilisateur : ${messages.filter(m => m.role === 'user').length}${moduleResultsBlock}

TRANSCRIPT :

${transcriptLines.join('\n\n')}

---

Produis maintenant le JSON clinique V1.3 conforme au schema decrit dans le system prompt. Aucun texte avant ni apres le JSON.`;

  console.log('[psee-bilan-v13] ' + JSON.stringify({ auditId, event: 'extraction_start' }));

  let jsonV13;
  try {
    // Extraction sur Sonnet (pas Haiku) : le JSON V1.3 dépasse ~25k chars,
    // Haiku le tronque systématiquement avant la fermeture. Sonnet est plus
    // stable sur les outputs longs structurés.
    const extractionResult = await callSonnetJson(
      EXTRACTION_SYS,
      [{ role: 'user', content: extractionUserMessage }]
    );
    jsonV13 = extractionResult.parsed;
  } catch (err) {
    console.error('[psee-bilan-v13] extraction failed:', err.message);
    throw new Error('Pipeline V1.3 - extraction échouée : ' + err.message);
  }

  console.log('[psee-bilan-v13] ' + JSON.stringify({ auditId, event: 'extraction_done' }));

  // --- ÉTAPE 2 : RULE ENGINE (déterministe, pas d'appel API) ---
  let jsonFull, jsonForNarrative, validation;
  try {
    const ruleResult = applyClinicalRules(jsonV13);
    jsonFull = ruleResult.jsonFull;
    jsonForNarrative = ruleResult.jsonForNarrative;
    validation = ruleResult.validation;
  } catch (err) {
    console.error('[psee-bilan-v13] rule engine failed:', err.message);
    throw new Error('Pipeline V1.3 - rule engine échoué : ' + err.message);
  }

  console.log('[psee-bilan-v13] ' + JSON.stringify({
    auditId, event: 'rules_done',
    validationValid: validation.valid,
    missingFields: validation.missing_fields
  }));

  // --- ÉTAPE 3 : GÉNÉRATION NARRATIVE À PARTIR DU JSON FILTRÉ ---
  const narrativeUserMessage = `JSON CLINIQUE V1.3 (filtré pour génération narrative) :

${JSON.stringify(jsonForNarrative, null, 2)}

---

Génère maintenant le bilan patient au format JSON décrit dans le system prompt. Aucun texte avant ni après le JSON.`;

  console.log('[psee-bilan-v13] ' + JSON.stringify({ auditId, event: 'narrative_start' }));

  let narrative, narrativeRaw;
  try {
    const narrativeResult = await callHaikuJson(
      GENERATION_NARRATIVE_BTC_SYS,
      [{ role: 'user', content: narrativeUserMessage }]
    );
    narrative = narrativeResult.parsed;
    narrativeRaw = narrativeResult.raw;
  } catch (err) {
    console.error('[psee-bilan-v13] narrative failed:', err.message);
    throw new Error('Pipeline V1.3 - génération narrative échouée : ' + err.message);
  }

  console.log('[psee-bilan-v13] ' + JSON.stringify({ auditId, event: 'narrative_done' }));

  // --- CALCUL PASSATION (côté serveur, rigoureux, comme pipeline classique) ---
  const answers = messages
    .filter(m => m?.role === 'user')
    .map(m => String(m.content || '').trim());

  const inconsistencies = detectInconsistencies(messages);

  const passationMetrics = buildPassationMetrics({
    messages,
    answers,
    responseTimes: state.responseTimes || [],
    inconsistencies,
    attentionCheckFailed: Boolean(state.attentionCheckFailed)
  });

  const passationQuality = computePassationQuality(passationMetrics);

  // --- INDICATEURS PSYCHOMETRIQUES ---
  // En V1.3, les résultats psychométriques calculés en amont (passation finale)
  // sont déjà dans state.moduleResults. On les transmet au format attendu.
  const indicateurs = moduleResults.length > 0 ? moduleResults : [];

  // --- FUSION : format de sortie IDENTIQUE au pipeline classique ---
  const merged = {
    ...narrative,
    indicateurs
  };

  const extractedAxisScores = extractAxisScores(narrative);

  console.log('[psee-bilan-v13] ' + JSON.stringify({ auditId, event: 'complete' }));

  // --- ÉTAPE 4 : STOCKAGE SUPABASE (Chantier 4) ---
  // Best-effort : l'échec du stockage ne bloque jamais le bilan patient.
  // On ne logue que l'auditId (pas de données patient dans les logs).
  const sessionId_forStorage = state.sessionId || 'unknown';
  insertClinicalExtraction({
    extractionId: auditId,
    sessionId: sessionId_forStorage,
    jsonFull,
    schemaVersion: jsonFull?.schema_version || '1.3'
  }).catch(err => {
    console.error('[psee-supabase] insertion failed (non-blocking):', err.message, '| auditId=' + auditId);
  });

  return {
    payload: merged,
    raw: narrativeRaw,
    axisScores: extractedAxisScores,
    // jsonClinicalFull retiré de la réponse HTTP (données INTERNAL_ONLY)
    // Le stockage est désormais fait côté serveur ci-dessus.
    debug: {
      pipeline: 'v13_sequential',
      auditId,
      validationValid: validation.valid,
      missingFields: validation.missing_fields,
      passationQuality: passationQuality?.label
    }
  };
}

// ============================================================================
// PIPELINE V1.3 BtB — buildBilanPayloadV13Btb (CBtB)
// ============================================================================
// Même pipeline séquentiel que buildBilanPayloadV13, mais génère le bilan
// thérapeute avec GENERATION_NARRATIVE_BTB_SYS.
// Sortie : JSON structuré BtB (synthese_clinique, axes, analyse_linguistique,
//          processus_transdiagnostiques, pistes_exploration, passation_note).
// Le format de sortie est différent du BtC — le rendu PDF BtB est distinct.
// ============================================================================
async function buildBilanPayloadV13Btb({ messages, state, axes, clinicalFlags }) {
  const auditId = 'btb_' + Math.random().toString(36).slice(2, 10);

  // --- ÉTAPE 1 : EXTRACTION CLINIQUE (identique au pipeline BtC) ---
  const transcriptLines = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => `[${m.role === 'user' ? 'Patient' : 'Psee'}] ${m.content}`);

  const sessionId = state.sessionId || 'unknown';
  const turnCount = messages.filter(m => m.role === 'assistant').length;
  const userMessageCount = messages.filter(m => m.role === 'user').length;
  const moduleResults = state.moduleResults || [];
  const moduleResultsBlock = moduleResults.length > 0
    ? '\n\nRESULTATS PSYCHOMETRIQUES DEJA CALCULES :\n' + JSON.stringify(moduleResults, null, 2)
    : '';

  const extractionUserMessage = `TRANSCRIPT COMPLET DE LA SESSION PSEE

Session ID : ${sessionId}
Date : ${new Date().toISOString()}
Tours total : ${turnCount}
Messages utilisateur : ${userMessageCount}${moduleResultsBlock}

TRANSCRIPT :

${transcriptLines.join('\n\n')}

---

Produis maintenant le JSON clinique V1.3 conforme au schema decrit dans le system prompt. Aucun texte avant ni apres le JSON.`;

  console.log('[psee-bilan-v13-btb] ' + JSON.stringify({ auditId, event: 'extraction_start' }));

  let jsonV13;
  try {
    const extractionResult = await callSonnetJson(
      EXTRACTION_SYS,
      [{ role: 'user', content: extractionUserMessage }]
    );
    jsonV13 = extractionResult.parsed;
  } catch (err) {
    console.error('[psee-bilan-v13-btb] extraction failed:', err.message);
    throw new Error('Pipeline V1.3 BtB - extraction échouée : ' + err.message);
  }

  // --- ÉTAPE 2 : RULE ENGINE ---
  let jsonFull, jsonForNarrative, validation;
  try {
    const ruleResult = applyClinicalRules(jsonV13);
    jsonFull = ruleResult.jsonFull;
    jsonForNarrative = ruleResult.jsonForNarrative;
    validation = ruleResult.validation;
  } catch (err) {
    console.error('[psee-bilan-v13-btb] rule engine failed:', err.message);
    throw new Error('Pipeline V1.3 BtB - rule engine échoué : ' + err.message);
  }

  // Injection des scores BtC si disponibles (cohérence inter-bilans)
  const btcScoresBlock = state.btcAxisScores
    ? '\n\nSCORES DU BILAN BTC (même session — assurer la cohérence) :\n' + JSON.stringify(state.btcAxisScores, null, 2)
    : '';

  // --- ÉTAPE 3 : GÉNÉRATION NARRATIVE BTB ---
  const narrativeUserMessage = `JSON CLINIQUE V1.3 (filtré pour génération bilan thérapeute) :

${JSON.stringify(jsonForNarrative, null, 2)}${btcScoresBlock}

---

Génère maintenant le bilan thérapeute au format JSON décrit dans le system prompt. Aucun texte avant ni après le JSON.`;

  console.log('[psee-bilan-v13-btb] ' + JSON.stringify({ auditId, event: 'narrative_start' }));

  let narrative, narrativeRaw;
  try {
    const narrativeResult = await callHaikuJson(
      GENERATION_NARRATIVE_BTB_SYS,
      [{ role: 'user', content: narrativeUserMessage }]
    );
    narrative = narrativeResult.parsed;
    narrativeRaw = narrativeResult.raw;
  } catch (err) {
    console.error('[psee-bilan-v13-btb] narrative failed:', err.message);
    throw new Error('Pipeline V1.3 BtB - génération narrative échouée : ' + err.message);
  }

  console.log('[psee-bilan-v13-btb] ' + JSON.stringify({ auditId, event: 'complete' }));

  // Stockage Supabase best-effort
  insertClinicalExtraction({
    extractionId: auditId,
    sessionId,
    jsonFull,
    schemaVersion: jsonFull?.schema_version || '1.3'
  }).catch(err => {
    console.error('[psee-supabase-btb] insertion failed (non-blocking):', err.message);
  });

  return {
    payload: narrative,
    raw: narrativeRaw,
    debug: {
      pipeline: 'v13_btb_sequential',
      auditId,
      validationValid: validation.valid,
      missingFields: validation.missing_fields
    }
  };
}

async function buildBilanPayload({ mode, messages, state, axes, clinicalFlags, ip }) {
  const isBtb = mode === 'bilan_btb';

  // ROUTAGE PIPELINE V1.3 (Chantier 3 + CBtB) :
  // Si le flag est actif, on utilise le pipeline séquentiel V1.3 pour BtC ET BtB.
  if (USE_V13_PIPELINE && !isBtb) {
    return buildBilanPayloadV13({ messages, state, axes, clinicalFlags });
  }
  if (USE_V13_PIPELINE && isBtb) {
    return buildBilanPayloadV13Btb({ messages, state, axes, clinicalFlags });
  }

  const baseSystemPrompt = isBtb ? BILAN_BTB_SYS : BILAN_BTC_SYS;
  
  // Coherence BtoC/BtoB : si on genere un BtoB et qu'on a deja les scores du BtoC en session,
  // on les injecte dans le prompt pour forcer la reutilisation.
  const referenceScores = (isBtb && state.btcAxisScores) ? state.btcAxisScores : null;
  const systemPrompt = referenceScores
    ? baseSystemPrompt + buildBtbScoreInjection(referenceScores)
    : baseSystemPrompt;

  // Determiner les modules a scorer : on utilise les flags de la session
  // pour detecter quels modules psychometriques meritent un scoring.
  const modulesToScore = detectSuspicion(clinicalFlags);

  // Audit instrumentation : auditId aleatoire 8 caracteres pour correler
  // les logs d'un meme bilan dans Vercel sans exposer de donnees patient.
  const auditId = Math.random().toString(36).slice(2, 10);
  if (modulesToScore.length > 0) {
    console.log('[psee-psychometrics-audit] ' + JSON.stringify({
      auditId,
      event: 'start',
      mode,
      modules: modulesToScore
    }));
  }

  const transcript = buildTranscriptFromMessages(messages);

  // Appel narratif (Haiku produit le JSON principal)
  const narrativePromise = callHaikuJson(systemPrompt, messages);

  // Appel scoring en parallele (uniquement si modules detectes)
  const scoringPromise = modulesToScore.length > 0
    ? scoreModulesFromTranscript(transcript, modulesToScore, auditId)
    : Promise.resolve([]);

  let narrative, indicateurs, narrativeRaw;
  try {
    const [narrativeResult, indicateursResult] = await Promise.all([
      narrativePromise,
      scoringPromise
    ]);
    narrative = narrativeResult.parsed;
    narrativeRaw = narrativeResult.raw;
    indicateurs = indicateursResult;
  } catch (err) {
    console.error('[psee-bilan] narrative failed:', err.message);
    throw err;
  }

  // Calcul de la passation cote serveur (rigoureux, pas LLM)
  const answers = messages
    .filter(m => m?.role === 'user')
    .map(m => String(m.content || '').trim());

  const inconsistencies = detectInconsistencies(messages);

  const passationMetrics = buildPassationMetrics({
    messages,
    answers,
    responseTimes: state.responseTimes || [],
    inconsistencies,
    attentionCheckFailed: Boolean(state.attentionCheckFailed)
  });

  const passationQuality = computePassationQuality(passationMetrics);

  // Format passation pour le bilan
  const passation = {
    duree_minutes: passationMetrics?.durationMinutes ?? null,
    nb_echanges: answers.length,
    qualite: passationQuality?.label || 'non evaluee',
    notes: [
      passationQuality?.summary,
      inconsistencies.length > 0 ? `Incoherences reperees : ${inconsistencies.join(', ')}` : null,
      state.attentionCheckFailed ? 'Attention check echoue' : null
    ].filter(Boolean).join('. ')
  };

  // Garde-fou coherence BtoC/BtoB : si on a des scores de reference (BtoB avec scores BtoC stockes),
  // on les applique en force au cas ou le LLM aurait quand meme devie.
  if (referenceScores) {
    applyReferenceScores(narrative, referenceScores);
  }

  // Extraction des scores axes pour stockage en session (utile pour generation BtoB ulterieure)
  const extractedAxisScores = extractAxisScores(narrative);

  // Fusion : narratif + indicateurs + passation
  const merged = {
    ...narrative,
    indicateurs
  };

  // BtoB recoit en plus la passation
  if (isBtb) {
    merged.passation = passation;
  }

  return {
    payload: merged,
    raw: narrativeRaw,
    axisScores: extractedAxisScores,
    debug: {
      modulesScored: modulesToScore,
      indicateursCount: indicateurs.length,
      passationQuality: passationQuality?.label,
      referenceScoresUsed: Boolean(referenceScores)
    }
  };
}


function hasAny(text, terms = []) {
  return terms.some(term => text.includes(term));
}

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

function base(prev) {
  return typeof prev === 'number' ? prev : 0;
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function dedupe(arr = []) {
  return [...new Set(arr)];
}

// ============================================================================
// STOCKAGE SUPABASE — insertClinicalExtraction (Chantier 4)
// ============================================================================
// Insère le JSON clinique complet (INTERNAL_ONLY) dans la table
// clinical_extractions. Appel REST direct, pas de SDK Supabase.
// Best-effort : appelé sans await dans le pipeline, un échec ne bloque rien.
//
// Colonnes utilisées :
//   extraction_id  text    — auditId du pipeline V1.3
//   session_id     text    — identifiant opaque de la session
//   json_clinical  jsonb   — jsonFull complet (données cliniques brutes)
//   schema_version text    — version du schéma JSON (ex: "1.3")
//   user_id        uuid    — null pour l'instant (pseudonymité forte)
// ============================================================================
async function insertClinicalExtraction({ extractionId, sessionId, jsonFull, schemaVersion }) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.warn('[psee-supabase] SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY manquant — insertion ignorée');
    return;
  }

  const payload = {
    extraction_id: extractionId,
    session_id: sessionId,
    json_clinical: jsonFull,
    schema_version: String(schemaVersion || '1.3'),
    user_id: null
  };

  const response = await fetch(`${supabaseUrl}/rest/v1/clinical_extractions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '(no body)');
    throw new Error(`Supabase HTTP ${response.status}: ${errText}`);
  }

  console.log('[psee-supabase] clinical_extraction inserted | auditId=' + extractionId);
}
