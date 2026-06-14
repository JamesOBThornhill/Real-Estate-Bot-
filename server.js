/**
 * Real Estate AI Qualification Bot
 * ElevenLabs Agent handles the call
 * This server receives post-call webhook and fires all lead notifications
 */

require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const twilio = require('twilio');
const sgMail = require('@sendgrid/mail');
const axios = require('axios');

const app = express();

// Raw body needed for webhook signature verification
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ─── Clients ─────────────────────────────────────────────────────────────────
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// ─── ElevenLabs Post-Call Webhook ─────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  try {
    // Verify webhook signature
    const secret = process.env.ELEVENLABS_WEBHOOK_SECRET;
    if (secret) {
      const signature = req.headers['elevenlabs-signature'];
      if (!signature) {
        console.error('❌ Missing webhook signature');
        return res.sendStatus(401);
      }

      // Parse timestamp and signature from header
      // Format: t=timestamp,v0=signature
      const parts = signature.split(',');
      const timestamp = parts.find(p => p.startsWith('t='))?.split('=')[1];
      const sig = parts.find(p => p.startsWith('v0='))?.split('=')[1];

      if (!timestamp || !sig) {
        console.error('❌ Invalid signature format');
        return res.sendStatus(401);
      }

      // Verify timestamp is within 30 minutes
      const age = Math.abs(Date.now() - parseInt(timestamp));
      if (age > 30 * 60 * 1000) {
        console.error('❌ Webhook timestamp too old');
        return res.sendStatus(401);
      }

      // Compute expected signature
      const message = `${timestamp}.${req.body.toString()}`;
      const expected = crypto
        .createHmac('sha256', secret)
        .update(message)
        .digest('hex');

      if (expected !== sig) {
        console.error('❌ Invalid webhook signature');
        return res.sendStatus(401);
      }
    }

    const payload = JSON.parse(req.body.toString());
    console.log('📞 Webhook received:', JSON.stringify(payload, null, 2));

    // Extract conversation data from ElevenLabs webhook
    const conversationId = payload.conversation_id || 'unknown';
    const callDuration = payload.metadata?.call_duration_secs || 0;
    const transcript = payload.transcript || [];
    const analysis = payload.analysis || {};
    const callerPhone = payload.metadata?.caller_id || payload.metadata?.from || 'Unknown';

    // Build conversation summary from transcript
    const conversationText = transcript
      .map(t => `${t.role === 'agent' ? 'Agent' : 'Caller'}: ${t.message}`)
      .join('\n');

    // Extract data collected during call from analysis
    const dataCollection = analysis.data_collection || {};

    // Build lead object from whatever ElevenLabs captured
    const lead = {
      callerPhone,
      conversationId,
      callDuration: `${Math.round(callDuration / 60)} min ${callDuration % 60} sec`,
      callerName: dataCollection.caller_name?.value || extractFromTranscript(conversationText, 'name') || 'Unknown',
      buyRent: dataCollection.buy_rent?.value || extractFromTranscript(conversationText, 'buy|rent|buying|renting') || 'Unknown',
      propertyType: dataCollection.property_type?.value || 'Unknown',
      location: dataCollection.location?.value || 'Unknown',
      budget: dataCollection.budget?.value || 'Unknown',
      timeline: dataCollection.timeline?.value || 'Unknown',
      preApproved: dataCollection.pre_approved?.value || 'Unknown',
      whoMovingIn: dataCollection.who_moving_in?.value || 'N/A',
      pets: dataCollection.pets?.value || 'N/A',
      motivation: dataCollection.motivation?.value || 'Unknown',
      exclusivity: dataCollection.exclusivity?.value || 'Unknown',
      score: analysis.success_evaluation || deriveScore(dataCollection, conversationText),
      summary: analysis.transcript_summary || buildSummary(conversationText),
      requestedHuman: conversationText.toLowerCase().includes('speak to a human') || 
                      conversationText.toLowerCase().includes('real person') ||
                      conversationText.toLowerCase().includes('transfer me'),
      timestamp: new Date().toISOString(),
    };

    console.log('✅ Lead extracted:', lead);
    await notifyAllChannels(lead);

    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err);
    res.sendStatus(500);
  }
});

// ─── Helper: extract info from transcript text ────────────────────────────────
function extractFromTranscript(text, pattern) {
  const regex = new RegExp(pattern, 'i');
  return regex.test(text) ? 'See transcript' : null;
}

function deriveScore(data, transcript) {
  const hasbudget = data.budget?.value && data.budget.value !== 'Unknown';
  const hasTimeline = data.timeline?.value && data.timeline.value !== 'Unknown';
  const isUrgent = /1 month|2 months|3 months|asap|immediately|now|weeks/i.test(transcript);

  if (hasbudget && hasTimeline && isUrgent) return 'Hot';
  if (hasbudget || hasTimeline) return 'Warm';
  return 'Cold';
}

function buildSummary(transcript) {
  if (!transcript) return 'No transcript available.';
  // Take last few exchanges as summary
  const lines = transcript.split('\n').filter(Boolean);
  return lines.slice(-6).join(' ').substring(0, 300);
}

// ─── Test endpoint ────────────────────────────────────────────────────────────
app.get('/test-lead', async (req, res) => {
  const type = req.query.type || 'buy';
  const testLead = type === 'rent' ? {
    callerName: 'Test Renter',
    callerPhone: process.env.REP_PHONE || '+447700000000',
    buyRent: 'Rent',
    propertyType: '2 bed apartment',
    location: 'Shoreditch / Bethnal Green',
    budget: '£2,500',
    timeline: 'End of next month',
    preApproved: 'N/A',
    whoMovingIn: 'Couple',
    pets: 'No',
    motivation: 'End of current tenancy',
    exclusivity: 'Searching independently',
    score: 'Hot',
    summary: 'Test rental lead. Couple looking for 2 bed in East London, £2,500 pcm, moving end of next month.',
    requestedHuman: false,
    callDuration: '4 min 32 sec',
    conversationId: 'TEST-RENT-' + Date.now(),
    timestamp: new Date().toISOString(),
  } : {
    callerName: 'Test Buyer',
    callerPhone: process.env.REP_PHONE || '+447700000000',
    buyRent: 'Buy',
    propertyType: 'House',
    location: 'Islington / Highbury',
    budget: '£950,000',
    timeline: '3 months',
    preApproved: 'Yes',
    whoMovingIn: 'N/A',
    pets: 'N/A',
    motivation: 'Upsizing',
    exclusivity: 'No other agent',
    score: 'Hot',
    summary: 'Test buyer lead. Family upsizing, mortgage in principle, North London, budget £950k, 3 month timeline.',
    requestedHuman: false,
    callDuration: '5 min 12 sec',
    conversationId: 'TEST-BUY-' + Date.now(),
    timestamp: new Date().toISOString(),
  };
  await notifyAllChannels(testLead);
  res.json({ success: true, message: `Test ${type} lead sent`, lead: testLead });
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ─── Notifications ────────────────────────────────────────────────────────────
async function notifyAllChannels(lead) {
  console.log('📣 Sending lead notifications...');
  const results = await Promise.allSettled([
    notifySMS(lead),
    notifyEmail(lead),
    notifySlack(lead),
    notifyWhatsApp(lead),
  ]);
  results.forEach((r, i) => {
    const channel = ['SMS', 'Email', 'Slack', 'WhatsApp'][i];
    if (r.status === 'rejected') console.error(`${channel} failed:`, r.reason?.message);
    else console.log(`✅ ${channel} sent`);
  });
}

function formatLeadText(lead) {
  const scoreEmoji = { Hot: '🔥', Warm: '🟡', Cold: '🔵' }[lead.score] || '⚪';
  const humanFlag = lead.requestedHuman ? '\n⚠️  REQUESTED HUMAN — CALL BACK PROMPTLY' : '';
  const isRent = lead.buyRent === 'Rent';
  return `
${scoreEmoji} NEW ${isRent ? 'RENTAL' : 'BUYER'} LEAD — ${lead.score?.toUpperCase()}${humanFlag}
━━━━━━━━━━━━━━━━━━━━
Name:         ${lead.callerName || 'Unknown'}
Phone:        ${lead.callerPhone}
Intent:       ${lead.buyRent}
Property:     ${lead.propertyType}
Location:     ${lead.location}
Budget:       ${lead.budget}${isRent ? ' pcm' : ''}
Timeline:     ${lead.timeline}
${isRent ? `Who moving in: ${lead.whoMovingIn || 'Unknown'}\nPets:          ${lead.pets || 'Unknown'}` : `Pre-approved:  ${lead.preApproved}`}
Motivation:   ${lead.motivation}
Exclusivity:  ${lead.exclusivity}
Call duration:${lead.callDuration}
━━━━━━━━━━━━━━━━━━━━
${lead.summary}
━━━━━━━━━━━━━━━━━━━━
Called: ${new Date(lead.timestamp).toLocaleString('en-GB')}
  `.trim();
}

async function notifySMS(lead) {
  if (!process.env.REP_PHONE) return;
  const msgOptions = {
    body: formatLeadText(lead),
    to: process.env.REP_PHONE,
  };
  // Use messaging service if available, otherwise fall back to direct number
  if (process.env.TWILIO_MESSAGING_SERVICE_SID) {
    msgOptions.messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
  } else {
    msgOptions.from = process.env.TWILIO_PHONE_NUMBER;
  }
  await twilioClient.messages.create(msgOptions);
}

async function notifyWhatsApp(lead) {
  if (!process.env.REP_WHATSAPP) return;
  await twilioClient.messages.create({
    body: formatLeadText(lead),
    from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
    to: `whatsapp:${process.env.REP_WHATSAPP}`,
  });
}

async function notifyEmail(lead) {
  if (!process.env.REP_EMAIL) return;
  const scoreColor = { Hot: '#c9400a', Warm: '#c99a0a', Cold: '#4a7fc9' }[lead.score] || '#666';
  const isRent = lead.buyRent === 'Rent';
  const humanBanner = lead.requestedHuman
    ? `<div style="background:#c9400a;color:#fff;padding:12px 32px;font-size:13px;letter-spacing:1px;">⚠️ THIS CALLER REQUESTED A HUMAN — CALL BACK PROMPTLY</div>`
    : '';
  const rows = [
    ['Name', lead.callerName || 'Unknown'],
    ['Phone', `<a href="tel:${lead.callerPhone}" style="color:#c9400a;font-weight:bold;font-size:18px;">${lead.callerPhone}</a>`],
    ['Intent', lead.buyRent],
    ['Property Type', lead.propertyType],
    ['Location', lead.location],
    ['Budget', `${lead.budget}${isRent ? ' pcm' : ''}`],
    ['Timeline', lead.timeline],
    isRent ? ['Who Moving In', lead.whoMovingIn || 'Unknown'] : ['Pre-Approved', lead.preApproved],
    isRent ? ['Pets', lead.pets || 'Unknown'] : null,
    ['Motivation', lead.motivation],
    ['Exclusivity', lead.exclusivity],
    ['Call Duration', lead.callDuration],
  ].filter(Boolean);

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:#1a1a18;padding:24px 32px;">
        <h2 style="color:#c9a96e;margin:0 0 8px 0;font-size:22px;font-weight:300;letter-spacing:2px;">NEW ${isRent ? 'RENTAL' : 'BUYER'} LEAD</h2>
        <span style="background:${scoreColor};color:#fff;padding:4px 12px;font-size:12px;letter-spacing:1px;text-transform:uppercase;">${lead.score}</span>
      </div>
      ${humanBanner}
      <div style="padding:32px;border:1px solid #eee;">
        <table style="width:100%;border-collapse:collapse;">
          ${rows.map(([k, v]) => `<tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#888;font-size:12px;width:140px;text-transform:uppercase;letter-spacing:1px;">${k}</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:15px;">${v}</td></tr>`).join('')}
        </table>
        <div style="margin-top:24px;padding:16px;background:#f9f9f7;border-left:3px solid #c9a96e;">
          <p style="margin:0;font-style:italic;color:#444;">${lead.summary}</p>
        </div>
        <div style="margin-top:24px;text-align:center;">
          <a href="tel:${lead.callerPhone}" style="background:#1a1a18;color:#c9a96e;padding:14px 32px;text-decoration:none;font-size:13px;letter-spacing:2px;text-transform:uppercase;display:inline-block;">📞 Call Now</a>
        </div>
      </div>
      <div style="padding:16px 32px;background:#f9f9f7;text-align:center;font-size:11px;color:#aaa;">
        Lead received ${new Date(lead.timestamp).toLocaleString('en-GB')} · ${process.env.AGENCY_NAME || 'Estate Agency'} AI Qualifier
      </div>
    </div>
  `;

  await sgMail.send({
    to: process.env.REP_EMAIL,
    from: { email: process.env.FROM_EMAIL, name: `${process.env.AGENCY_NAME || 'Agency'} AI` },
    subject: lead.requestedHuman
      ? `⚠️ CALLBACK NEEDED: ${lead.callerPhone} — requested human agent`
      : `${lead.score === 'Hot' ? '🔥' : '🟡'} ${isRent ? 'Rental' : 'Buyer'} Lead: ${lead.callerName || lead.callerPhone} — ${lead.budget}${isRent ? ' pcm' : ''} — ${lead.location}`,
    html,
    text: formatLeadText(lead),
  });
}

async function notifySlack(lead) {
  if (!process.env.SLACK_WEBHOOK_URL) return;
  const scoreEmoji = { Hot: ':fire:', Warm: ':large_yellow_circle:', Cold: ':large_blue_circle:' }[lead.score] || ':white_circle:';
  const isRent = lead.buyRent === 'Rent';
  const humanBlock = lead.requestedHuman ? [{ type: 'section', text: { type: 'mrkdwn', text: ':warning: *This caller requested a human agent — call them back promptly*' } }] : [];

  await axios.post(process.env.SLACK_WEBHOOK_URL, {
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `${scoreEmoji} New ${isRent ? 'Rental' : 'Buyer'} Lead — ${lead.score} — ${lead.callerName || 'Unknown'}` } },
      ...humanBlock,
      { type: 'section', fields: [
        { type: 'mrkdwn', text: `*Phone*\n${lead.callerPhone}` },
        { type: 'mrkdwn', text: `*Intent*\n${lead.buyRent}` },
        { type: 'mrkdwn', text: `*Budget*\n${lead.budget}${isRent ? ' pcm' : ''}` },
        { type: 'mrkdwn', text: `*Timeline*\n${lead.timeline}` },
        { type: 'mrkdwn', text: `*Location*\n${lead.location}` },
        { type: 'mrkdwn', text: `*Call Duration*\n${lead.callDuration}` },
      ]},
      { type: 'section', text: { type: 'mrkdwn', text: `_${lead.summary}_` } },
      { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: '📞 Call Now' }, style: 'primary', url: `tel:${lead.callerPhone}` }] },
    ],
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🏠 Real Estate Lead Notification Server running on port ${PORT}`);
  console.log(`📞 ElevenLabs webhook endpoint: https://YOUR_DOMAIN/webhook\n`);
});
