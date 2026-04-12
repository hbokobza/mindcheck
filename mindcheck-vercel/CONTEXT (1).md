# MindCheck — Contexte Projet

## Infos techniques
- **Repo GitHub** : hbokobza/mindcheck
- **Site live** : https://mindcheck-pi.vercel.app
- **Plateforme** : Vercel (free tier)
- **Structure repo** : `mindcheck-vercel/` contient `index.html` + `api/chat.js`
- **Root Directory Vercel** : `mindcheck-vercel`
- **Modèle API** : claude-haiku-4-5-20251001
- **Max tokens** : 4096
- **Clé API** : configurée dans Vercel > Environment Variables > ANTHROPIC_API_KEY

## chat.js (api/) — INCHANGÉ
```javascript
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { messages, system } = req.body;
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
        system: system,
        messages: messages
      })
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
```

## État du projet — 12 avril 2026

### Ce qui fonctionne ✅
- Chat avec collecte du récit (6 axes psychosomatiques)
- Entretien structuré : l'IA explore obligatoirement les 6 axes avant de conclure
- Génération du bilan BTC (grand public) via JSON Claude Haiku
- Génération du bilan BTB (thérapeute) via JSON Claude Haiku
- Affichage BTC avec radar SVG, zones d'attention, 6 dimensions, 3 actions, accompagnement
- Affichage BTB avec matrice clinique, lecture systèmes, red flags, axes thérapeutiques
- Mot de passe admin `mindcheckadmin00` → génère BTC + BTB en parallèle
- Logo MindCheck réel intégré en base64 (blanc sur fond vert)
- Couleur verte : #3a7531
- Couleur bleue BTB : #1B3A6B

### À faire 🔧
- **PDF non conforme** : le téléchargement PDF via window.print() ne reproduit pas fidèlement le bilan affiché (pas de couleurs, pas de mise en page). Besoin d'une impression HTML stylée dédiée
- **Version thérapeute** : interface séparée pour les praticiens (parcours 1 : MindCheck envoie BTB aux thérapeutes partenaires / parcours 2 : patient envoie à son thérapeute via numéro ADELI)
- **Consentement** : le bouton "J'accepte" ne vérifie pas les cases à cocher (bug mineur)

## Architecture bilans

### BTC (grand public)
- Synthèse chaleureuse italique Georgia
- Radar psychosomatique SVG (6 axes, comparaison baseline)
- 5 zones d'attention avec barres colorées : État psychique général / Fonction cognitive / Régulation émotionnelle / Somatisation / Fonction relationnelle
- 6 dimensions avec pictos SVG dans ronds colorés + obs + conseil italique vert
- Ce qui vous soutient / Ce qui demande attention
- 3 actions concrètes (semaine / mois / trimestre)
- Bloc alerte rouge (si score ≤ 2) + 6 types de thérapies
- Bloc accompagnement avec formats et bouton

### BTB (thérapeute) — fond bleu #1B3A6B
- Synthèse clinique professionnelle
- Matrice 6 axes : score / manifestations / systèmes
- Lecture systèmes : Psychique / SNC / SNA / Immunitaire / Génétique
- Signaux d'alerte hiérarchisés (haute/moyenne priorité)
- Axes thérapeutiques prioritaires avec cibles
- Ressources cliniques / Points de vigilance
- Conclusion et pronostic

## Scores (IMPORTANT)
- Échelle 0 à 4 (entiers uniquement)
- 0-1 = état très dégradé/critique → Attention (rouge)
- 2 = état préoccupant → En tension (orange)
- 3 = correct mais fragile → Solide (vert)
- 4 = optimal → Solide (vert)
- Zones d'attention : 0-1=Équilibré (vert) / 2=Modéré (orange) / 3-4=Élevé (rouge)

## Référentiel clinique
- Modèle psychosomatique (approche bio-psycho-sociale)
- 6 axes : Processus psychiques / Ressources psychiques / Comportements & conduites / Régulation émotionnelle / Corps & risque somatique / Environnement
- 5 systèmes : Psychique / SNC / SNA / Immunitaire / Génétique

## Mot de passe admin
- `mindcheckadmin00` dans la zone de texte du chat → génère BTC + BTB en parallèle

## Problèmes résolus
- vercel.json invalide → supprimé
- chat.js vide → réécrit
- Clé API invalide → régénérée
- Scores inversés → corrigé dans BILAN_SYS
- Apostrophe dans showErr() cassait tout le JS → corrigé
- JSON BTB trop long → prompt simplifié avec champs courts
- Double-clic logo → abandonné, remplacé par mot de passe
