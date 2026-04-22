// lib/suspicionEngine.js

export function detectSuspicion(clinicalFlags = {}) {
  const modules = [];

  const depressionScore =
    bool(clinicalFlags.sadness) +
    bool(clinicalFlags.anhedonia) +
    bool(clinicalFlags.fatigue) +
    bool(clinicalFlags.guilt) +
    bool(clinicalFlags.sleepIssues) +
    bool(clinicalFlags.hopelessness) +
    bool(clinicalFlags.lowSelfWorth);

  const anxietyScore =
    bool(clinicalFlags.worry) +
    bool(clinicalFlags.rumination) +
    bool(clinicalFlags.tension) +
    bool(clinicalFlags.hypervigilance) +
    bool(clinicalFlags.irritability) +
    bool(clinicalFlags.restlessness) +
    bool(clinicalFlags.panicLikeSymptoms);

  const stressScore =
    bool(clinicalFlags.overload) +
    bool(clinicalFlags.lossOfControl) +
    bool(clinicalFlags.mentalLoad) +
    bool(clinicalFlags.exhaustion) +
    bool(clinicalFlags.burnoutFeeling);

  if (depressionScore >= 3) modules.push("PHQ9");
  if (anxietyScore >= 3) modules.push("GAD7");
  if (stressScore >= 2) modules.push("PSS10");

  return dedupe(modules);
}

export function rankSuspicionModules(clinicalFlags = {}) {
  const candidates = [
    {
      moduleId: "PHQ9",
      score:
        bool(clinicalFlags.sadness) +
        bool(clinicalFlags.anhedonia) +
        bool(clinicalFlags.fatigue) +
        bool(clinicalFlags.guilt) +
        bool(clinicalFlags.sleepIssues) +
        bool(clinicalFlags.hopelessness) +
        bool(clinicalFlags.lowSelfWorth)
    },
    {
      moduleId: "GAD7",
      score:
        bool(clinicalFlags.worry) +
        bool(clinicalFlags.rumination) +
        bool(clinicalFlags.tension) +
        bool(clinicalFlags.hypervigilance) +
        bool(clinicalFlags.irritability) +
        bool(clinicalFlags.restlessness) +
        bool(clinicalFlags.panicLikeSymptoms)
    },
    {
      moduleId: "PSS10",
      score:
        bool(clinicalFlags.overload) +
        bool(clinicalFlags.lossOfControl) +
        bool(clinicalFlags.mentalLoad) +
        bool(clinicalFlags.exhaustion) +
        bool(clinicalFlags.burnoutFeeling)
    }
  ];

  return candidates
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);
}

export function chooseNextModule(clinicalFlags = {}, completedModules = []) {
  const ranked = rankSuspicionModules(clinicalFlags);

  for (const item of ranked) {
    if (!completedModules.includes(item.moduleId)) {
      if (
        (item.moduleId === "PHQ9" && item.score >= 3) ||
        (item.moduleId === "GAD7" && item.score >= 3) ||
        (item.moduleId === "PSS10" && item.score >= 2)
      ) {
        return item.moduleId;
      }
    }
  }

  return null;
}

function bool(value) {
  return value ? 1 : 0;
}

function dedupe(arr) {
  return [...new Set(arr)];
}
