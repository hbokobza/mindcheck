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
  buildCollectePrompt
} from './systemPrompts.js';
import { classifyInput, isUnsafeOutput } from './safetyRules.js';
import { POLICIES } from './responsePolicies.js';
import { allowRequest } from './rateLimit.js';

import { detectSuspicion, chooseNextModule } from './suspicionEngine.js';
import {
  getPsychometricModule,
  buildPsychometricResult
} from './psychometrics.js';
import {
  buildPassationMetrics,
  computePassationQuality
} from './passationQuality.js';
import { buildClinicalSynthesis } from './clinicalSynthesis.js';

const MAX_MODULES_PER_SESSION = 2;

// -----------------------------
// SYSTEM PROMPT
// -----------------------------
function resolveSystemPrompt(mode, triggeredModules = []) {
  switch (mode) {
    case 'bilan_btc': return BILAN_BTC_SYS;
    case 'bilan_btb': return BILAN_BTB_SYS;
    case 'collecte':
    default: return buildCollectePrompt(triggeredModules);
  }
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
    moduleSubmission = null
  } = body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      error: { message: 'Messages manquants ou invalides' }
    });
  }

  const state = normalizeSessionState(sessionState);

  // 1. Classification securite du dernier message utilisateur
  let category = 'normal';
  if (mode === 'collecte' || !mode) {
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    if (lastUserMsg && typeof lastUserMsg.content === 'string') {
      category = classifyInput(lastUserMsg.content);
    }
  }

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
        max_tokens: 4096,
        system: resolveSystemPrompt(mode, triggeredModules),
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
    clinicalFlags: sessionState.clinicalFlags || {}
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
// HELPERS
// -----------------------------
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
