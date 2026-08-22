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
    const transcript = data.transcript || [];
    const durationSecs = data.metadata?.call_duration_secs || 0;

    // Ignore very short calls with no meaningful conversation
    if (durationSecs < 10 || transcript.length < 2) {
      console.log(`⏭️ Skipping call — too short (${durationSecs}s, ${transcript.length} turns)`);
      return res.sendStatus(200);
    }

    const analysis = data.analysis || {};
    const dataCollection = analysis.data_collection_results || {};
    const metadata = data.metadata || {};

    // Extract caller phone from metadata
    const callerPhone = metadata.phone_call?.caller_id ||
                        metadata.twilio?.From ||
                        metadata.caller_id ||
                        'Unknown';

    // Helper to get collected data value
    const get = (key) => dataCollection[key]?.value || 'Unknown';

    // Calculate call duration
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
      callerPhone: get('caller_phone') !== 'Unknown' ? get('caller_phone') : callerPhone,
      callerName: get('caller_name'),
      callerEmail: get('caller_email'),
      enquiryType: get('enquiry_type'),
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
    callerPhone: '+447711797894',
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
    callerPhone: '+447711797894',
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
Enquiry:       ${lead.enquiryType}
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
  const scoreEmoji = { Hot: '🔥', Warm: '🟡', Cold: '🔵' }[lead.score] || '⚪';
  const scoreBg = { Hot: '#c9400a', Warm: '#c99a0a', Cold: '#4a7fc9' }[lead.score] || '#666';
  const scoreLabel = { Hot: 'HOT LEAD — ACT NOW', Warm: 'WARM LEAD', Cold: 'COLD LEAD' }[lead.score] || 'NEW LEAD';
  const isRent = lead.buyRent === 'Rent';
  const enquiryLabel = lead.enquiryType || lead.buyRent || 'New Enquiry';
  const humanBanner = lead.requestedHuman
    ? `<div style="background:#c9400a;color:#fff;padding:12px 32px;font-size:13px;letter-spacing:1px;text-align:center;">⚠️ THIS CALLER REQUESTED A HUMAN — CALL BACK PROMPTLY</div>`
    : '';

  const rows = [
    ['Name', lead.callerName],
    ['Phone', `<a href="tel:${lead.callerPhone}" style="color:#c9400a;font-weight:bold;font-size:18px;">${lead.callerPhone}</a>`],
    ['Email', `<a href="mailto:${lead.callerEmail}">${lead.callerEmail}</a>`],
    ['Enquiry Type', lead.enquiryType],
    ['Intent', lead.buyRent],
    ['Property Type', lead.propertyType],
    ['Bedrooms', lead.bedrooms],
    ['Location', lead.location],
    ['Budget', `${lead.budget}${isRent ? ' pcm' : ''}`],
    ['Timeline', lead.timeline],
    isRent ? ['Who Moving In', lead.whoMovingIn] : ['Mortgage Options', lead.preApproved],
    isRent ? ['Pets', lead.pets] : null,
    ['Motivation', lead.motivation],
    ['Must-Haves', lead.mustHaves],
    ['Other Agents', lead.otherAgents],
    ['Call Duration', lead.callDuration],
  ].filter(Boolean);

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:${scoreBg};padding:20px 32px;text-align:center;">
        <div style="font-size:32px;margin-bottom:6px;">${scoreEmoji}</div>
        <div style="color:#fff;font-size:18px;font-weight:bold;letter-spacing:2px;">${scoreLabel}</div>
        <div style="color:rgba(255,255,255,0.8);font-size:13px;margin-top:4px;">${enquiryLabel} Enquiry · ${new Date(lead.timestamp).toLocaleString('en-GB')}</div>
      </div>
      ${humanBanner}
      <div style="background:#f9f9f7;padding:20px 32px;border-left:4px solid ${scoreBg};">
        <p style="margin:0;font-size:15px;color:#333;font-style:italic;line-height:1.6;">${lead.summary}</p>
      </div>
      <div style="background:#fff;padding:24px 32px;text-align:center;border-bottom:1px solid #eee;">
        <a href="tel:${lead.callerPhone}" style="background:${scoreBg};color:#fff;padding:16px 40px;text-decoration:none;font-size:15px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;display:inline-block;border-radius:4px;">📞 Call ${lead.callerName} Now</a>
        <div style="margin-top:10px;font-size:13px;color:#888;">${lead.callerPhone}</div>
      </div>
      <div style="padding:24px 32px;border:1px solid #eee;border-top:none;">
        <table style="width:100%;border-collapse:collapse;">
          ${rows.map(([k, v]) => `
            <tr>
              <td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#888;font-size:11px;width:130px;text-transform:uppercase;letter-spacing:1px;vertical-align:top;">${k}</td>
              <td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:14px;color:#222;">${v}</td>
            </tr>
          `).join('')}
        </table>
      </div>
      <div style="padding:16px 32px;background:#1a1a18;text-align:center;">
        <div style="color:#c9a96e;font-size:13px;letter-spacing:1px;">${process.env.AGENCY_NAME || 'Estate Agency'} AI Qualifier</div>
        <div style="color:#555;font-size:11px;margin-top:4px;">This lead was automatically qualified by AI</div>
      </div>
    </div>
  `;

  await resend.emails.send({
    to: process.env.REP_EMAIL,
    from: `${process.env.AGENCY_NAME || 'Agency'} AI <${process.env.FROM_EMAIL}>`,
    subject: lead.requestedHuman
      ? `⚠️ CALLBACK NEEDED: ${lead.callerPhone} — requested human agent`
      : `${lead.score === 'Hot' ? '🔥' : '🟡'} ${enquiryLabel} Lead: ${lead.callerName} — ${lead.budget} — ${lead.location}`,
    html,
    text: formatLeadText(lead),
  });
}

async function notifySlack(lead) {
  if (!process.env.SLACK_WEBHOOK_URL) return;
  const scoreEmoji = { Hot: ':fire:', Warm: ':large_yellow_circle:', Cold: ':large_blue_circle:' }[lead.score] || ':white_circle:';
  const isRent = lead.buyRent === 'Rent';
  const enquiryLabel = lead.enquiryType || lead.buyRent || 'New Enquiry';
  const humanBlock = lead.requestedHuman ? [{
    type: 'section',
    text: { type: 'mrkdwn', text: ':warning: *This caller requested a human agent — call them back promptly*' }
  }] : [];

   console.log('Slack URL:', process.env.SLACK_WEBHOOK_URL);
  await axios.post(process.env.SLACK_WEBHOOK_URL, {
    text: `${scoreEmoji} *New ${enquiryLabel} Lead — ${lead.score} — ${lead.callerName}*\n*Phone:* ${lead.callerPhone}\n*Email:* ${lead.callerEmail}\n*Budget:* ${lead.budget}\n*Location:* ${lead.location}\n*Timeline:* ${lead.timeline}\n_${lead.summary}_`,
  });
      { type: 'header', text: { type: 'plain_text', text: `${scoreEmoji} New ${enquiryLabel} Lead — ${lead.score} — ${lead.callerName}` } },
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
