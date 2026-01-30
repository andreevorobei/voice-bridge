/**
 * External WebSocket Bridge: Twilio Media Streams ⇄ ElevenLabs Conversational AI
 * 
 * Deploy this to Fly.io / Railway / Render / Cloud Run for stable 5+ minute calls.
 * 
 * Environment variables required:
 * - ELEVENLABS_API_KEY
 * - ELEVENLABS_AGENT_ID
 * - SUPABASE_URL
 * - SUPABASE_SERVICE_ROLE_KEY
 * - PORT (optional, defaults to 8080)
 */

import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { createClient } from '@supabase/supabase-js';

const PORT = parseInt(process.env.PORT || '8080', 10);

// --- Audio helpers ---
const TWILIO_ULAW_FRAME_BYTES = 160;
const ULAW_SILENCE_BYTE = 0xff;

const ULAW_DECODE_TABLE = new Int16Array([
  -32124, -31100, -30076, -29052, -28028, -27004, -25980, -24956,
  -23932, -22908, -21884, -20860, -19836, -18812, -17788, -16764,
  -15996, -15484, -14972, -14460, -13948, -13436, -12924, -12412,
  -11900, -11388, -10876, -10364, -9852, -9340, -8828, -8316,
  -7932, -7676, -7420, -7164, -6908, -6652, -6396, -6140,
  -5884, -5628, -5372, -5116, -4860, -4604, -4348, -4092,
  -3900, -3772, -3644, -3516, -3388, -3260, -3132, -3004,
  -2876, -2748, -2620, -2492, -2364, -2236, -2108, -1980,
  -1884, -1820, -1756, -1692, -1628, -1564, -1500, -1436,
  -1372, -1308, -1244, -1180, -1116, -1052, -988, -924,
  -876, -844, -812, -780, -748, -716, -684, -652,
  -620, -588, -556, -524, -492, -460, -428, -396,
  -372, -356, -340, -324, -308, -292, -276, -260,
  -244, -228, -212, -196, -180, -164, -148, -132,
  -120, -112, -104, -96, -88, -80, -72, -64,
  -56, -48, -40, -32, -24, -16, -8, 0,
  32124, 31100, 30076, 29052, 28028, 27004, 25980, 24956,
  23932, 22908, 21884, 20860, 19836, 18812, 17788, 16764,
  15996, 15484, 14972, 14460, 13948, 13436, 12924, 12412,
  11900, 11388, 10876, 10364, 9852, 9340, 8828, 8316,
  7932, 7676, 7420, 7164, 6908, 6652, 6396, 6140,
  5884, 5628, 5372, 5116, 4860, 4604, 4348, 4092,
  3900, 3772, 3644, 3516, 3388, 3260, 3132, 3004,
  2876, 2748, 2620, 2492, 2364, 2236, 2108, 1980,
  1884, 1820, 1756, 1692, 1628, 1564, 1500, 1436,
  1372, 1308, 1244, 1180, 1116, 1052, 988, 924,
  876, 844, 812, 780, 748, 716, 684, 652,
  620, 588, 556, 524, 492, 460, 428, 396,
  372, 356, 340, 324, 308, 292, 276, 260,
  244, 228, 212, 196, 180, 164, 148, 132,
  120, 112, 104, 96, 88, 80, 72, 64,
  56, 48, 40, 32, 24, 16, 8, 0,
]);

const MU_LAW_CLIP = 32635;
const MU_LAW_BIAS = 0x84;

function muLawEncode(pcm16: number): number {
  let sample = pcm16;
  let sign = 0;
  if (sample < 0) {
    sign = 0x80;
    sample = -sample;
  }
  if (sample > MU_LAW_CLIP) sample = MU_LAW_CLIP;
  sample += MU_LAW_BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

function ulawBytesToPcm16(bytes: Buffer): Int16Array {
  const out = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = ULAW_DECODE_TABLE[bytes[i]];
  return out;
}

function pcm16ToUlawBytes(pcm: Int16Array): Buffer {
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = muLawEncode(pcm[i]);
  return out;
}

function upsample2x(input: Int16Array): Int16Array {
  const out = new Int16Array(input.length * 2);
  for (let i = 0; i < input.length - 1; i++) {
    out[i * 2] = input[i];
    out[i * 2 + 1] = Math.round((input[i] + input[i + 1]) / 2);
  }
  if (input.length > 0) {
    const last = input.length - 1;
    out[last * 2] = input[last];
    out[last * 2 + 1] = input[last];
  }
  return out;
}

function downsample2x(input: Int16Array): Int16Array {
  const out = new Int16Array(Math.floor(input.length / 2));
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.round((input[i * 2] + input[i * 2 + 1]) / 2);
  }
  return out;
}

function pcm16ToBytesLE(pcm: Int16Array): Buffer {
  const out = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) {
    out.writeInt16LE(pcm[i], i * 2);
  }
  return out;
}

function bytesToPcm16LE(bytes: Buffer): Int16Array {
  const len = Math.floor(bytes.length / 2);
  const out = new Int16Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = bytes.readInt16LE(i * 2);
  }
  return out;
}

// --- ElevenLabs signed URL ---
async function getElevenLabsSignedUrl(apiKey: string, agentId: string): Promise<string> {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${agentId}`,
    { headers: { 'xi-api-key': apiKey } }
  );
  if (!res.ok) throw new Error(`ElevenLabs signed URL failed: ${res.status}`);
  const body = await res.json();
  if (!body.signed_url) throw new Error('No signed_url returned');
  return body.signed_url;
}

// --- Tenant data ---
interface TenantData {
  id: string;
  company: string | null;
  name: string;
  ai_voice_first_message: string | null;
  ai_voice_personality: string | null;
  ai_voice_company_info: string | null;
  ai_voice_tone: string | null;
  ai_voice_goals: string | null;
  ai_voice_icp: string | null;
}

async function loadTenant(tenantId: string): Promise<TenantData | null> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey || !tenantId) return null;

  const supabase = createClient(supabaseUrl, supabaseKey);
  const { data, error } = await supabase
    .from('tenants')
    .select('id, company, name, ai_voice_first_message, ai_voice_personality, ai_voice_company_info, ai_voice_tone, ai_voice_goals, ai_voice_icp')
    .eq('id', tenantId)
    .single();

  if (error || !data) {
    console.error('[loadTenant] Error:', error);
    return null;
  }
  return data as TenantData;
}

function buildPrompt(tenant: TenantData | null): { prompt: string; firstMessage: string } {
  const companyName = tenant?.company || tenant?.name || 'our company';
  const sections: string[] = [];

  if (tenant?.ai_voice_personality) {
    sections.push(`# Personality\n${tenant.ai_voice_personality}`);
  } else {
    sections.push(`# Personality\nYou are a friendly and professional representative for ${companyName}.`);
  }
  if (tenant?.ai_voice_company_info) {
    sections.push(`# Company & Services\n${tenant.ai_voice_company_info}`);
  }
  if (tenant?.ai_voice_tone) {
    sections.push(`# Tone & Communication Style\n${tenant.ai_voice_tone}`);
  }
  if (tenant?.ai_voice_goals) {
    sections.push(`# Goals\n${tenant.ai_voice_goals}`);
  }
  if (tenant?.ai_voice_icp) {
    sections.push(`# Who You're Talking To\n${tenant.ai_voice_icp}`);
  }

  return {
    prompt: sections.join('\n\n'),
    firstMessage: tenant?.ai_voice_first_message || `Hello! Thank you for calling ${companyName}. How can I help you today?`,
  };
}

// --- Main server ---
const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200);
    res.end('OK');
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

const wss = new WebSocketServer({ server, path: '/stream' });

wss.on('connection', (twilioWs) => {
  console.log('[bridge] Twilio connected');

  let streamSid: string | null = null;
  let elevenWs: WebSocket | null = null;
  let closing = false;
  let tenant: TenantData | null = null;

  const closeBoth = (reason: string) => {
    if (closing) return;
    closing = true;
    console.log(`[bridge] Closing: ${reason}`);
    try { twilioWs.close(); } catch {}
    try { elevenWs?.close(); } catch {}
  };

  const connectElevenLabs = async () => {
    const apiKey = process.env.ELEVENLABS_API_KEY!;
    const agentId = process.env.ELEVENLABS_AGENT_ID!;
    const signedUrl = await getElevenLabsSignedUrl(apiKey, agentId);

    elevenWs = new WebSocket(signedUrl);

    elevenWs.on('open', () => {
      console.log('[bridge] ElevenLabs connected');
      const { prompt, firstMessage } = buildPrompt(tenant);
      elevenWs!.send(JSON.stringify({
        type: 'conversation_initiation_client_data',
        conversation_config_override: {
          agent: { prompt: { prompt }, first_message: firstMessage },
        },
      }));
    });

    elevenWs.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'ping') {
          const eventId = msg.ping_event?.event_id;
          if (eventId) elevenWs?.send(JSON.stringify({ type: 'pong', event_id: eventId }));
          return;
        }

        if (msg.type === 'audio') {
          const payloadB64 = msg.audio_event?.audio_base_64 || msg.audio_event?.audio_base64;
          if (!payloadB64 || !streamSid) return;

          // ElevenLabs sends PCM16 @ 16kHz, convert to μ-law @ 8kHz
          const pcmBytes = Buffer.from(payloadB64, 'base64');
          const pcm16k = bytesToPcm16LE(pcmBytes);
          const pcm8k = downsample2x(pcm16k);
          const ulaw = pcm16ToUlawBytes(pcm8k);

          // Send as 20ms frames
          for (let i = 0; i < ulaw.length; i += TWILIO_ULAW_FRAME_BYTES) {
            let frame = ulaw.subarray(i, i + TWILIO_ULAW_FRAME_BYTES);
            if (frame.length < TWILIO_ULAW_FRAME_BYTES) {
              const padded = Buffer.alloc(TWILIO_ULAW_FRAME_BYTES, ULAW_SILENCE_BYTE);
              frame.copy(padded);
              frame = padded;
            }
            twilioWs.send(JSON.stringify({
              event: 'media',
              streamSid,
              media: { payload: frame.toString('base64') },
            }));
          }
        }

        if (msg.type === 'interruption' && streamSid) {
          twilioWs.send(JSON.stringify({ event: 'clear', streamSid }));
        }
      } catch (e) {
        console.error('[bridge] ElevenLabs message error:', e);
      }
    });

    elevenWs.on('error', (err) => {
      console.error('[bridge] ElevenLabs error:', err);
      closeBoth('elevenlabs_error');
    });

    elevenWs.on('close', () => closeBoth('elevenlabs_closed'));
  };

  twilioWs.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.event === 'start') {
        streamSid = msg.start?.streamSid || null;
        const custom = msg.start?.customParameters || {};
        const tenantId = custom.tenantId || '';
        console.log(`[bridge] Stream start: ${streamSid}, tenant: ${tenantId}`);

        tenant = await loadTenant(tenantId);
        await connectElevenLabs();
      }

      if (msg.event === 'media' && elevenWs?.readyState === WebSocket.OPEN) {
        const payload = msg.media?.payload;
        if (!payload) return;

        // Twilio sends μ-law @ 8kHz, convert to PCM16 @ 16kHz for ElevenLabs
        const ulaw = Buffer.from(payload, 'base64');
        const pcm8k = ulawBytesToPcm16(ulaw);
        const pcm16k = upsample2x(pcm8k);
        const pcmBytes = pcm16ToBytesLE(pcm16k);

        elevenWs.send(JSON.stringify({ user_audio_chunk: pcmBytes.toString('base64') }));
      }

      if (msg.event === 'stop') {
        closeBoth('twilio_stop');
      }
    } catch (e) {
      console.error('[bridge] Twilio message error:', e);
    }
  });

  twilioWs.on('error', (err) => {
    console.error('[bridge] Twilio error:', err);
    closeBoth('twilio_error');
  });

  twilioWs.on('close', () => closeBoth('twilio_closed'));
});

server.listen(PORT, () => {
  console.log(`[bridge] Server listening on port ${PORT}`);
});
