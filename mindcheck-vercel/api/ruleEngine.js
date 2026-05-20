// ============================================================================
// ruleEngine.js — Rule Engine déterministe Psee V1.3 (Chantier 2)
// ============================================================================
// Position pipeline :
//   transcript → EXTRACTION_SYS (LLM) → JSON V1.3 brut
//             → applyClinicalRules() (CE FICHIER) → JSON V1.3 enrichi+filtré
//             → GENERATION_NARRATIVE_BTC_SYS (LLM) → bilan patient
//
// Trois fonctions principales en séquence :
//   1. applyArbitrationRules(jsonV13)  : applique R1 à R10
//   2. filterInternalOnly(jsonV13)     : retire les champs INTERNAL_ONLY
//   3. validateStructure(jsonV13)      : vérifie conformité schéma V1.3
//
// Architecture : Option C (un fichier sectionné, une fonction par règle)
// Comportement : Approche B (modifier le JSON + tracer dans rule_engine_arbitrations)
// Filtrage : Niveau 1 strict (suppression complète des champs INTERNAL_ONLY)
//
// V1.0 — 19 mai 2026
// ============================================================================

// ----------------------------------------------------------------------------
// CONSTANTES PARTAGÉES
// ----------------------------------------------------------------------------

const SALIENCY_LEVELS = {
  none: 0,
  low: 1,
  moderate: 2,
  high: 3
};

const SECURITE_LEVELS = {
  none: 0,
  passive_ideation: 1,
  active_ideation: 2,
  plan_present: 3,
  imminent: 4
};

// Helper pour comparer les saillances (string -> niveau numérique)
function saliencyAtLeast(value, threshold) {
  if (value === null || value === undefined) return false;
  const v = SALIENCY_LEVELS[String(value).toLowerCase()] ?? 0;
  const t = SALIENCY_LEVELS[String(threshold).toLowerCase()] ?? 0;
  return v >= t;
}

function securityAtLeast(value, threshold) {
  if (value === null || value === undefined) return false;
  const v = SECURITE_LEVELS[String(value).toLowerCase()] ?? 0;
  const t = SECURITE_LEVELS[String(threshold).toLowerCase()] ?? 0;
  return v >= t;
}

// Helper pour récupérer en sécurité une valeur profonde dans le JSON
function safeGet(obj, path, defaultValue = null) {
  if (!obj) return defaultValue;
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return defaultValue;
    current = current[part];
  }
  return current ?? defaultValue;
}

// Helper pour enregistrer un arbitrage appliqué
function recordArbitration(json, ruleId, applied, note, modifications = null) {
  if (!json.rule_engine_arbitrations) {
    json.rule_engine_arbitrations = {
      engine_version: 'v1.0.0',
      processed_at: new Date().toISOString(),
      rules_applied: []
    };
  }
  json.rule_engine_arbitrations.rules_applied.push({
    rule_id: ruleId,
    applied,
    note,
    modifications: modifications || null,
    timestamp: new Date().toISOString()
  });
}

// ============================================================================
// SECTION 1 — RÈGLES D'ARBITRAGE R1 à R10
// ============================================================================

// ----------------------------------------------------------------------------
// R1 — SÉCURITÉ PRIORITÉ ABSOLUE
// ----------------------------------------------------------------------------
// Si securite_immediate >= active_ideation, on signale qu'une interruption
// aurait dû avoir lieu en amont. Le pipeline continue mais marque l'arbitrage.
// Le prompt narratif a déjà des règles de gestion R1 (mention 3114).
// ----------------------------------------------------------------------------
function applyR1_securite(json) {
  const securite = safeGet(json, 'couche_0_securite_deterministe.securite_immediate', 'none');

  if (securityAtLeast(securite, 'active_ideation')) {
    recordArbitration(json, 'R1', true,
      `Sécurité prioritaire détectée (${securite}). Interruption de collecte aurait dû avoir lieu en amont. Le prompt narratif appliquera ses propres règles de gestion (mention 3114, encadré renforcé).`,
      { securite_immediate_detected: securite }
    );
    // Forcer un flag de gravité pour le prompt narratif
    if (!json._flags) json._flags = {};
    json._flags.security_priority = true;
    json._flags.security_level = securite;
  } else if (securite === 'passive_ideation') {
    recordArbitration(json, 'R1', true,
      `Idéation passive détectée. Le prompt narratif intégrera une mention du 3114 dans le bloc attention.`,
      { securite_immediate_detected: securite }
    );
    if (!json._flags) json._flags = {};
    json._flags.passive_ideation_present = true;
  } else {
    recordArbitration(json, 'R1', false, 'Pas de signal de sécurité immédiate.');
  }
  return json;
}

// ----------------------------------------------------------------------------
// R2 — DÉBRAYAGE TDAH
// ----------------------------------------------------------------------------
// Si tdah_adulte >= 50 ET (depression >= 50 OU anxiete >= 50)
// ET pas de marqueurs développementaux confirmés
// → tdah saliency forcée à low (les difficultés attentionnelles sont
//   probablement secondaires à la dépression/anxiété, pas un TDAH structurel)
// ----------------------------------------------------------------------------
function applyR2_debrayage_tdah(json) {
  const tdah = safeGet(json, 'couche_1_differentiels_psychiatriques.tdah_adulte', {});
  const depression = safeGet(json, 'couche_2_dimensions_structurelles.depression', {});
  const anxiete = safeGet(json, 'couche_2_dimensions_structurelles.anxiete_generalisee', {});

  const tdahScore = tdah.score ?? 0;
  const depScore = depression.score ?? 0;
  const anxScore = anxiete.score ?? 0;
  const devMarkers = tdah.developmental_markers_confirmed === true;

  // Conditions de débrayage
  const tdahPresent = tdahScore >= 50;
  const stateOverlap = depScore >= 50 || anxScore >= 50;

  if (tdahPresent && stateOverlap && !devMarkers) {
    const originalSaliency = tdah.saliency;
    tdah.saliency = 'low';
    tdah.debrayed_by_R2 = true;
    tdah.debrayed_reason = 'Difficultés attentionnelles probablement secondaires à depression/anxiete, pas TDAH structurel (pas de marqueurs développementaux confirmés)';

    recordArbitration(json, 'R2', true,
      `TDAH débrayé : score ${tdahScore} mais comorbidité dep=${depScore}/anx=${anxScore} sans marqueurs développementaux. Saliency forcée à low.`,
      {
        tdah_score: tdahScore,
        depression_score: depScore,
        anxiete_score: anxScore,
        developmental_markers_confirmed: devMarkers,
        saliency_before: originalSaliency,
        saliency_after: 'low'
      }
    );
  } else {
    recordArbitration(json, 'R2', false,
      `R2 non applicable : tdah=${tdahScore}, dep=${depScore}, anx=${anxScore}, devMarkers=${devMarkers}`);
  }
  return json;
}

// ----------------------------------------------------------------------------
// R3 — DISSOCIATION ORIGINE + VERROUILLAGE HYPNOSE
// ----------------------------------------------------------------------------
// Selon dissociation_type, ajoute des contraintes d'orientation.
// trauma_linked → exclusion hypnose dans les modalités matching.
// ----------------------------------------------------------------------------
function applyR3_dissociation(json) {
  const dissoc = safeGet(json, 'couche_2_dimensions_structurelles.dissociation', {});
  const type = dissoc.type;
  const severity = dissoc.severity;

  if (!type || severity === 'mild' || saliencyAtLeast(dissoc.saliency, 'moderate') === false) {
    recordArbitration(json, 'R3', false, `R3 non applicable : type=${type}, severity=${severity}`);
    return json;
  }

  // Initialiser les exclusions marketplace si nécessaire
  if (!json.INTERNAL_ONLY_therapeutic_needs_for_matching) {
    json.INTERNAL_ONLY_therapeutic_needs_for_matching = {};
  }
  const matching = json.INTERNAL_ONLY_therapeutic_needs_for_matching;
  if (!matching.modalities_excluded) matching.modalities_excluded = [];
  if (!matching.modalities_priority) matching.modalities_priority = [];

  if (type === 'trauma_linked') {
    if (!matching.modalities_excluded.includes('hypnose')) {
      matching.modalities_excluded.push('hypnose');
    }
    if (!matching.modalities_priority.includes('approches_centrees_trauma')) {
      matching.modalities_priority.push('approches_centrees_trauma');
    }
    recordArbitration(json, 'R3', true,
      `Dissociation trauma_linked détectée. Hypnose exclue, approches centrées trauma priorisées.`,
      { type, severity }
    );
  } else if (type === 'severe_structural') {
    if (!matching.modalities_priority.includes('psychiatre')) {
      matching.modalities_priority.push('psychiatre');
    }
    recordArbitration(json, 'R3', true,
      `Dissociation severe_structural détectée. Orientation psychiatre priorisée.`,
      { type, severity }
    );
  } else if (type === 'stress_linked') {
    recordArbitration(json, 'R3', true,
      `Dissociation stress_linked : approches régulation/somatiques pertinentes.`,
      { type, severity }
    );
  } else {
    recordArbitration(json, 'R3', false, `R3 type ${type} : pas d'arbitrage spécifique`);
  }
  return json;
}

// ----------------------------------------------------------------------------
// R4 — CONTEXTE VS STRUCTURE DÉPRESSION
// ----------------------------------------------------------------------------
// Si depression >= 40 + contexte déclencheur (burnout/deuil/transition)
// + pas culpabilité indignité
// → marquer depression comme Reactionnel_Contextuel (vs Structurelle).
// Le prompt narratif utilisera la formulation "fléchissement lié au contexte".
// ----------------------------------------------------------------------------
function applyR4_contexte_depression(json) {
  const depression = safeGet(json, 'couche_2_dimensions_structurelles.depression', {});
  const score = depression.score ?? 0;

  if (score < 40) {
    recordArbitration(json, 'R4', false, `R4 non applicable : depression score=${score} < 40`);
    return json;
  }

  // Détection contextuelle
  const contextes = json.contextes_declencheurs || {};
  const hasBurnout = contextes.burnout_effondrement_adaptatif === true;
  const hasDeuil = contextes.deuil_recent === true;
  const hasTransition = contextes.transition_de_vie_majeure === true;
  const hasTrauma = contextes.traumatisme_recent_moins_6_mois === true;
  const hasContext = hasBurnout || hasDeuil || hasTransition || hasTrauma;

  // Marqueurs structurels (à exclure pour confirmer le réactionnel)
  const culpabilite = depression.culpabilite_indignite === true;
  const anhedonieGlobale = depression.anhedonie_globale === true;

  if (hasContext && !culpabilite && !anhedonieGlobale) {
    depression.statut = 'Reactionnel_Contextuel';
    depression.statut_reason = 'Contexte déclencheur identifié + absence marqueurs structurels (culpabilité indignité, anhédonie globale)';

    recordArbitration(json, 'R4', true,
      `Dépression marquée Reactionnel_Contextuel : score ${score}, contextes={burnout:${hasBurnout}, deuil:${hasDeuil}, transition:${hasTransition}, trauma:${hasTrauma}}.`,
      {
        depression_score: score,
        contextes_actifs: { hasBurnout, hasDeuil, hasTransition, hasTrauma },
        culpabilite_indignite: culpabilite,
        anhedonie_globale: anhedonieGlobale
      }
    );
  } else {
    depression.statut = 'Structurelle_ou_Indeterminee';
    recordArbitration(json, 'R4', false,
      `R4 non appliquée : pas de contexte clair OU marqueurs structurels présents (culpabilité=${culpabilite}, anhédonie globale=${anhedonieGlobale})`);
  }
  return json;
}

// ----------------------------------------------------------------------------
// R5 — VERROUILLAGE HYPERCONTRÔLE MATCHING
// ----------------------------------------------------------------------------
// Si hypercontrole >= 65 → ACT/Schémas prioritaires dans matching marketplace.
// Note : aucune incidence sur la prose patient (pas de nommage de méthode).
// ----------------------------------------------------------------------------
function applyR5_hypercontrole(json) {
  const hyper = safeGet(json, 'couche_2_dimensions_structurelles.hypercontrole_obsessionnel', {});
  const score = hyper.score ?? 0;

  if (score < 65) {
    recordArbitration(json, 'R5', false, `R5 non applicable : hypercontrole score=${score} < 65`);
    return json;
  }

  if (!json.INTERNAL_ONLY_therapeutic_needs_for_matching) {
    json.INTERNAL_ONLY_therapeutic_needs_for_matching = {};
  }
  const matching = json.INTERNAL_ONLY_therapeutic_needs_for_matching;
  if (!matching.modalities_priority) matching.modalities_priority = [];

  const additions = ['ACT', 'therapie_des_schemas'];
  additions.forEach(m => {
    if (!matching.modalities_priority.includes(m)) {
      matching.modalities_priority.push(m);
    }
  });

  recordArbitration(json, 'R5', true,
    `Hypercontrôle score ${score} >= 65. ACT et thérapie des schémas priorisés (interne, jamais exposé patient).`,
    { hypercontrole_score: score, modalities_added: additions }
  );
  return json;
}

// ----------------------------------------------------------------------------
// R6 — NEUTRALISATION BORDERLINE (IDENTITÉ + TRAUMA COMPLEXE)
// ----------------------------------------------------------------------------
// Si identite >= 50 ET trauma_complexe >= 60
// → identite saliency = Secondary_Traumato_Induced (pas TPL primaire)
// → Blocage diagnostic TPL (jamais nommé même en interne)
// ----------------------------------------------------------------------------
function applyR6_neutralisation_borderline(json) {
  const identite = safeGet(json, 'couche_2_dimensions_structurelles.identite', {});
  const trauma = safeGet(json, 'couche_2_dimensions_structurelles.trauma_complexe', {});

  const idScore = identite.score ?? 0;
  const trScore = trauma.score ?? 0;

  if (idScore >= 50 && trScore >= 60) {
    const originalSaliency = identite.saliency;
    identite.saliency_modifier = 'Secondary_Traumato_Induced';
    identite.tpl_diagnosis_blocked = true;
    identite.modifier_reason = 'Difficultés identitaires probablement secondaires au trauma complexe, pas TPL primaire';

    recordArbitration(json, 'R6', true,
      `Identité ${idScore} + Trauma complexe ${trScore} : identité marquée Secondary_Traumato_Induced. Blocage diagnostic TPL.`,
      {
        identite_score: idScore,
        trauma_complexe_score: trScore,
        saliency_modifier: 'Secondary_Traumato_Induced'
      }
    );
  } else {
    recordArbitration(json, 'R6', false,
      `R6 non applicable : identite=${idScore}, trauma_complexe=${trScore}`);
  }
  return json;
}

// ----------------------------------------------------------------------------
// R7 — MODULATION TRAUMA COMPLEXE PAR BASE DE SÉCURITÉ
// ----------------------------------------------------------------------------
// Si trauma_complexe >= 50 ET base_de_securite_identifiable
// → score * 0.7 (la base de sécurité atténue la gravité du trauma complexe)
// → Implémentation conditions de cooccurrence (Point 5 du relecteur)
//   trauma_complexe HIGH nécessite cooccurrence (dissociation OU identité
//   OU attachement désorganisé >= moderate)
// ----------------------------------------------------------------------------
function applyR7_modulation_trauma(json) {
  const trauma = safeGet(json, 'couche_2_dimensions_structurelles.trauma_complexe', {});
  const score = trauma.score ?? 0;

  if (score < 50) {
    recordArbitration(json, 'R7', false, `R7 non applicable : trauma_complexe score=${score} < 50`);
    return json;
  }

  const baseSecuriteIdentifiable = trauma.base_de_securite_identifiable === true;
  let r7DidModify = false;

  // Modulation par base de sécurité
  if (baseSecuriteIdentifiable) {
    const originalScore = score;
    const newScore = Math.round(score * 0.7);
    trauma.score = newScore;
    trauma.score_modulated_by_R7 = true;
    trauma.original_score = originalScore;
    trauma.modulation_reason = 'Base de sécurité identifiable (figure d\'attachement stable enfance, continuité subjective, etc.)';
    r7DidModify = true;

    recordArbitration(json, 'R7', true,
      `Trauma complexe modulé par base de sécurité : ${originalScore} → ${newScore} (×0.7).`,
      {
        trauma_complexe_original: originalScore,
        trauma_complexe_modulated: newScore,
        modulation_factor: 0.7
      }
    );
  }

  // Vérification cooccurrence pour HIGH (Point 5 relecteur)
  const updatedScore = trauma.score;
  if (updatedScore > 75) {
    // Vérification cooccurrence requise
    const dissocSaliency = safeGet(json, 'couche_2_dimensions_structurelles.dissociation.saliency', 'none');
    const identSaliency = safeGet(json, 'couche_2_dimensions_structurelles.identite.saliency', 'none');
    const attachementPattern = safeGet(json, 'couche_2_dimensions_structurelles.attachement.pattern', null);

    const cooccurrence =
      saliencyAtLeast(dissocSaliency, 'moderate') ||
      saliencyAtLeast(identSaliency, 'moderate') ||
      attachementPattern === 'desorganise';

    if (!cooccurrence) {
      const cappedScore = 75;
      trauma.score = cappedScore;
      trauma.score_capped_by_R7_cooccurrence = true;
      trauma.cap_reason = 'Score HIGH (>75) nécessite cooccurrence (dissociation OU identité OU attachement desorganisé >= moderate). Cooccurrence absente, score plafonné à 75.';
      r7DidModify = true;

      recordArbitration(json, 'R7', true,
        `Trauma complexe plafonné à 75 (cooccurrence absente). score précédent: ${updatedScore}.`,
        {
          trauma_complexe_pre_cap: updatedScore,
          trauma_complexe_post_cap: cappedScore,
          dissoc_saliency: dissocSaliency,
          ident_saliency: identSaliency,
          attachement_pattern: attachementPattern
        }
      );
    }
  }

  // Si R7 est entrée (score >= 50) mais n'a rien modifié, tracer quand même
  // pour garantir la complétude de l'audit (les 10 règles toujours tracées).
  if (!r7DidModify) {
    recordArbitration(json, 'R7', false,
      `R7 examinée : trauma_complexe score=${score} >= 50 mais aucune modulation appliquée (pas de base de sécurité, score <= 75 donc pas de plafonnement).`);
  }

  return json;
}

// ----------------------------------------------------------------------------
// R8 — NEUTRALISATION HYPERSENSIBILITÉ NON PATHOLOGIQUE
// ----------------------------------------------------------------------------
// Si profil hypersensible (mentalisation high + fonctionnement preserved
// + dissociation < moderate + attachement non désorganisé + sensibilité forte)
// → marquer le profil comme hypersensibilite_non_pathologique
// → R8 BLOQUE aussi identite HIGH (trajectoire cohérente + valeurs stables)
//   = point déjà géré dans le mapping prompt (NE PAS MENTIONNER identite)
// ----------------------------------------------------------------------------
function applyR8_hypersensibilite(json) {
  const mentalisation = safeGet(json, 'passation_quality.coherence', 'low');
  const fonctionnement = safeGet(json, 'niveau_fonctionnement_global.stabilite_globale', 'instable');
  const dissocSaliency = safeGet(json, 'couche_2_dimensions_structurelles.dissociation.saliency', 'none');
  const attachementPattern = safeGet(json, 'couche_2_dimensions_structurelles.attachement.pattern', null);
  const hypersensibiliteSignal = safeGet(json, 'contextes_declencheurs.hypersensibilite_non_pathologique_signal', false);

  // Conditions de neutralisation
  const conditions = {
    mentalisation_high: mentalisation === 'high',
    fonctionnement_preserved: fonctionnement === 'stable' || fonctionnement === 'preserved',
    dissociation_below_moderate: !saliencyAtLeast(dissocSaliency, 'moderate'),
    attachement_non_desorganise: attachementPattern !== 'desorganise',
    hypersensibilite_signal: hypersensibiliteSignal === true
  };

  const allMet = Object.values(conditions).every(v => v === true);

  if (allMet) {
    // Marquer le profil
    if (!json.profile_typology) json.profile_typology = {};
    json.profile_typology.r8_hypersensibilite_confirmed = true;

    // BLOCAGE identite si présente
    const identite = safeGet(json, 'couche_2_dimensions_structurelles.identite', null);
    if (identite && saliencyAtLeast(identite.saliency, 'moderate')) {
      const stabilite = safeGet(identite, 'stabilite_interpersonnelle', null);
      const trajectoireCoherente = safeGet(identite, 'trajectoire_coherente', null);
      const valeursStables = safeGet(identite, 'valeurs_stables', null);

      if (stabilite === 'preserved' && trajectoireCoherente === true && valeursStables === true) {
        identite.score_blocked_by_R8 = true;
        identite.score_cap = 60;
        if (identite.score > 60) identite.score = 60;
        identite.saliency = 'low';
        identite.block_reason = 'Profil hypersensibilité non pathologique confirmé. Stabilité interpersonnelle préservée + trajectoire cohérente + valeurs stables → questionnement existentiel transitoire et sain, pas TPL.';
      }
    }

    recordArbitration(json, 'R8', true,
      `Profil hypersensibilité non pathologique confirmé. Identité HIGH bloquée si applicable.`,
      { conditions_met: conditions }
    );
  } else {
    recordArbitration(json, 'R8', false,
      `R8 non applicable : conditions non remplies.`,
      { conditions: conditions });
  }
  return json;
}

// ----------------------------------------------------------------------------
// R9 — BURNOUT VS DÉPRESSION
// ----------------------------------------------------------------------------
// Si depression >= 40 + indicateurs burnout (surinvestissement chronique +
// fatigue + cynisme + effondrement récent + plaisir préservé partiel)
// → priorité contexte_burnout sur diagnostic dépression
// ----------------------------------------------------------------------------
function applyR9_burnout_vs_depression(json) {
  const depression = safeGet(json, 'couche_2_dimensions_structurelles.depression', {});
  const score = depression.score ?? 0;

  if (score < 40) {
    recordArbitration(json, 'R9', false, `R9 non applicable : depression score=${score} < 40`);
    return json;
  }

  const burnoutContext = safeGet(json, 'contextes_declencheurs.burnout_effondrement_adaptatif', false);
  const surinvestissement = safeGet(depression, 'surinvestissement_chronique', false);
  const fatigueChronique = safeGet(depression, 'fatigue_chronique', false);
  const cynisme = safeGet(depression, 'cynisme_demoralisation', false);
  const effondrementRecent = safeGet(depression, 'effondrement_recent', false);
  const plaisirPartiel = safeGet(depression, 'plaisir_preserve_partiel', false);
  const anhedonieGlobale = safeGet(depression, 'anhedonie_globale', false);

  const burnoutIndicators = [
    burnoutContext,
    surinvestissement,
    fatigueChronique,
    cynisme,
    effondrementRecent
  ].filter(Boolean).length;

  // Conditions de bascule
  const burnoutPriority =
    burnoutContext &&
    burnoutIndicators >= 3 &&
    (plaisirPartiel === true || anhedonieGlobale === false);

  if (burnoutPriority) {
    depression.contextual_overlay = 'burnout_priority';
    depression.contextual_reason = `Tableau burnout convergent (${burnoutIndicators}/5 indicateurs) avec plaisir partiel préservé. Le contexte burnout prend le pas sur l'interprétation dépression structurelle.`;

    recordArbitration(json, 'R9', true,
      `Bascule depression → contexte burnout. ${burnoutIndicators}/5 indicateurs convergents.`,
      {
        depression_score: score,
        burnout_indicators_count: burnoutIndicators,
        plaisir_partiel: plaisirPartiel,
        anhedonie_globale: anhedonieGlobale
      }
    );
  } else {
    recordArbitration(json, 'R9', false,
      `R9 non applicable : indicateurs burnout insuffisants (${burnoutIndicators}/5) ou anhédonie globale.`);
  }
  return json;
}

// ----------------------------------------------------------------------------
// R10 — VALIDATION ACTIVE EXCLUSIONS PSYCHIATRIQUES
// ----------------------------------------------------------------------------
// Si passation riche (turn_count >= 50 ET narrative_richness == high)
// ET aucun indicateur dimension psychiatrique
// → exclusion confirmée activement (vs présomption par défaut)
// Permet au matching marketplace de prioriser non-psychiatre en confiance.
// ----------------------------------------------------------------------------
function applyR10_validation_exclusions(json) {
  const turnCount = safeGet(json, 'session_meta.turn_count', 0);
  const narrativeRichness = safeGet(json, 'passation_quality.narrative_richness', 'low');

  const passationRiche = turnCount >= 50 && narrativeRichness === 'high';

  if (!passationRiche) {
    recordArbitration(json, 'R10', false,
      `R10 non applicable : passation pas assez riche (turn_count=${turnCount}, narrative_richness=${narrativeRichness})`);
    return json;
  }

  // Vérifier que les 4 dimensions psychiatriques sont absentes
  const bipolaire = saliencyAtLeast(safeGet(json, 'couche_1_differentiels_psychiatriques.bipolarite.saliency', 'none'), 'moderate');
  const psychose = saliencyAtLeast(safeGet(json, 'couche_1_differentiels_psychiatriques.psychose.saliency', 'none'), 'moderate');
  const tdah = saliencyAtLeast(safeGet(json, 'couche_1_differentiels_psychiatriques.tdah_adulte.saliency', 'none'), 'moderate');
  const conduites = saliencyAtLeast(safeGet(json, 'couche_1_differentiels_psychiatriques.conduites_compulsives.saliency', 'none'), 'moderate');

  const psychiatricFound = bipolaire || psychose || tdah || conduites;

  if (!psychiatricFound) {
    if (!json.couche_1_differentiels_psychiatriques) json.couche_1_differentiels_psychiatriques = {};
    json.couche_1_differentiels_psychiatriques.exclusion_actively_validated_by_R10 = true;
    json.couche_1_differentiels_psychiatriques.exclusion_reason = 'Passation riche (turn_count >= 50, narrative_richness high) sans indicateur psychiatrique. Exclusion active validée.';

    recordArbitration(json, 'R10', true,
      `Exclusion psychiatrique validée activement (passation riche + aucun indicateur).`,
      {
        turn_count: turnCount,
        narrative_richness: narrativeRichness,
        bipolaire, psychose, tdah, conduites
      }
    );
  } else {
    recordArbitration(json, 'R10', false,
      `R10 non applicable : indicateurs psychiatriques présents (bipolaire=${bipolaire}, psychose=${psychose}, tdah=${tdah}, conduites=${conduites})`);
  }
  return json;
}

// ============================================================================
// SECTION 2 — APPLICATION SÉQUENTIELLE DES RÈGLES
// ============================================================================

function applyArbitrationRules(json) {
  if (!json || typeof json !== 'object') {
    throw new Error('applyArbitrationRules: input invalide (not an object)');
  }

  // L'ordre des règles est important :
  // R1 d'abord (sécurité prioritaire)
  // R7 avant R6 (modulation trauma avant cooccurrence borderline)
  // R10 en dernier (validation active)
  applyR1_securite(json);
  applyR2_debrayage_tdah(json);
  applyR3_dissociation(json);
  applyR4_contexte_depression(json);
  applyR5_hypercontrole(json);
  applyR7_modulation_trauma(json);
  applyR6_neutralisation_borderline(json);
  applyR8_hypersensibilite(json);
  applyR9_burnout_vs_depression(json);
  applyR10_validation_exclusions(json);

  return json;
}

// ============================================================================
// SECTION 3 — FILTRAGE INTERNAL_ONLY (Niveau 1 strict)
// ============================================================================
// Avant de passer le JSON au prompt narratif, on retire tous les champs qui
// ne doivent JAMAIS être exposés à un LLM qui produit de la prose patient.
// Niveau 1 strict = suppression complète (vs marquage [FILTERED]).
// Cf. Point 1 du relecteur expert : filtrage doit être déterministe, pas LLM.
// ============================================================================

const INTERNAL_ONLY_TOP_LEVEL_FIELDS = [
  'INTERNAL_ONLY_therapeutic_needs_for_matching',
  'therapeutic_engagement_capacity',
  'rule_engine_arbitrations'
];

const INTERNAL_ONLY_NESTED_PATHS = [
  // Couche 1 — scores numériques bruts (le prompt utilise saliency, pas score)
  ['couche_1_differentiels_psychiatriques', '*', 'score'],
  // Couche 2 — scores numériques bruts
  ['couche_2_dimensions_structurelles', '*', 'score'],
  ['couche_2_dimensions_structurelles', '*', 'score_modulated_by_R7'],
  ['couche_2_dimensions_structurelles', '*', 'original_score'],
  ['couche_2_dimensions_structurelles', '*', 'score_capped_by_R7_cooccurrence'],
  ['couche_2_dimensions_structurelles', '*', 'score_blocked_by_R8'],
  ['couche_2_dimensions_structurelles', '*', 'score_cap'],
  // Couche 3 — scores numériques bruts
  ['couche_3_modulateurs_phenomenologiques', '*', 'score'],
  // Orientation engine — modalities exposed only via marketplace
  ['orientation_engine_output', 'INTERNAL_ONLY_modalities_for_marketplace_matching']
];

function deleteNestedPath(obj, pathParts) {
  if (!obj || pathParts.length === 0) return;

  if (pathParts.length === 1) {
    delete obj[pathParts[0]];
    return;
  }

  const [head, ...rest] = pathParts;

  if (head === '*') {
    // Wildcard : appliquer à toutes les sous-clés
    if (typeof obj === 'object' && obj !== null) {
      Object.keys(obj).forEach(key => {
        if (typeof obj[key] === 'object' && obj[key] !== null) {
          deleteNestedPath(obj[key], rest);
        }
      });
    }
  } else {
    if (obj[head] !== undefined) {
      deleteNestedPath(obj[head], rest);
    }
  }
}

function filterInternalOnly(jsonInput) {
  // On crée une copie pour ne pas modifier l'original (qui sera stocké en base)
  const filtered = JSON.parse(JSON.stringify(jsonInput));

  // Suppression des champs top-level INTERNAL_ONLY
  INTERNAL_ONLY_TOP_LEVEL_FIELDS.forEach(field => {
    delete filtered[field];
  });

  // Suppression des champs nested
  INTERNAL_ONLY_NESTED_PATHS.forEach(pathParts => {
    deleteNestedPath(filtered, pathParts);
  });

  // Annotation pour le LLM narratif (sait que le filtrage a eu lieu)
  filtered._filtered_for_narrative = true;
  filtered._filter_version = 'v1.0.0_strict';

  return filtered;
}

// ============================================================================
// SECTION 4 — VALIDATION DE STRUCTURE
// ============================================================================
// Vérifie que le JSON V1.3 contient les champs obligatoires minimaux.
// Retourne un objet { valid: boolean, missing: [], warnings: [] }.
// ============================================================================

const REQUIRED_TOP_LEVEL_FIELDS = [
  'schema_version',
  'session_meta',
  'passation_quality',
  'axes_psee_visible_layer',
  'couche_0_securite_deterministe',
  'couche_2_dimensions_structurelles',
  'contextes_declencheurs',
  'resources',
  'profile_typology'
];

const REQUIRED_AXES = [
  '1_processus_psychiques',
  '2_ressources_psychiques',
  '3_comportements_et_conduites',
  '4_regulation_emotionnelle',
  '5_corps_et_manifestations_somatiques',
  '6_environnement_et_contexte_vie'
];

function validateStructure(json) {
  const result = {
    valid: true,
    missing_fields: [],
    warnings: []
  };

  if (!json || typeof json !== 'object') {
    result.valid = false;
    result.missing_fields.push('ROOT_OBJECT');
    return result;
  }

  // Champs top-level requis
  REQUIRED_TOP_LEVEL_FIELDS.forEach(field => {
    if (!json[field]) {
      result.valid = false;
      result.missing_fields.push(field);
    }
  });

  // Schéma version
  if (json.schema_version && !json.schema_version.startsWith('1.3')) {
    result.warnings.push(`schema_version=${json.schema_version}, attendu 1.3.x`);
  }

  // Axes Stora
  const axes = json.axes_psee_visible_layer || {};
  REQUIRED_AXES.forEach(axe => {
    if (!axes[axe]) {
      result.warnings.push(`axes_psee_visible_layer.${axe} manquant`);
    } else if (axes[axe].score_0_4 === undefined) {
      result.warnings.push(`axes_psee_visible_layer.${axe}.score_0_4 manquant`);
    }
  });

  return result;
}

// ============================================================================
// SECTION 5 — FONCTION PRINCIPALE EXPORTÉE
// ============================================================================
// applyClinicalRules orchestre les 3 étapes :
//   1. validation initiale (avant arbitrages)
//   2. application R1-R10
//   3. filtrage INTERNAL_ONLY (copie pour narrative)
// Retourne { jsonFull, jsonForNarrative, validation }.
// - jsonFull : JSON V1.3 enrichi par les arbitrages, à stocker en base
// - jsonForNarrative : JSON filtré, à passer au prompt narratif
// - validation : { valid, missing_fields, warnings }
// ============================================================================

export function applyClinicalRules(jsonV13Input) {
  // Validation initiale (sur copie pour éviter mutation imprévue)
  const validation = validateStructure(jsonV13Input);

  if (!validation.valid) {
    console.warn('[ruleEngine] JSON V1.3 incomplet, application des règles malgré tout:', validation.missing_fields);
  }

  // On travaille sur une copie pour pouvoir conserver l'original si besoin
  const jsonFull = JSON.parse(JSON.stringify(jsonV13Input));

  // Application séquentielle des 10 règles
  applyArbitrationRules(jsonFull);

  // Génération de la version filtrée pour le LLM narratif
  const jsonForNarrative = filterInternalOnly(jsonFull);

  return {
    jsonFull,
    jsonForNarrative,
    validation
  };
}

// Exports complémentaires pour tests unitaires
export {
  applyArbitrationRules,
  filterInternalOnly,
  validateStructure,
  // Règles individuelles (utiles pour tests)
  applyR1_securite,
  applyR2_debrayage_tdah,
  applyR3_dissociation,
  applyR4_contexte_depression,
  applyR5_hypercontrole,
  applyR6_neutralisation_borderline,
  applyR7_modulation_trauma,
  applyR8_hypersensibilite,
  applyR9_burnout_vs_depression,
  applyR10_validation_exclusions
};
