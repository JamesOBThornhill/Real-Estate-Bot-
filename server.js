/**
 * Real Estate AI Qualification Bot
 * ElevenLabs Agent handles the call
 * This server receives post-call webhook and fires all lead notifications
 */

require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const twilio = require('twilio');
const { Resend } = require('resend');
const axios = require('axios');

const app = express();

// Raw body needed for webhook signature verification
app.use('/webhook', express.raw({ type: '*/*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ─── Clients ─────────────────────────────────────────────────────────────────
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const resend = new Resend(process.env.RESEND_API_KEY);

// ─── ElevenLabs Post-Call Webhook ─────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  try {
    const rawBody = req.body.toString();

    // Verify HMAC signature
    const secret = process.env.ELEVENLABS_WEBHOOK_SECRET;
    if (secret) {
      const signature = req.headers['elevenlabs-signature'];
      if (!signature) {
        console.error('❌ Missing webhook signature');
        return res.sendStatus(401);
      }

      const parts = Object.fromEntries(signature.split(',').map(p => p.split('=')));
      const timestamp = parts['t'];
      const sig = parts['v0'];

      if (!timestamp || !sig) {
        console.error('❌ Invalid signature format');
        return res.sendStatus(401);
      }

      const age = Math.abs(Date.now() - parseInt(timestamp));
      if (age > 30 * 60 * 1000) {
        console.error('❌ Webhook timestamp too old');
        return res.sendStatus(401);
      }

      const message = `${timestamp}.${rawBody}`;
      const expected = crypto.createHmac('sha256', secret).update(message).digest('hex');

      if (expected !== sig) {
        console.error('❌ Invalid webhook signature');
        return res.sendStatus(401);
      }
    }

    const event = JSON.parse(rawBody);
    console.log(`📞 Webhook received: type=${event.type}`);

    // Only process post-call transcription events
    if (event.type !== 'post_call_transcription') {
      console.log(`⏭️ Skipping event type: ${event.type}`);
      return res.sendStatus(200);
    }

    const data = event.data;
    const analysis = data.analysis || {};
    const dataCollection = analysis.data_collection_results || {};
    const metadata = data.metadata || {};
    const transcript = data.transcript || [];

    // Extract caller phone from metadata
    const callerPhone = metadata.phone_call?.caller_id ||
                        metadata.twilio?.From ||
                        metadata.caller_id ||
                        'Unknown';

    // Helper to get collected data value
    const get = (key) => dataCollection[key]?.value || 'Unknown';

    // Calculate call duration
    const durationSecs = metadata.call_duration_secs || 0;
    const callDuration = `${Math.floor(durationSecs / 60)} min ${durationSecs % 60} sec`;

    // Check if caller requested human from transcript
    const fullTranscript = transcript.map(t => t.message || '').join(' ').toLowerCase();
    const requestedHuman = fullTranscript.includes('speak to a human') ||
                           fullTranscript.includes('real person') ||
                           fullTranscript.includes('transfer me') ||
                           fullTranscript.includes('speak to someone');

    // Derive lead score
    const budget = get('budget');
    const timeline = get('timeline');
    const isUrgent = /1 month|2 month|3 month|asap|immediately|now|week|soon/i.test(timeline);
    const hasBudget = budget !== 'Unknown';
    const hasTimeline = timeline !== 'Unknown';

    let score = 'Cold';
    if (hasBudget && hasTimeline && isUrgent) score = 'Hot';
    else if (hasBudget || hasTimeline) score = 'Warm';

    const lead = {
      callerPhone,
      callerName: get('caller_name'),
      callerEmail: get('caller_email'),
      buyRent: get('buy_rent'),
      propertyType: get('property_type'),
      location: get('location'),
      budget,
      bedrooms: get('bedrooms'),
      timeline,
      preApproved: get('pre_approved'),
      whoMovingIn: get('who_moving_in'),
      pets: get('pets'),
      motivation: get('motivation'),
      otherAgents: get('other_agents'),
      mustHaves: get('must_haves'),
      score,
      summary: analysis.transcript_summary || 'No summary available.',
      requestedHuman,
      callDuration,
      conversationId: data.conversation_id,
      timestamp: new Date().toISOString(),
    };

    console.log('✅ Lead extracted:', JSON.stringify(lead, null, 2));
    await notifyAllChannels(lead);

    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err);
    res.sendStatus(500);
  }
});

// ─── Test endpoint ────────────────────────────────────────────────────────────
app.get('/test-lead', async (req, res) => {
  const type = req.query.type || 'buy';
  const testLead = type === 'rent' ? {
    callerName: 'Test Renter',
    callerPhone: process.env.REP_PHONE || '+447700000000',
    callerEmail: 'test@example.com',
    buyRent: 'Rent',
    propertyType: '2 bed apartment',
    location: 'Shoreditch / Bethnal Green',
    budget: '£2,500',
    bedrooms: '2',
    timeline: 'End of next month',
    preApproved: 'N/A',
    whoMovingIn: 'Couple',
    pets: 'No',
    motivation: 'End of current tenancy',
    otherAgents: 'No',
    mustHaves: 'Parking, garden',
    score: 'Hot',
    summary: 'Test rental lead. Couple looking for 2 bed in East London, £2,500 pcm, moving end of next month.',
    requestedHuman: false,
    callDuration: '4 min 32 sec',
    conversationId: 'TEST-RENT-' + Date.now(),
    timestamp: new Date().toISOString(),
  } : {
    callerName: 'Test Buyer',
    callerPhone: process.env.REP_PHONE || '+447700000000',
    callerEmail: 'test@example.com',
    buyRent: 'Buy',
    propertyType: 'House',
    location: 'Islington / Highbury',
    budget: '£950,000',
    bedrooms: '3',
    timeline: '3 months',
    preApproved: 'Yes',
    whoMovingIn: 'N/A',
    pets: 'N/A',
    motivation: 'Upsizing',
    otherAgents: 'No',
    mustHaves: 'Garden, parking',
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
    notifyEmail(lead),
    notifySlack(lead),
  ]);
  results.forEach((r, i) => {
    const channel = ['Email', 'Slack'][i];
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
Name:          ${lead.callerName}
Phone:         ${lead.callerPhone}
Email:         ${lead.callerEmail}
Intent:        ${lead.buyRent}
Property:      ${lead.propertyType}
Bedrooms:      ${lead.bedrooms}
Location:      ${lead.location}
Budget:        ${lead.budget}${isRent ? ' pcm' : ''}
Timeline:      ${lead.timeline}
${isRent
  ? `Who moving in: ${lead.whoMovingIn}\nPets:          ${lead.pets}`
  : `Pre-approved:  ${lead.preApproved}`}
Motivation:    ${lead.motivation}
Must-haves:    ${lead.mustHaves}
Other agents:  ${lead.otherAgents}
Call duration: ${lead.callDuration}
━━━━━━━━━━━━━━━━━━━━
${lead.summary}
━━━━━━━━━━━━━━━━━━━━
Called: ${new Date(lead.timestamp).toLocaleString('en-GB')}
  `.trim();
}

async function notifyEmail(lead) {
  if (!process.env.REP_EMAIL) return;
  const scoreColor = { Hot: '#c9400a', Warm: '#c99a0a', Cold: '#4a7fc9' }[lead.score] || '#666';
  const isRent = lead.buyRent === 'Rent';
  const humanBanner = lead.requestedHuman
    ? `<div style="background:#c9400a;color:#fff;padding:12px 32px;font-size:13px;letter-spacing:1px;">⚠️ THIS CALLER REQUESTED A HUMAN — CALL BACK PROMPTLY</div>`
    : '';

  const rows = [
    ['Name', lead.callerName],
    ['Phone', `<a href="tel:${lead.callerPhone}" style="color:#c9400a;font-weight:bold;font-size:18px;">${lead.callerPhone}</a>`],
    ['Email', `<a href="mailto:${lead.callerEmail}">${lead.callerEmail}</a>`],
    ['Intent', lead.buyRent],
    ['Property Type', lead.propertyType],
    ['Bedrooms', lead.bedrooms],
    ['Location', lead.location],
    ['Budget', `${lead.budget}${isRent ? ' pcm' : ''}`],
    ['Timeline', lead.timeline],
    isRent ? ['Who Moving In', lead.whoMovingIn] : ['Pre-Approved', lead.preApproved],
    isRent ? ['Pets', lead.pets] : null,
    ['Motivation', lead.motivation],
    ['Must-Haves', lead.mustHaves],
    ['Other Agents', lead.otherAgents],
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

  await resend.emails.send({
    to: process.env.REP_EMAIL,
    from: `${process.env.AGENCY_NAME || 'Agency'} AI <${process.env.FROM_EMAIL}>`,
    subject: lead.requestedHuman
      ? `⚠️ CALLBACK NEEDED: ${lead.callerPhone} — requested human agent`
      : `${lead.score === 'Hot' ? '🔥' : '🟡'} ${isRent ? 'Rental' : 'Buyer'} Lead: ${lead.callerName} — ${lead.budget}${isRent ? ' pcm' : ''} — ${lead.location}`,
    html,
    text: formatLeadText(lead),
  });
}

async function notifySlack(lead) {
  if (!process.env.SLACK_WEBHOOK_URL) return;
  const scoreEmoji = { Hot: ':fire:', Warm: ':large_yellow_circle:', Cold: ':large_blue_circle:' }[lead.score] || ':white_circle:';
  const isRent = lead.buyRent === 'Rent';
  const humanBlock = lead.requestedHuman ? [{
    type: 'section',
    text: { type: 'mrkdwn', text: ':warning: *This caller requested a human agent — call them back promptly*' }
  }] : [];

  await axios.post(process.env.SLACK_WEBHOOK_URL, {
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `${scoreEmoji} New ${isRent ? 'Rental' : 'Buyer'} Lead — ${lead.score} — ${lead.callerName}` } },
      ...humanBlock,
      { type: 'section', fields: [
        { type: 'mrkdwn', text: `*Phone*\n${lead.callerPhone}` },
        { type: 'mrkdwn', text: `*Email*\n${lead.callerEmail}` },
        { type: 'mrkdwn', text: `*Intent*\n${lead.buyRent}` },
        { type: 'mrkdwn', text: `*Budget*\n${lead.budget}${isRent ? ' pcm' : ''}` },
        { type: 'mrkdwn', text: `*Location*\n${lead.location}` },
        { type: 'mrkdwn', text: `*Timeline*\n${lead.timeline}` },
      ]},
      { type: 'section', text: { type: 'mrkdwn', text: `_${lead.summary}_` } },
      { type: 'actions', elements: [
        { type: 'button', text: { type: 'plain_text', text: '📞 Call Now' }, style: 'primary', url: `tel:${lead.callerPhone}` },
      ]},
    ],
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🏠 Real Estate Lead Notification Server running on port ${PORT}`);
  console.log(`📞 ElevenLabs webhook endpoint: https://YOUR_DOMAIN/webhook\n`);
});
