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
  buildCollectePrompt
} from './systemPrompts.js';
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

const MAX_MODULES_PER_SESSION = 2;

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
  if (!ctx || !ctx.moduleId || !ctx.currentItemIndex && ctx.currentItemIndex !== 0) {
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
  let category = 'normal';
  if (mode === 'collecte' || mode === 'passation_finale' || !mode) {
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    if (lastUserMsg && typeof lastUserMsg.content === 'string') {
      category = classifyInput(lastUserMsg.content);
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
        max_tokens: 4096,
        system: resolveSystemPrompt(mode, triggeredModules, passationContext),
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
      max_tokens: 8192, // Augmente pour bilans BtoB qui sont denses (anciennement 4096, parfois tronques)
      system: systemPrompt,
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
      throw new Error('Haiku JSON parse failed: ' + e.message);
    }
  }
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
async function buildBilanPayload({ mode, messages, state, axes, clinicalFlags, ip }) {
  const isBtb = mode === 'bilan_btb';
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
