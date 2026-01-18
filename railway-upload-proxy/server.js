/**
 * DentDoc Upload-Proxy für Railway
 * Reiner Stream-Passthrough - kein Parsing, kein Buffer
 */

const fastify = require('fastify')({ logger: true });
const fetch = require('node-fetch');

// 🔑 DAS IST DER MAGISCHE TEIL
fastify.addContentTypeParser(
  'application/octet-stream',
  (request, payload, done) => {
    done(null, payload); // NICHT parsen, nur akzeptieren
  }
);
// ENV
const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY;
const DENTDOC_AUTH_TOKEN = process.env.DENTDOC_AUTH_TOKEN;
const PORT = process.env.PORT || 3000;

if (!ASSEMBLYAI_API_KEY || !DENTDOC_AUTH_TOKEN) {
  console.error('Missing env vars: ASSEMBLYAI_API_KEY or DENTDOC_AUTH_TOKEN');
  process.exit(1);
}

fastify.get('/health', async () => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

fastify.post('/upload', async (request, reply) => {
  // Auth
  const authHeader = request.headers.authorization;
  if (authHeader !== `Bearer ${DENTDOC_AUTH_TOKEN}`) {
    reply.code(401).send({ error: 'Unauthorized' });
    return;
  }

  console.log('Upload started');

  try {
    const upstream = await fetch('https://api.assemblyai.com/v2/upload', {
      method: 'POST',
      headers: {
        authorization: ASSEMBLYAI_API_KEY,
        'content-type': 'application/octet-stream'
      },
      body: request.raw, // DAS IST DER STREAM - kein Buffer!
      duplex: 'half'
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      console.error('AssemblyAI error:', upstream.status, text);
      reply.code(502).send({ error: 'AssemblyAI upload failed', details: text });
      return;
    }

    const json = await upstream.json();
    console.log('Upload successful');
    reply.send(json);

  } catch (err) {
    console.error('Upload error:', err.message);
    reply.code(500).send({ error: 'Upload failed', message: err.message });
  }
});

fastify.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
  console.log(`DentDoc Upload-Proxy running on port ${PORT}`);
});
