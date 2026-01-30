# Voice Bridge Server

WebSocket bridge between Twilio Media Streams and ElevenLabs Conversational AI.

## Why External Server?

Serverless functions (Supabase Edge Functions, Vercel, etc.) have execution time limits (~100-150 seconds) that cause WebSocket connections to drop mid-call. This standalone server has no such limits.

## Deploy to Fly.io

### 1. Install Fly CLI
```bash
curl -L https://fly.io/install.sh | sh
fly auth login
```

### 2. Create app
```bash
fly launch --no-deploy
# Choose a name like "your-company-voice-bridge"
```

### 3. Set secrets
```bash
fly secrets set ELEVENLABS_API_KEY=your_key_here
fly secrets set ELEVENLABS_AGENT_ID=your_agent_id_here
fly secrets set SUPABASE_URL=https://tyxyqatcrvzroufravap.supabase.co
fly secrets set SUPABASE_SERVICE_ROLE_KEY=your_service_key_here
```

### 4. Deploy
```bash
fly deploy
```

### 5. Get your URL
Your WebSocket URL will be: `wss://your-app-name.fly.dev/stream`

## Deploy to Railway

1. Push this folder to a new GitHub repo
2. Connect Railway to your repo
3. Add environment variables in Railway dashboard
4. Deploy - Railway will auto-detect the Dockerfile
5. Your URL: `wss://your-app.up.railway.app/stream`

## Deploy to Render

1. Push to GitHub
2. Create new "Web Service" in Render
3. Set environment variables
4. Your URL: `wss://your-app.onrender.com/stream`

## Update Twilio

After deploying, update your Lovable app's `handle-voice-call` function to use the external URL:

```typescript
const voiceStreamWsUrl = "wss://your-app-name.fly.dev/stream";
```

## Health Check

GET `https://your-app.fly.dev/health` should return "OK"

## Monitoring

```bash
fly logs -a your-app-name
```
