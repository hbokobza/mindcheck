// ============================================================
// BilanPsy — api/send-btb.js
// Endpoint dédié au parcours clinique BTB
// Reçoit le JSON BTB + le code praticien
// → lookup Supabase → envoi email via Resend
// ============================================================

import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const resend = new Resend(process.env.RESEND_API_KEY);

// ---- Helpers ------------------------------------------------

function scoreLabel(score) {
  const labels = { 1: 'Fragile', 2: 'En tension', 3: 'Stable', 4: 'Solide' };
  return labels[Math.round(score)] || '—';
}

function scoreColor(score) {
  const colors = {
    1: '#D94F3D',
    2: '#E8943A',
    3: '#4A90A4',
    4: '#4A7C59'
  };
  return colors[Math.round(score)] || '#888';
}

// ---- Template email HTML ------------------------------------

function buildEmailHTML(btb, praticienNom, sessionCode) {
  const axes = btb.axes || [];
  const profil = btb.profil_clinique || {};
  const mecanismes = btb.mecanismes_transdiagnostiques || [];
  const hypotheses = btb.hypotheses_cliniques || [];
  const reperes = btb.reperes_orientation || {};
  const ressources = btb.ressources_observees || {};

  const axesHTML = axes.map(axe => `
    <tr>
      <td style="padding:8px 12px;font-size:13px;color:#1A1A18;border-bottom:1px solid #EDE8E0;">${axe.label || axe.num}</td>
      <td style="padding:8px 12px;text-align:center;border-bottom:1px solid #EDE8E0;">
        <span style="display:inline-block;padding:2px 10px;border-radius:12px;font-size:12px;font-weight:600;background:${scoreColor(axe.score)}20;color:${scoreColor(axe.score)}">
          ${scoreLabel(axe.score)}
        </span>
      </td>
      <td style="padding:8px 12px;font-size:12px;color:#5A5A58;border-bottom:1px solid #EDE8E0;">${axe.manifestations || ''}</td>
    </tr>
  `).join('');

  const profilStructure = (profil.structure || '').split(',').map(t => t.trim()).filter(Boolean);
  const profilEvenements = (profil.evenements || '').split(',').map(t => t.trim()).filter(Boolean);
  const profilRessources = (profil.ressources || '').split(',').map(t => t.trim()).filter(Boolean);

  const tagHTML = (tags, color) => tags.map(t =>
    `<span style="display:inline-block;margin:3px 4px 3px 0;padding:3px 10px;border-radius:12px;font-size:12px;background:${color}15;color:${color};border:1px solid ${color}30">${t}</span>`
  ).join('');

  const mecanismesHTML = mecanismes.map(m => `
    <div style="margin-bottom:12px;padding:10px 14px;background:#F7F4EF;border-radius:8px;border-left:3px solid #E8943A">
      <div style="font-size:13px;font-weight:600;color:#1A1A18;margin-bottom:4px;">${m.nom || ''} <span style="font-weight:400;font-size:12px;color:#888">— ${m.saillance || ''}</span></div>
      <div style="font-size:12px;color:#5A5A58;font-family:monospace">${m.boucle_courte || ''}</div>
    </div>
  `).join('');

  const hypothesesHTML = (hypotheses || []).map(h => `
    <div style="margin-bottom:8px;padding:8px 14px;background:#EEF4F7;border-radius:6px;font-size:13px;color:#1A1A18;border-left:3px solid #4A90A4">
      ${h}
    </div>
  `).join('');

  const reperesHTML = Object.entries(reperes)
    .filter(([k, v]) => v && typeof v === 'string' && v.length > 5)
    .map(([k, v]) => `<li style="margin-bottom:8px;font-size:13px;color:#1A1A18;">${v}</li>`)
    .join('');

  const now = new Date().toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });

  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F0EBE3;font-family:'Helvetica Neue',Arial,sans-serif">

<div style="max-width:680px;margin:32px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08)">

  <!-- En-tête -->
  <div style="background:#1A2E1A;padding:24px 32px;display:flex;align-items:center;justify-content:space-between">
    <div>
      <div style="font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.5px">bilanpsy<span style="color:#FF4B28">.</span> <span style="font-size:13px;font-weight:400;color:#AAC4AA;letter-spacing:0">PRO</span></div>
      <div style="font-size:12px;color:#AAC4AA;margin-top:4px">BILAN CLINIQUE — Aide à la lecture pré-consultation</div>
    </div>
    <div style="text-align:right">
      <div style="font-size:11px;color:#AAC4AA">Code : <strong style="color:#ffffff">${sessionCode}</strong></div>
      <div style="font-size:11px;color:#AAC4AA;margin-top:2px">Date : ${now}</div>
      <div style="margin-top:6px;padding:3px 10px;background:#FF4B2820;border-radius:12px;font-size:11px;color:#FF8870;border:1px solid #FF4B2840">Confidentiel praticien</div>
    </div>
  </div>

  <div style="padding:32px">

    <!-- Destinataire -->
    <div style="margin-bottom:24px;padding:12px 16px;background:#F7F4EF;border-radius:8px;font-size:13px;color:#5A5A58">
      À l'attention de <strong style="color:#1A1A18">${praticienNom}</strong> — Bilan reçu automatiquement via BilanPsy
    </div>

    <!-- Synthèse clinique -->
    <div style="margin-bottom:28px">
      <div style="font-size:10px;font-weight:600;letter-spacing:0.1em;color:#888;text-transform:uppercase;margin-bottom:10px">Synthèse clinique & orientation</div>
      <div style="font-size:14px;color:#1A1A18;line-height:1.7;font-style:italic;padding:16px;background:#F7F4EF;border-radius:8px;border-left:3px solid #4A7C59">
        ${btb.synthese_clinique || btb.synthese || ''}
      </div>
    </div>

    <!-- Cartographie 6 axes -->
    <div style="margin-bottom:28px">
      <div style="font-size:10px;font-weight:600;letter-spacing:0.1em;color:#888;text-transform:uppercase;margin-bottom:10px">Cartographie clinique — 6 axes BilanPsy</div>
      <table style="width:100%;border-collapse:collapse;background:#F7F4EF;border-radius:8px;overflow:hidden">
        <thead>
          <tr style="background:#EDE8E0">
            <th style="padding:10px 12px;text-align:left;font-size:11px;color:#888;font-weight:600;text-transform:uppercase">Axe</th>
            <th style="padding:10px 12px;text-align:center;font-size:11px;color:#888;font-weight:600;text-transform:uppercase">Score</th>
            <th style="padding:10px 12px;text-align:left;font-size:11px;color:#888;font-weight:600;text-transform:uppercase">Manifestations</th>
          </tr>
        </thead>
        <tbody>${axesHTML}</tbody>
      </table>
    </div>

    <!-- Profil clinique observé -->
    <div style="margin-bottom:28px">
      <div style="font-size:10px;font-weight:600;letter-spacing:0.1em;color:#888;text-transform:uppercase;margin-bottom:10px">Profil clinique observé</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">

        <div style="padding:14px;background:#F7F4EF;border-radius:8px">
          <div style="font-size:11px;font-weight:600;color:#4D3728;text-transform:uppercase;margin-bottom:8px">Structure psychique</div>
          ${tagHTML(profilStructure, '#4D3728')}
        </div>

        <div style="padding:14px;background:#F7F4EF;border-radius:8px">
          <div style="font-size:11px;font-weight:600;color:#4A5728;text-transform:uppercase;margin-bottom:8px">Événements structurants</div>
          ${tagHTML(profilEvenements, '#4A5728')}
        </div>

        <div style="padding:14px;background:#F7F4EF;border-radius:8px;border:1px solid #E8943A40">
          <div style="font-size:11px;font-weight:600;color:#7A4010;text-transform:uppercase;margin-bottom:8px">Conflit central</div>
          <div style="font-size:13px;font-weight:600;color:#1A1A18">${profil.conflit_central || '—'}</div>
        </div>

        <div style="padding:14px;background:#F7F4EF;border-radius:8px">
          <div style="font-size:11px;font-weight:600;color:#1A4A2E;text-transform:uppercase;margin-bottom:8px">Ressources structurantes</div>
          ${tagHTML(profilRessources, '#1A4A2E')}
        </div>

      </div>
    </div>

    <!-- Mécanismes transdiagnostiques -->
    ${mecanismes.length > 0 ? `
    <div style="margin-bottom:28px">
      <div style="font-size:10px;font-weight:600;letter-spacing:0.1em;color:#888;text-transform:uppercase;margin-bottom:10px">Mécanismes transdiagnostiques identifiés</div>
      ${mecanismesHTML}
    </div>` : ''}

    <!-- Hypothèses cliniques -->
    ${hypotheses.length > 0 ? `
    <div style="margin-bottom:28px">
      <div style="font-size:10px;font-weight:600;letter-spacing:0.1em;color:#888;text-transform:uppercase;margin-bottom:10px">Hypothèses cliniques à explorer</div>
      ${hypothesesHTML}
    </div>` : ''}

    <!-- Repères d'orientation -->
    ${reperesHTML ? `
    <div style="margin-bottom:28px">
      <div style="font-size:10px;font-weight:600;letter-spacing:0.1em;color:#888;text-transform:uppercase;margin-bottom:10px">Repères d'orientation</div>
      <ul style="margin:0;padding-left:18px;background:#F7F4EF;border-radius:8px;padding:16px 16px 16px 32px">
        ${reperesHTML}
      </ul>
    </div>` : ''}

    <!-- Ressources observées -->
    ${ressources.intro ? `
    <div style="margin-bottom:28px">
      <div style="font-size:10px;font-weight:600;letter-spacing:0.1em;color:#888;text-transform:uppercase;margin-bottom:10px">Ressources observées</div>
      <div style="padding:14px;background:#F0F7F0;border-radius:8px;font-size:13px;color:#1A2E1A;line-height:1.6">${ressources.intro}</div>
    </div>` : ''}

    <!-- Pied de bilan -->
    <div style="margin-top:32px;padding-top:20px;border-top:1px solid #EDE8E0">
      <p style="font-size:11px;color:#888;line-height:1.6;margin:0">
        Ce bilan combine trois méthodes : (1) le scoring d'échelles psychométriques validées (PHQ-9, GAD-7, PSS-10), (2) une analyse linguistique implicite inspirée des recherches en linguistique clinique (INSERM / Université Paris-Cité), (3) le paradigme AAP (Automated Assessment Paradigm — JMIR Mental Health, 2026). Il s'agit d'un outil d'aide à la lecture pré-consultation, à visée observationnelle. Il ne pose aucun diagnostic et ne se substitue pas à l'évaluation clinique du praticien.
      </p>
      <p style="font-size:11px;color:#BB8866;margin:12px 0 0 0">
        BilanPsy n'est pas un service d'urgence — en cas de crise active, le 3114 et le 15 sont les recours appropriés.
      </p>
    </div>

  </div><!-- /padding -->
</div><!-- /card -->

<div style="text-align:center;padding:16px;font-size:11px;color:#888">
  BilanPsy · Usage strictement professionnel et confidentiel · <a href="https://psee.fr" style="color:#888">psee.fr</a>
</div>

</body>
</html>`;
}

// ---- Handler principal --------------------------------------

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { cliniqueCode, btbData, sessionCode } = req.body;

  if (!cliniqueCode || !btbData) {
    return res.status(400).json({ error: 'cliniqueCode et btbData requis' });
  }

  try {
    // 1. Lookup praticien dans Supabase
    const { data: praticien, error: lookupError } = await supabase
      .from('praticiens_test')
      .select('email, nom, actif')
      .eq('code', cliniqueCode)
      .single();

    if (lookupError || !praticien) {
      console.error('[send-btb] Praticien non trouvé:', cliniqueCode);
      return res.status(404).json({ error: 'Code praticien invalide' });
    }

    if (!praticien.actif) {
      return res.status(403).json({ error: 'Code praticien désactivé' });
    }

    // 2. Incrémenter le compteur de sessions
    await supabase
      .from('praticiens_test')
      .update({ nb_sessions: supabase.rpc('nb_sessions + 1') })
      .eq('code', cliniqueCode);

    // 3. Parser le BTB JSON
    let btb;
    try {
      btb = typeof btbData === 'string' ? JSON.parse(btbData) : btbData;
    } catch (e) {
      return res.status(400).json({ error: 'BTB JSON invalide' });
    }

    // 4. Générer le HTML de l'email
    const emailHTML = buildEmailHTML(btb, praticien.nom, sessionCode || 'N/A');

    // 5. Envoyer via Resend
    const emailResponse = await resend.emails.send({
      from: 'BilanPsy <bilan@psee.fr>',
      to: [praticien.email],
      subject: `BilanPsy — Bilan clinique reçu · ${sessionCode || new Date().toLocaleDateString('fr-FR')}`,
      html: emailHTML,
      tags: [
        { name: 'type', value: 'btb_clinique' },
        { name: 'code_praticien', value: cliniqueCode }
      ]
    });

    if (emailResponse.error) {
      console.error('[send-btb] Erreur Resend:', emailResponse.error);
      return res.status(500).json({ error: 'Erreur envoi email', detail: emailResponse.error });
    }

    console.log(`[send-btb] BTB envoyé à ${praticien.email} · session ${sessionCode}`);

    return res.status(200).json({
      success: true,
      emailId: emailResponse.data?.id,
      praticienNom: praticien.nom
    });

  } catch (err) {
    console.error('[send-btb] Erreur:', err);
    return res.status(500).json({ error: 'Erreur serveur', detail: err.message });
  }
}
