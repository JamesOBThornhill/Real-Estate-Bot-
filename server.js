/**
 * Real Estate AI Qualification Bot
 * Twilio Phone Line + Claude AI + Multi-channel Lead Notifications
 */

require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const { createClient: createDeepgramClient } = require('@deepgram/sdk');
const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');
const sgMail = require('@sendgrid/mail');
const axios = require('axios');

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

// ─── AI System Prompt ─────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a warm, professional AI property consultant for ${process.env.AGENCY_NAME || 'our estate agency'}. 
You are speaking with a prospect on the phone. Keep responses SHORT and conversational — 1-2 sentences max, as this is a phone call.

Your goal is to qualify the prospect by naturally gathering:
1. Are they looking to buy or rent?
2. Property type (apartment, house, villa, commercial)?
3. Preferred areas or neighbourhoods?
4. Budget range?
5. Timeline (ready now, 1-3 months, 6+ months, just browsing)?
6. If buying: are they pre-approved for a mortgage or need guidance?
7. What's driving their move (upsizing, downsizing, investment, relocation)?
8. Are they currently working with another agent?
9. Best contact number and name for follow-up (confirm what they called from if possible).

Ask one question at a time. Be warm and natural — not robotic. 
Start with a friendly greeting introducing yourself as the AI consultant.

When you have gathered sufficient information (at minimum: intent, location, budget, timeline), 
say "QUALIFICATION_COMPLETE" on a new line followed by a JSON object:
{
  "callerName": "string",
  "callerPhone": "string (the inbound number)",
  "buyRent": "Buy|Rent",
  "propertyType": "string",
  "location": "string",
  "budget": "string",
  "timeline": "string",
  "preApproved": "Yes|No|N/A",
  "motivation": "string",
  "exclusivity": "string",
  "score": "Hot|Warm|Cold",
  "summary": "2-3 sentence summary for the rep"
}

Score guide:
- Hot: clear budget + timeline under 3 months + motivated
- Warm: interested but vague on timeline or budget  
- Cold: just browsing, no real intent`;

// ─── Active call sessions ─────────────────────────────────────────────────────
const sessions = new Map();

// ─── Twilio TwiML webhook — answers the phone ─────────────────────────────────
app.post('/incoming-call', (req, res) => {
  const callSid = req.body.CallSid;
  const callerPhone = req.body.From;
  console.log(`📞 Incoming call: ${callSid} from ${callerPhone}`);

  // Initialise session
  sessions.set(callSid, {
    callSid,
    callerPhone,
    messages: [],
    qualified: false,
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

// ─── Twilio call status callback ──────────────────────────────────────────────
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
  let audioBuffer = [];
  let speakQueue = [];
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

        // Open Deepgram live transcription
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
          // Send AI greeting once stream is up
          processAITurn(session, null, ws);
        });

        dgLive.on('Results', async (result) => {
          const transcript = result.channel?.alternatives?.[0]?.transcript;
          if (!transcript || !result.is_final || isSpeaking) return;
          console.log(`👤 Caller said: "${transcript}"`);
          if (!session.qualified) {
            await processAITurn(session, transcript, ws);
          }
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
    console.log('🔌 WebSocket disconnected');
    if (dgLive) dgLive.finish();
  });

  // ── AI turn: call Claude, TTS via ElevenLabs, stream audio back ────────────
  async function processAITurn(session, userText, ws) {
    if (userText) {
      session.messages.push({ role: 'user', content: userText });
    }

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

    // Check for qualification complete
    if (aiReply.includes('QUALIFICATION_COMPLETE')) {
      const spokenPart = aiReply.split('QUALIFICATION_COMPLETE')[0].trim();
      const jsonMatch = aiReply.match(/\{[\s\S]*\}/);

      if (spokenPart) await speakToCall(spokenPart, session.streamSid, ws);

      if (jsonMatch) {
        try {
          const lead = JSON.parse(jsonMatch[0]);
          lead.callerPhone = lead.callerPhone || session.callerPhone;
          lead.callSid = session.callSid;
          lead.timestamp = new Date().toISOString();
          session.qualified = true;
          console.log('✅ Lead qualified:', lead);
          await notifyAllChannels(lead);
        } catch (e) {
          console.error('JSON parse error:', e);
        }
      }

      // Hang up gracefully after a pause
      setTimeout(() => {
        twilioClient.calls(session.callSid)
          .update({ status: 'completed' })
          .catch(() => {});
      }, 5000);
      return;
    }

    // Normal response — speak it
    await speakToCall(aiReply, session.streamSid, ws);
  }

  // ── ElevenLabs TTS → stream mulaw audio back to Twilio ────────────────────
  async function speakToCall(text, streamSid, ws) {
    isSpeaking = true;
    console.log(`🔊 Speaking: "${text.substring(0, 60)}..."`);
    try {
      const response = await axios({
        method: 'post',
        url: `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}/stream`,
        headers: {
          'xi-api-key': process.env.ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
        },
        data: {
          text,
          model_id: 'eleven_flash_v2_5',
output_format: 'ulaw_8000',
voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.0 },
        },
        responseType: 'arraybuffer',
      });

      const audioBase64 = Buffer.from(response.data).toString('base64');
      const chunkSize = 640; // ~40ms of mulaw at 8kHz

      for (let i = 0; i < audioBase64.length; i += chunkSize) {
        const chunk = audioBase64.slice(i, i + chunkSize);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            event: 'media',
            streamSid,
            media: { payload: chunk },
          }));
        }
        // Pace the audio chunks
        await new Promise(r => setTimeout(r, 5));
      }

      // Send mark to know when audio finishes
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'done' } }));
      }

      // Estimate speaking duration to re-enable listening
      const durationMs = (response.data.byteLength / 8000) * 1000 + 500;
      await new Promise(r => setTimeout(r, durationMs));
    } catch (err) {
      console.error('ElevenLabs TTS error:', err.message);
    }
    isSpeaking = false;
  }
});

// ─── Lead Notification — all channels ────────────────────────────────────────
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
  return `
${scoreEmoji} NEW LEAD — ${lead.score?.toUpperCase()} 
━━━━━━━━━━━━━━━━━━━━
Name:        ${lead.callerName || 'Unknown'}
Phone:       ${lead.callerPhone}
Intent:      ${lead.buyRent}
Property:    ${lead.propertyType}
Location:    ${lead.location}
Budget:      ${lead.budget}
Timeline:    ${lead.timeline}
Pre-approved:${lead.preApproved}
Motivation:  ${lead.motivation}
Exclusivity: ${lead.exclusivity}
━━━━━━━━━━━━━━━━━━━━
${lead.summary}
━━━━━━━━━━━━━━━━━━━━
Called: ${new Date(lead.timestamp).toLocaleString('en-GB')}
  `.trim();
}

// SMS via Twilio
async function notifySMS(lead) {
  const repPhone = process.env.REP_PHONE;
  if (!repPhone) return;
  await twilioClient.messages.create({
    body: formatLeadText(lead),
    from: process.env.TWILIO_PHONE_NUMBER,
    to: repPhone,
  });
}

// WhatsApp via Twilio
async function notifyWhatsApp(lead) {
  const repWhatsApp = process.env.REP_WHATSAPP;
  if (!repWhatsApp) return;
  await twilioClient.messages.create({
    body: formatLeadText(lead),
    from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
    to: `whatsapp:${repWhatsApp}`,
  });
}

// Email via SendGrid
async function notifyEmail(lead) {
  const repEmail = process.env.REP_EMAIL;
  if (!repEmail) return;
  const scoreColor = { Hot: '#c9400a', Warm: '#c99a0a', Cold: '#4a7fc9' }[lead.score] || '#666';
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:#1a1a18;padding:24px 32px;">
        <h2 style="color:#c9a96e;margin:0;font-size:22px;font-weight:300;letter-spacing:2px;">NEW LEAD</h2>
        <span style="background:${scoreColor};color:#fff;padding:4px 12px;font-size:12px;letter-spacing:1px;text-transform:uppercase;">${lead.score}</span>
      </div>
      <div style="padding:32px;border:1px solid #eee;">
        <table style="width:100%;border-collapse:collapse;">
          ${[
            ['Name', lead.callerName || 'Unknown'],
            ['Phone', `<a href="tel:${lead.callerPhone}" style="color:#c9400a;font-weight:bold;font-size:18px;">${lead.callerPhone}</a>`],
            ['Intent', lead.buyRent],
            ['Property Type', lead.propertyType],
            ['Location', lead.location],
            ['Budget', lead.budget],
            ['Timeline', lead.timeline],
            ['Pre-Approved', lead.preApproved],
            ['Motivation', lead.motivation],
            ['Exclusivity', lead.exclusivity],
          ].map(([k, v]) => `
            <tr>
              <td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#888;font-size:12px;width:140px;text-transform:uppercase;letter-spacing:1px;">${k}</td>
              <td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:15px;">${v}</td>
            </tr>
          `).join('')}
        </table>
        <div style="margin-top:24px;padding:16px;background:#f9f9f7;border-left:3px solid #c9a96e;">
          <p style="margin:0;font-style:italic;color:#444;">${lead.summary}</p>
        </div>
        <div style="margin-top:24px;text-align:center;">
          <a href="tel:${lead.callerPhone}" style="background:#1a1a18;color:#c9a96e;padding:14px 32px;text-decoration:none;font-size:13px;letter-spacing:2px;text-transform:uppercase;display:inline-block;">
            📞 Call Now
          </a>
        </div>
      </div>
      <div style="padding:16px 32px;background:#f9f9f7;text-align:center;font-size:11px;color:#aaa;">
        Lead received ${new Date(lead.timestamp).toLocaleString('en-GB')} · ${process.env.AGENCY_NAME || 'Estate Agency'} AI Qualifier
      </div>
    </div>
  `;
  await sgMail.send({
    to: repEmail,
    from: { email: process.env.FROM_EMAIL, name: `${process.env.AGENCY_NAME || 'Agency'} AI` },
    subject: `🔥 ${lead.score} Lead: ${lead.callerName || lead.callerPhone} — ${lead.budget} ${lead.buyRent}`,
    html,
    text: formatLeadText(lead),
  });
}

// Slack webhook
async function notifySlack(lead) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return;
  const scoreEmoji = { Hot: ':fire:', Warm: ':large_yellow_circle:', Cold: ':large_blue_circle:' }[lead.score] || ':white_circle:';
  await axios.post(webhookUrl, {
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `${scoreEmoji} New ${lead.score} Lead — ${lead.callerName || 'Unknown'}` },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Phone*\n${lead.callerPhone}` },
          { type: 'mrkdwn', text: `*Intent*\n${lead.buyRent}` },
          { type: 'mrkdwn', text: `*Budget*\n${lead.budget}` },
          { type: 'mrkdwn', text: `*Timeline*\n${lead.timeline}` },
          { type: 'mrkdwn', text: `*Location*\n${lead.location}` },
          { type: 'mrkdwn', text: `*Property*\n${lead.propertyType}` },
        ],
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `_${lead.summary}_` },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '📞 Call Now' },
            style: 'primary',
            url: `tel:${lead.callerPhone}`,
          },
        ],
      },
    ],
  });
}

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', sessions: sessions.size }));

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🏠 Real Estate AI Bot running on port ${PORT}`);
  console.log(`📞 Point your Twilio number webhook to: https://YOUR_DOMAIN/incoming-call\n`);
});
