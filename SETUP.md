# 🏠 Real Estate AI Phone Qualification Bot
### Complete Setup Guide

---

## What This Does

When someone calls your agency's phone number:
1. AI answers instantly with a warm greeting
2. Conducts a natural voice qualification conversation
3. Asks about budget, location, timeline, property type, motivation
4. On qualification complete → **simultaneously fires**:
   - 📱 SMS to rep's mobile
   - 📧 Email with formatted lead card + call-now button
   - 💬 Slack message with interactive buttons
   - 💬 WhatsApp message to rep

---

## Services You Need (All Have Free Tiers)

| Service | Purpose | Cost | Sign Up |
|---------|---------|------|---------|
| **Twilio** | Phone number + SMS/WhatsApp | ~£1/mo for number + per-minute | twilio.com |
| **Deepgram** | Speech-to-text on phone calls | 45hrs free/month | console.deepgram.com |
| **Anthropic** | AI qualification brain | Pay per use (~£0.01/call) | console.anthropic.com |
| **ElevenLabs** | Natural voice TTS | 10k chars free/month | elevenlabs.io |
| **SendGrid** | Email notifications | 100 emails/day free | sendgrid.com |
| **Render/Railway** | Server hosting | Free tier available | render.com |

---

## Step 1 — Install & Configure

```bash
# Clone / unzip the project
cd realestate-voice-bot

# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Edit .env with your API keys
nano .env   # or open in VS Code
```

---

## Step 2 — Get Your API Keys

### Twilio
1. Go to [console.twilio.com](https://console.twilio.com)
2. Copy **Account SID** and **Auth Token** from the dashboard
3. Buy a phone number: Phone Numbers → Manage → Buy a Number
   - Search for a UK number (+44) with Voice capability
   - Copy the number into `.env` as `TWILIO_PHONE_NUMBER`
4. For WhatsApp: Messaging → Try it out → WhatsApp sandbox

### Deepgram
1. Go to [console.deepgram.com](https://console.deepgram.com)
2. Create API Key → copy into `.env`

### Anthropic
1. Go to [console.anthropic.com](https://console.anthropic.com)
2. API Keys → Create Key → copy into `.env`

### ElevenLabs
1. Go to [elevenlabs.io](https://elevenlabs.io)
2. Profile → API Key → copy into `.env`
3. Go to Voice Library, pick a voice, copy the Voice ID into `.env`
   - Recommended: **Rachel** (`21m00Tcm4TlvDq8ikWAM`) — professional, warm
   - Or **Bella** (`EXAVITQu4vr4xnSDxMaL`) — friendly, energetic

### SendGrid
1. Go to [sendgrid.com](https://sendgrid.com) → Sign up free
2. Settings → API Keys → Create API Key (Full Access)
3. Verify your sender email in Sender Authentication

### Slack
1. Go to [api.slack.com/apps](https://api.slack.com/apps) → Create New App
2. Incoming Webhooks → Activate → Add New Webhook to Workspace
3. Choose your #leads channel → Copy the webhook URL

---

## Step 3 — Deploy the Server

### Option A: Local Testing with ngrok (fastest to start)
```bash
# Terminal 1 — start the server
npm run dev

# Terminal 2 — expose to internet
npx ngrok http 3000

# Copy the https URL from ngrok, e.g.:
# https://abc123.ngrok.io
```

### Option B: Deploy to Render (recommended for production)
1. Push your code to GitHub
2. Go to [render.com](https://render.com) → New Web Service
3. Connect your GitHub repo
4. Set Environment Variables (copy from your `.env`)
5. Deploy → copy your `https://your-app.onrender.com` URL

### Option C: Deploy to Railway
```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

---

## Step 4 — Connect Twilio to Your Server

1. Go to [Twilio Console](https://console.twilio.com) → Phone Numbers
2. Click your phone number
3. Under **Voice & Fax** → **A Call Comes In**:
   - Set to **Webhook**
   - URL: `https://YOUR_DOMAIN/incoming-call`
   - Method: **HTTP POST**
4. Under **Call Status Changes**:
   - URL: `https://YOUR_DOMAIN/call-status`
   - Method: **HTTP POST**
5. Click **Save**

---

## Step 5 — Test It

```bash
# Check server health
curl https://YOUR_DOMAIN/health

# Then call your Twilio number from your mobile!
```

The AI will answer, qualify you, then send notifications to all channels.

---

## Customising the AI

Open `src/server.js` and find `SYSTEM_PROMPT`. You can:
- Change the agency name
- Add/remove qualification questions
- Adjust the scoring criteria (Hot/Warm/Cold)
- Change the language/tone

---

## Routing Calls to Multiple Reps

To send to multiple reps, change the `.env` to comma-separated values and update the notification functions:

```
REP_EMAIL=alice@agency.com,bob@agency.com
REP_PHONE=+447700900001,+447700900002
```

Or add round-robin logic in `notifyAllChannels()` to rotate reps.

---

## Cost Estimate (Per Call)

| Service | ~Cost per 5-min call |
|---------|---------------------|
| Twilio (inbound) | £0.013/min = £0.065 |
| Deepgram STT | $0.0043/min = ~£0.02 |
| Claude AI | ~£0.005 |
| ElevenLabs TTS | ~£0.01 |
| **Total** | **~£0.10 per qualified call** |

---

## Troubleshooting

**"No audio" on calls:** Check Deepgram API key and encoding settings (mulaw, 8000hz)

**AI not responding:** Check Anthropic API key and server logs (`npm run dev`)

**Notifications not sending:** Check each API key in `.env`, look for errors in console

**Twilio not connecting:** Ensure your server URL is publicly accessible (ngrok or deployed)

**WebSocket errors:** Twilio Media Streams requires WSS (secure WebSocket) — use ngrok or HTTPS hosting

---

## Support

For issues, check logs with `npm run dev` and look for emoji prefixes:
- 📞 Incoming call received
- 🎙️ Stream started
- 🎤 Deepgram connected
- 👤 Caller speech transcribed
- 🔊 AI speaking
- ✅ Lead qualified + notifications sent
