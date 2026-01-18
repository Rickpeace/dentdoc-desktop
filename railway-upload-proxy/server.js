/**
 * DentDoc Upload-Proxy für Railway
 *
 * WICHTIG: Dies ist ein reiner Stream-Proxy!
 * - Audio wird NICHT gespeichert
 * - Audio wird NICHT geloggt
 * - Audio wird direkt zu AssemblyAI gestreamt
 * - AssemblyAI API-Key bleibt hier (nicht im Desktop)
 *
 * Architektur:
 * Desktop-App → Railway (dieser Service) → AssemblyAI
 *                    ↓
 *              Stream-through (kein Speichern)
 */

const fastify = require('fastify')({
  logger: {
    level: 'info',
    // Keine Request-Bodies loggen (DSGVO)
    serializers: {
      req(req) {
        return {
          method: req.method,
          url: req.url,
          // Keine Headers loggen (enthält Auth-Token)
        };
      }
    }
  },
  // Wichtig: Kein Body-Parsing, wir streamen roh
  bodyLimit: 1024 * 1024 * 500 // 500MB max (AssemblyAI erlaubt bis 5GB)
});

// Content-Type Parser für application/octet-stream - gibt raw Buffer zurück
fastify.addContentTypeParser('application/octet-stream', function (request, payload, done) {
  // Wir sammeln die Chunks in einen Buffer
  const chunks = [];
  payload.on('data', chunk => chunks.push(chunk));
  payload.on('end', () => {
    done(null, Buffer.concat(chunks));
  });
  payload.on('error', done);
});

// Environment Variables
const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY;
const DENTDOC_AUTH_TOKEN = process.env.DENTDOC_AUTH_TOKEN;
const PORT = process.env.PORT || 3000;

// Startup-Check
if (!ASSEMBLYAI_API_KEY) {
  console.error('❌ ASSEMBLYAI_API_KEY nicht gesetzt!');
  process.exit(1);
}

if (!DENTDOC_AUTH_TOKEN) {
  console.error('❌ DENTDOC_AUTH_TOKEN nicht gesetzt!');
  process.exit(1);
}

/**
 * Health-Check Endpoint
 */
fastify.get('/health', async () => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

/**
 * Upload-Proxy Endpoint
 *
 * Nimmt Audio-Stream vom Desktop entgegen und leitet ihn
 * direkt zu AssemblyAI weiter (kein Zwischenspeichern).
 */
fastify.post('/upload', {
  // Raw body handling für Streaming
  config: {
    rawBody: true
  }
}, async (request, reply) => {

  // 1. Auth-Check
  const authHeader = request.headers['authorization'];
  if (!authHeader || authHeader !== `Bearer ${DENTDOC_AUTH_TOKEN}`) {
    reply.code(401);
    return { error: 'Unauthorized' };
  }

  // 2. Content-Type Check
  const contentType = request.headers['content-type'];
  if (!contentType || !contentType.includes('application/octet-stream')) {
    reply.code(400);
    return { error: 'Content-Type must be application/octet-stream' };
  }

  // 3. Body ist jetzt ein Buffer (durch unseren Content-Type Parser)
  const audioBuffer = request.body;

  if (!audioBuffer || audioBuffer.length === 0) {
    reply.code(400);
    return { error: 'Empty request body' };
  }

  console.log(`Upload received: ${(audioBuffer.length / 1024 / 1024).toFixed(2)} MB`);

  try {
    // 4. Buffer zu AssemblyAI weiterleiten
    const assemblyResponse = await fetch('https://api.assemblyai.com/v2/upload', {
      method: 'POST',
      headers: {
        'Authorization': ASSEMBLYAI_API_KEY,
        'Content-Type': 'application/octet-stream',
        'Content-Length': audioBuffer.length.toString()
      },
      body: audioBuffer
    });

    // 5. AssemblyAI Response parsen
    if (!assemblyResponse.ok) {
      const errorText = await assemblyResponse.text();
      console.error('AssemblyAI error:', assemblyResponse.status, errorText);

      reply.code(assemblyResponse.status);
      return {
        error: 'AssemblyAI upload failed',
        status: assemblyResponse.status,
        details: errorText
      };
    }

    const result = await assemblyResponse.json();

    // 6. upload_url zurückgeben (das einzige was wir brauchen)
    return { upload_url: result.upload_url };

  } catch (error) {
    console.error('Upload proxy error:', error.message);

    reply.code(500);
    return {
      error: 'Upload failed',
      message: error.message
    };
  }
});

// Server starten
const start = async () => {
  try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`🚀 DentDoc Upload-Proxy läuft auf Port ${PORT}`);
    console.log(`📡 AssemblyAI API-Key: ${ASSEMBLYAI_API_KEY ? '✓ gesetzt' : '✗ fehlt'}`);
    console.log(`🔐 Auth-Token: ${DENTDOC_AUTH_TOKEN ? '✓ gesetzt' : '✗ fehlt'}`);
  } catch (err) {
    console.error('Startup error:', err);
    process.exit(1);
  }
};

start();
