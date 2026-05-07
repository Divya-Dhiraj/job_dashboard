// emailer.js — Email digest via Resend API. Settings-driven so any profile
// can use it. server.js calls applyMailerSettings() during boot and after
// settings/profile changes. sendDigestEmail/sendTestEmail accept the active
// profile as a parameter so subjects/copy can include the profile name.
const axios = require('axios');

let RESEND_API_KEY = process.env.RESEND_API_KEY || '';
let NOTIFY_EMAIL  = process.env.NOTIFY_EMAIL  || '';
let FROM_EMAIL    = 'Job Dashboard <onboarding@resend.dev>';

function applyMailerSettings({ resendKey, fromEmail, notifyEmail } = {}) {
  if (resendKey   !== undefined) RESEND_API_KEY = resendKey || '';
  if (fromEmail   !== undefined && fromEmail) FROM_EMAIL   = fromEmail;
  if (notifyEmail !== undefined) NOTIFY_EMAIL  = notifyEmail || '';
}

function scoreColor(score) {
  if (score >= 70) return '#22c55e';
  if (score >= 45) return '#f59e0b';
  return '#ef4444';
}

function jobCard(job) {
  const score  = Math.round(job.match_score);
  const skills = (() => { try { return JSON.parse(job.matched_skills || '[]'); } catch { return []; } })();
  const badges = skills.slice(0, 8).map(s =>
    `<span style="background:#1e293b;color:#94a3b8;padding:2px 8px;border-radius:20px;font-size:11px;margin:2px;display:inline-block;">${s}</span>`
  ).join('');
  const posted = job.posted_at
    ? new Date(job.posted_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    : 'Recently';

  return `
  <div style="background:#0f172a;border:1px solid #1e293b;border-left:4px solid ${scoreColor(score)};border-radius:12px;padding:20px;margin-bottom:16px;">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;">
      <div style="flex:1;">
        <h3 style="margin:0 0 4px;color:#f1f5f9;font-size:17px;font-weight:700;">${job.title}</h3>
        <p style="margin:0 0 8px;color:#94a3b8;font-size:14px;">
          🏢 ${job.company || 'Unknown'} &nbsp;|&nbsp;
          📍 ${job.location || ''}
          ${job.salary ? `&nbsp;|&nbsp; 💰 ${job.salary}` : ''}
          &nbsp;|&nbsp; 🗓️ ${posted}
        </p>
        <p style="margin:0 0 10px;color:#64748b;font-size:12px;">Source: ${job.source}</p>
        ${badges ? `<div style="margin-bottom:10px;">${badges}</div>` : ''}
        <p style="margin:0;color:#cbd5e1;font-size:13px;line-height:1.5;">
          ${(job.description || '').slice(0, 250)}${(job.description || '').length > 250 ? '...' : ''}
        </p>
      </div>
      <div style="text-align:center;min-width:70px;margin-left:16px;">
        <div style="background:${scoreColor(score)};color:#fff;font-size:22px;font-weight:800;border-radius:50%;width:56px;height:56px;line-height:56px;text-align:center;">${score}%</div>
        <div style="color:#64748b;font-size:10px;margin-top:4px;">Match</div>
      </div>
    </div>
    <div style="margin-top:16px;">
      <a href="${job.apply_url}" style="background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;padding:10px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;display:inline-block;">
        Apply Now →
      </a>
    </div>
  </div>`;
}

async function sendViaResend(subject, html, recipient) {
  const to = recipient || NOTIFY_EMAIL;
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured (set in Settings)');
  if (!to)             throw new Error('No recipient — set notify_email on the active profile');

  const res = await axios.post('https://api.resend.com/emails', {
    from: FROM_EMAIL,
    to: [to],
    subject,
    html,
  }, {
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
  });
  return res.data;
}

async function sendDigestEmail(newJobs, profile) {
  if (!RESEND_API_KEY) {
    console.warn('[Email] Resend API key not configured. Skipping digest.');
    return;
  }
  if (!newJobs || newJobs.length === 0) {
    console.log('[Email] No new jobs to notify about.');
    return;
  }
  const recipient = profile?.notify_email || NOTIFY_EMAIL;
  if (!recipient) {
    console.warn('[Email] No notify_email set on profile and no NOTIFY_EMAIL fallback. Skipping.');
    return;
  }

  const sorted   = [...newJobs].sort((a, b) => b.match_score - a.match_score);
  const topScore = Math.round(sorted[0].match_score);
  const avgScore = Math.round(sorted.reduce((s, j) => s + j.match_score, 0) / sorted.length);
  const profileName = profile?.name ? ` for ${profile.name}` : '';
  const subject  = `🚀 ${newJobs.length} New Job Match${newJobs.length > 1 ? 'es' : ''}${profileName} (Top: ${topScore}%)`;

  const html = `
<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#020617;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<div style="max-width:680px;margin:0 auto;padding:24px;">

  <div style="background:linear-gradient(135deg,#6366f1,#8b5cf6);border-radius:16px;padding:32px;text-align:center;margin-bottom:24px;">
    <h1 style="margin:0 0 8px;color:#fff;font-size:28px;font-weight:800;">🎯 Job Dashboard Alert</h1>
    <p style="margin:0;color:#c4b5fd;font-size:16px;">New jobs matching your${profileName ? ' ' + profile.name : ''} profile</p>
  </div>

  <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
    <tr>
      <td width="33%" style="padding:0 6px 0 0;">
        <div style="background:#0f172a;border:1px solid #1e293b;border-radius:12px;padding:16px;text-align:center;">
          <div style="color:#6366f1;font-size:28px;font-weight:800;">${newJobs.length}</div>
          <div style="color:#64748b;font-size:12px;margin-top:4px;">New Jobs</div>
        </div>
      </td>
      <td width="33%" style="padding:0 3px;">
        <div style="background:#0f172a;border:1px solid #1e293b;border-radius:12px;padding:16px;text-align:center;">
          <div style="color:#22c55e;font-size:28px;font-weight:800;">${topScore}%</div>
          <div style="color:#64748b;font-size:12px;margin-top:4px;">Top Match</div>
        </div>
      </td>
      <td width="33%" style="padding:0 0 0 6px;">
        <div style="background:#0f172a;border:1px solid #1e293b;border-radius:12px;padding:16px;text-align:center;">
          <div style="color:#f59e0b;font-size:28px;font-weight:800;">${avgScore}%</div>
          <div style="color:#64748b;font-size:12px;margin-top:4px;">Avg Match</div>
        </div>
      </td>
    </tr>
  </table>

  <h2 style="color:#f1f5f9;font-size:18px;margin:0 0 16px;">Job Listings</h2>
  ${sorted.map(jobCard).join('')}

  <div style="text-align:center;margin-top:32px;padding-top:24px;border-top:1px solid #1e293b;">
    <p style="color:#475569;font-size:12px;margin:0 0 8px;">Sent by your Job Dashboard${profileName}</p>
    <a href="http://localhost:3000" style="color:#6366f1;font-size:13px;text-decoration:none;">Open Dashboard →</a>
  </div>
</div>
</body></html>`;

  try {
    const result = await sendViaResend(subject, html, recipient);
    console.log(`[Email] Digest sent to ${recipient} (id: ${result.id})`);
  } catch (err) {
    console.error(`[Email] Failed: ${err.response?.data?.message || err.message}`);
  }
}

async function sendTestEmail(profile) {
  const recipient = profile?.notify_email || NOTIFY_EMAIL;
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured (set in Settings)');
  if (!recipient)       throw new Error('No notify_email on the active profile');
  const profileName = profile?.name ? profile.name : 'this profile';

  const result = await sendViaResend(
    '✅ Job Dashboard — Email Working!',
    `<div style="font-family:sans-serif;background:#020617;color:#f1f5f9;padding:32px;border-radius:12px;max-width:500px;margin:auto;">
      <h2 style="color:#6366f1;">🎉 Emails are working!</h2>
      <p>Your Job Dashboard will now email <strong>${recipient}</strong> whenever new matching jobs are found for <strong>${profileName}</strong>.</p>
      <a href="http://localhost:3000" style="color:#6366f1;">Open Dashboard →</a>
    </div>`,
    recipient
  );
  console.log(`[Email] Test sent (id: ${result.id})`);
}

module.exports = { sendDigestEmail, sendTestEmail, applyMailerSettings };
