/**
 * Real Estate AI Qualification Bot
 * Twilio Phone Line + Claude AI + Multi-channel Lead Notifications
 * With human transfer fallback + re-qualification attempt
 */

require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const { Readable, PassThrough } = require('stream');
const { createClient: createDeepgramClient } = require('@deepgram/sdk');
const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');
const sgMail = require('@sendgrid/mail');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ─── Clients ─────────────────────────────────────────────────────────────────
const deepgram = createDeepgramClient(process.env.DEEPGRAM_API_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// ─── Phrases that indicate caller wants a human ───────────────────────────────
const HUMAN_PHRASES = [
  'speak to a human', 'speak to someone', 'speak to a person',
  'talk to a human', 'talk to someone', 'talk to a person',
  'real person', 'actual person', 'transfer me', 'transfer to',
  'put me through', 'connect me', 'speak to an agent',
  'talk to an agent', 'human please', 'person please',
  'just transfer', 'just put me through', 'no thanks',
  'not interested in ai', 'want a human'
];

function wantsHuman(text) {
  const lower = text.toLowerCase();
  return HUMAN_PHRASES.some(phrase => lower.includes(phrase));
}

// ─── AI System Prompt ─────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a warm, professional AI property consultant for ${process.env.AGENCY_NAME || 'our estate agency'}. 
You are speaking with a prospect on the phone. Keep responses SHORT and conversational — 1-2 sentences max, as this is a phone call.

Your goal is to qualify the prospect by naturally gathering information. Ask one question at a time. Be warm and natural — never robotic.

Start with a friendly greeting introducing yourself as the AI property consultant for ${process.env.AGENCY_NAME || 'the agency'}.

STEP 1 — Always ask first: Are they looking to buy or rent?

IF BUYING — gather these in natural order:
1. Property type (house, apartment, new build, commercial)?
2. Preferred areas or neighbourhoods?
3. Budget range (total purchase price)?
4. Timeline (ready now, 1-3 months, 6+ months, just browsing)?
5. Have they spoken to a mortgage broker or are they a cash buyer?
6. What is driving the move (upsizing, downsizing, investment, relocation, first home)?
7. Are they currently working with any other agents?
8. Confirm best name and number for follow-up.

IF RENTING — gather these in natural order:
1. Property type (house, apartment, studio, room)?
2. Preferred areas or neighbourhoods?
3. Monthly budget for rent?
4. Move-in date or timeline?
5. Who will be moving in (just themselves, couple, family, sharers)?
6. Do they have pets?
7. What is prompting the move (end of tenancy, relocating, new job, upsizing)?
8. Are they currently working with any other letting agents or searching independently?
9. Confirm best name and number for follow-up.

NEVER ask a renter about mortgages or purchase price.
NEVER ask a buyer about monthly rent or move-in occupants.

When you have gathered sufficient information say "QUALIFICATION_COMPLETE" on a new line followed by a JSON object:
{
  "callerName": "string",
  "callerPhone": "string",
  "buyRent": "Buy|Rent",
  "propertyType": "string",
  "location": "string",
  "budget": "string",
  "timeline": "string",
  "preApproved": "Yes|No|Cash Buyer|N/A",
  "whoMovingIn": "string",
  "pets": "Yes|No|N/A",
  "motivation": "string",
  "exclusivity": "string",
  "score": "Hot|Warm|Cold",
  "summary": "2-3 sentence summary for the rep"
}

Score guide:
BUYERS: Hot = clear budget + under 3 months + mortgage ready. Warm = vague timeline or budget. Cold = just browsing.
RENTERS: Hot = moving within 4 weeks + clear budget. Warm = 1-2 months. Cold = no firm date.`;

const REQUALIFY_PROMPT = `You are a warm, professional AI property consultant. The caller has asked to speak to a human agent.

Make ONE gentle attempt: "Of course, I completely understand! I just want to make sure the agent who calls you back has everything they need. Could I grab your name and what you are looking for — it only takes 30 seconds?"

If they agree, gather name, buy/rent, location, budget then say "QUALIFICATION_COMPLETE" with what you have, score as "Warm".
If they say no or repeat they want a human, say exactly: "TRANSFER_NOW"

1-2 sentences only. Do not be pushy.`;

// ─── Active call sessions ─────────────────────────────────────────────────────
const sessions = new Map();

// ─── Twilio TwiML webhook ─────────────────────────────────────────────────────
app.post('/incoming-call', (req, res) => {
  const callSid = req.body.CallSid;
  const callerPhone = req.body.From;
  console.log(`📞 Incoming call: ${callSid} from ${callerPhone}`);

  sessions.set(callSid, {
    callSid,
    callerPhone,
    messages: [],
    qualified: false,
    humanRequested: false,
    requalifyAttempted: false,
    streamSid: null,
  });

  const twiml = new twilio.twiml.VoiceResponse();
  const connect = twiml.connect();
  connect.stream({
    url: `wss://${req.headers.host}/media-stream`,
    name: callSid,
  });

  res.type('text/xml').send(twiml.toString());
});

// ─── Transfer endpoint ────────────────────────────────────────────────────────
app.post('/transfer-call', (req, res) => {
  const agentNumber = process.env.REP_PHONE;
  const twiml = new twilio.twiml.VoiceResponse();
  if (agentNumber) {
    twiml.dial(agentNumber);
  } else {
    twiml.say('No agent is available right now. Someone will call you back very shortly. Goodbye.');
    twiml.hangup();
  }
  res.type('text/xml').send(twiml.toString());
});

// ─── Call status callback ─────────────────────────────────────────────────────
app.post('/call-status', (req, res) => {
  const { CallSid, CallStatus } = req.body;
  console.log(`📱 Call ${CallSid} status: ${CallStatus}`);
  if (['completed', 'failed', 'busy', 'no-answer'].includes(CallStatus)) {
    sessions.delete(CallSid);
  }
  res.sendStatus(200);
});

// ─── WebSocket — Twilio Media Stream ─────────────────────────────────────────
wss.on('connection', (ws) => {
  console.log('🔌 WebSocket connected');
  let session = null;
  let dgLive = null;
  let isSpeaking = false;

  ws.on('message', async (data) => {
    const msg = JSON.parse(data);

    switch (msg.event) {
      case 'start': {
        const callSid = msg.start.customParameters?.name || msg.start.callSid;
        session = sessions.get(callSid);
        if (!session) { ws.close(); return; }
        session.streamSid = msg.start.streamSid;
        session.ws = ws;
        console.log(`🎙️ Stream started for call ${callSid}`);

        dgLive = deepgram.listen.live({
          model: 'nova-2',
          language: 'en-GB',
          encoding: 'mulaw',
          sample_rate: 8000,
          channels: 1,
          punctuate: true,
          endpointing: 300,
          smart_format: true,
        });

        dgLive.on('open', () => {
          console.log('🎤 Deepgram live open');
          processAITurn(session, null, ws);
        });

        dgLive.on('Results', async (result) => {
          const transcript = result.channel?.alternatives?.[0]?.transcript;
          if (!transcript || !result.is_final || isSpeaking) return;
          console.log(`👤 Caller said: "${transcript}"`);
          if (session.qualified) return;

          if (wantsHuman(transcript) && !session.requalifyAttempted) {
            session.humanRequested = true;
            session.requalifyAttempted = true;
            await handleRequalify(session, transcript, ws);
            return;
          }

          await processAITurn(session, transcript, ws);
        });

        dgLive.on('error', (err) => console.error('Deepgram error:', err));
        break;
      }

      case 'media': {
        if (dgLive && dgLive.getReadyState() === 1) {
          const audio = Buffer.from(msg.media.payload, 'base64');
          dgLive.send(audio);
        }
        break;
      }

      case 'stop': {
        console.log('🛑 Stream stopped');
        if (dgLive) dgLive.finish();
        break;
      }
    }
  });

  ws.on('close', () => {
    if (dgLive) dgLive.finish();
  });

  // ── Re-qualification attempt ───────────────────────────────────────────────
  async function handleRequalify(session, userText, ws) {
    session.messages.push({ role: 'user', content: userText });
    let aiReply;
    try {
      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        system: REQUALIFY_PROMPT,
        messages: session.messages,
      });
      aiReply = response.content[0].text;
    } catch (err) {
      console.error('Claude error:', err);
      await initiateTransfer(session, ws);
      return;
    }

    session.messages.push({ role: 'assistant', content: aiReply });

    if (aiReply.includes('TRANSFER_NOW')) {
      await initiateTransfer(session, ws);
      return;
    }

    if (aiReply.includes('QUALIFICATION_COMPLETE')) {
      await handleQualificationComplete(aiReply, session, ws);
      return;
    }

    await speakToCall(aiReply, session.streamSid, ws);
    session.finalTransferAttempt = true;
  }

  // ── Main AI turn ───────────────────────────────────────────────────────────
  async function processAITurn(session, userText, ws) {
    if (session.finalTransferAttempt && userText && wantsHuman(userText)) {
      await initiateTransfer(session, ws);
      return;
    }
    if (session.finalTransferAttempt) session.finalTransferAttempt = false;

    if (userText) session.messages.push({ role: 'user', content: userText });

    let aiReply;
    try {
      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        system: SYSTEM_PROMPT + `\n\nCaller phone: ${session.callerPhone}`,
        messages: session.messages.length > 0
          ? session.messages
          : [{ role: 'user', content: 'Hello, I just called your agency.' }],
      });
      aiReply = response.content[0].text;
    } catch (err) {
      console.error('Claude error:', err);
      return;
    }

    session.messages.push({ role: 'assistant', content: aiReply });

    if (aiReply.includes('QUALIFICATION_COMPLETE')) {
      await handleQualificationComplete(aiReply, session, ws);
      return;
    }

    await speakToCall(aiReply, session.streamSid, ws);
  }

  // ── Qualification complete ─────────────────────────────────────────────────
  async function handleQualificationComplete(aiReply, session, ws) {
    const spokenPart = aiReply.split('QUALIFICATION_COMPLETE')[0].trim();
    const jsonMatch = aiReply.match(/\{[\s\S]*\}/);

    if (spokenPart) await speakToCall(spokenPart, session.streamSid, ws);

    if (jsonMatch) {
      try {
        const lead = JSON.parse(jsonMatch[0]);
        lead.callerPhone = lead.callerPhone || session.callerPhone;
        lead.callSid = session.callSid;
        lead.timestamp = new Date().toISOString();
        lead.requestedHuman = session.humanRequested || false;
        session.qualified = true;
        console.log('✅ Lead qualified:', lead);
        await notifyAllChannels(lead);
      } catch (e) {
        console.error('JSON parse error:', e);
      }
    }

    setTimeout(() => {
      twilioClient.calls(session.callSid).update({ status: 'completed' }).catch(() => {});
    }, 5000);
  }

  // ── Transfer to human ──────────────────────────────────────────────────────
  async function initiateTransfer(session, ws) {
    console.log('🔄 Transferring to human agent');

    const partialLead = {
      callerName: 'Unknown — requested human',
      callerPhone: session.callerPhone,
      buyRent: 'Unknown', propertyType: 'Unknown', location: 'Unknown',
      budget: 'Unknown', timeline: 'Unknown', preApproved: 'Unknown',
      whoMovingIn: 'Unknown', pets: 'Unknown', motivation: 'Unknown',
      exclusivity: 'Unknown', score: 'Warm',
      summary: `Caller requested human agent. ${session.messages.length > 2 ? `Had ${Math.floor(session.messages.length / 2)} exchanges before requesting transfer.` : 'Requested human immediately.'} Call back promptly.`,
      requestedHuman: true,
      callSid: session.callSid,
      timestamp: new Date().toISOString(),
    };

    notifyAllChannels(partialLead).catch(console.error);

    await speakToCall(
      'Absolutely no problem at all. I am transferring you to one of our agents right now. I have already sent your details across — so if they miss your call they will get back to you as soon as possible. Please hold.',
      session.streamSid, ws
    );

    await twilioClient.calls(session.callSid)
      .update({ url: `https://${process.env.RENDER_URL}/transfer-call`, method: 'POST' })
      .catch(err => console.error('Transfer error:', err));

    session.qualified = true;
  }

  // ── ElevenLabs TTS with ffmpeg conversion ─────────────────────────────────
  async function speakToCall(text, streamSid, ws) {
    isSpeaking = true;
    console.log(`🔊 Speaking: "${text.substring(0, 60)}..."`);
    try {
      const response = await axios({
        method: 'post',
        url: `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}`,
        headers: {
          'xi-api-key': process.env.ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
        },
        data: {
          text,
          model_id: 'eleven_flash_v2_5',
          output_format: 'mp3_44100_128',
          voice_settings: { stability: 0.75, similarity_boost: 0.75 },
        },
        responseType: 'arraybuffer',
      });

      // Convert PCM 24000hz stereo → mulaw 8000hz mono for Twilio
      const inputBuffer = Buffer.from(response.data);
      const outputBuffer = await new Promise((resolve, reject) => {
        const chunks = [];
        const inputStream = new Readable();
        inputStream.push(inputBuffer);
        inputStream.push(null);

        const outputStream = new PassThrough();
        outputStream.on('data', chunk => chunks.push(chunk));
        outputStream.on('end', () => resolve(Buffer.concat(chunks)));
        outputStream.on('error', reject);

        ffmpeg(inputStream)
          .inputFormat('s16le')
          .inputOptions(['-ar 24000', '-ac 2'])
          .outputFormat('mulaw')
          .outputOptions(['-ar 8000', '-ac 1'])
          .pipe(outputStream);
      });

      const audioBase64 = outputBuffer.toString('base64');

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: audioBase64 },
        }));
        ws.send(JSON.stringify({
          event: 'mark',
          streamSid,
          mark: { name: 'done' },
        }));
      }

      const durationMs = (outputBuffer.length / 8000) * 1000 + 300;
      await new Promise(r => setTimeout(r, durationMs));
    } catch (err) {
      console.error('ElevenLabs TTS error:', err.message);
    }
    isSpeaking = false;
  }
});

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
━━━━━━━━━━━━━━━━━━━━
${lead.summary}
━━━━━━━━━━━━━━━━━━━━
Called: ${new Date(lead.timestamp).toLocaleString('en-GB')}
  `.trim();
}

async function notifySMS(lead) {
  if (!process.env.REP_PHONE) return;
  await twilioClient.messages.create({
    body: formatLeadText(lead),
    from: process.env.TWILIO_PHONE_NUMBER,
    to: process.env.REP_PHONE,
  });
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
        { type: 'mrkdwn', text: `*Property*\n${lead.propertyType}` },
      ]},
      { type: 'section', text: { type: 'mrkdwn', text: `_${lead.summary}_` } },
      { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: '📞 Call Now' }, style: 'primary', url: `tel:${lead.callerPhone}` }] },
    ],
  });
}

// ─── Test endpoints ───────────────────────────────────────────────────────────
app.get('/test-lead', async (req, res) => {
  const type = req.query.type || 'buy';
  const testLead = type === 'rent' ? {
    callerName: 'Test Renter', callerPhone: process.env.REP_PHONE || '+447700000000',
    buyRent: 'Rent', propertyType: '2 bed apartment', location: 'Shoreditch / Bethnal Green',
    budget: '£2,500', timeline: 'End of next month', preApproved: 'N/A',
    whoMovingIn: 'Couple', pets: 'No', motivation: 'End of current tenancy',
    exclusivity: 'Searching independently', score: 'Hot',
    summary: 'Test rental lead. Couple looking for 2 bed in East London, £2,500 pcm, moving end of next month.',
    requestedHuman: false, callSid: 'TEST-RENT-' + Date.now(), timestamp: new Date().toISOString(),
  } : {
    callerName: 'Test Buyer', callerPhone: process.env.REP_PHONE || '+447700000000',
    buyRent: 'Buy', propertyType: 'House', location: 'Islington / Highbury',
    budget: '£950,000', timeline: '3 months', preApproved: 'Yes',
    whoMovingIn: 'N/A', pets: 'N/A', motivation: 'Upsizing',
    exclusivity: 'No other agent', score: 'Hot',
    summary: 'Test buyer lead. Family upsizing, mortgage in principle, North London, budget £950k, 3 month timeline.',
    requestedHuman: false, callSid: 'TEST-BUY-' + Date.now(), timestamp: new Date().toISOString(),
  };
  await notifyAllChannels(testLead);
  res.json({ success: true, message: `Test ${type} lead sent`, lead: testLead });
});

app.get('/health', (req, res) => res.json({ status: 'ok', sessions: sessions.size }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🏠 Real Estate AI Bot running on port ${PORT}`);
  console.log(`📞 Webhook: https://YOUR_DOMAIN/incoming-call\n`);
});
