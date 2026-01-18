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
    serializers: {
      req(req) {
        return {
          method: req.method,
          url: req.url,
        };
      }
    }
  }
});

// Environment Variables
const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY;
const DENTDOC_AUTH_TOKEN = process.env.DENTDOC_AUTH_TOKEN;
const PORT = process.env.PORT || 3000;

// Startup-Check
if (!ASSEMBLYAI_API_KEY) {
  console.error('ASSEMBLYAI_API_KEY nicht gesetzt!');
  process.exit(1);
}

if (!DENTDOC_AUTH_TOKEN) {
  console.error('DENTDOC_AUTH_TOKEN nicht gesetzt!');
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
 * KEIN Body-Parser! req.raw ist der Stream.
 */
fastify.post('/upload', async (request, reply) => {

  // 1. Auth-Check
  const authHeader = request.headers['authorization'];
  if (!authHeader || authHeader !== `Bearer ${DENTDOC_AUTH_TOKEN}`) {
    reply.code(401);
    return { error: 'Unauthorized' };
  }

  // 2. Content-Length für Logging
  const contentLength = request.headers['content-length'];
  console.log(`Upload started: ${contentLength ? (contentLength / 1024 / 1024).toFixed(2) + ' MB' : 'unknown size'}`);

  try {
    // 3. Stream direkt zu AssemblyAI durchreichen
    // req.raw = echter Node.js IncomingMessage Stream
    // KEIN Buffer, KEIN Body-Parser, KEIN RAM-Verbrauch
    const assemblyResponse = await fetch('https://api.assemblyai.com/v2/upload', {
      method: 'POST',
      headers: {
        'Authorization': ASSEMBLYAI_API_KEY,
        'Transfer-Encoding': 'chunked'
      },
      body: request.raw, // Der echte Stream!
      duplex: 'half'
    });

    // 4. AssemblyAI Response parsen
    if (!assemblyResponse.ok) {
      const errorText = await assemblyResponse.text();
      console.error('AssemblyAI error:', assemblyResponse.status, errorText);
      reply.code(assemblyResponse.status);
      return { error: 'AssemblyAI upload failed', details: errorText };
    }

    const result = await assemblyResponse.json();
    console.log('Upload successful, got upload_url');

    // 5. upload_url zurückgeben
    return { upload_url: result.upload_url };

  } catch (error) {
    console.error('Upload proxy error:', error.message);
    reply.code(500);
    return { error: 'Upload failed', message: error.message };
  }
});

// Server starten
const start = async () => {
  try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`DentDoc Upload-Proxy läuft auf Port ${PORT}`);
  } catch (err) {
    console.error('Startup error:', err);
    process.exit(1);
  }
};

start();
