/**
 * DentDoc Audio Relay
 *
 * WebSocket relay server for iPhone microphone streaming.
 *
 * Architecture:
 * - iPhone connects with: ?device={iphoneDeviceId}&role=iphone&token={iphoneToken}
 * - Desktop connects with: ?device={iphoneDeviceId}&role=desktop&token={desktopToken}
 * - Relay forwards messages bidirectionally
 *
 * IMPORTANT: This is a PURE RELAY
 * - NO audio buffering
 * - NO VAD processing
 * - NO WAV file creation
 * - Just WebSocket message forwarding
 */

const Fastify = require('fastify');
const websocket = require('@fastify/websocket');

const fastify = Fastify({ logger: true });

// Environment
const PORT = process.env.PORT || 3001;
const DENTDOC_API_URL = process.env.DENTDOC_API_URL || 'https://dentdoc-app.vercel.app';

// Connection registry: Map<iphoneDeviceId, { iphone: WebSocket, desktop: WebSocket }>
const connections = new Map();

// Register WebSocket plugin
fastify.register(websocket);

// Health check endpoint
fastify.get('/health', async (request, reply) => {
  return {
    status: 'ok',
    connections: connections.size,
    uptime: process.uptime()
  };
});

// WebSocket endpoint
fastify.register(async function (fastify) {
  fastify.get('/stream', { websocket: true }, (socket, request) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const deviceId = url.searchParams.get('device');
    const role = url.searchParams.get('role'); // 'iphone' or 'desktop'
    const token = url.searchParams.get('token');

    // Validate parameters
    if (!deviceId || !role || !token) {
      fastify.log.warn('Missing parameters: device=%s, role=%s, token=%s', deviceId, role, !!token);
      socket.close(4000, 'Missing required parameters: device, role, token');
      return;
    }

    if (role !== 'iphone' && role !== 'desktop') {
      socket.close(4001, 'Invalid role. Must be "iphone" or "desktop"');
      return;
    }

    // TODO: Validate token against backend API
    // For now, accept any non-empty token
    if (!token || token.length < 10) {
      socket.close(4002, 'Invalid token');
      return;
    }

    fastify.log.info('[%s] %s connected for device %s', role.toUpperCase(), socket.remoteAddress, deviceId);

    // Get or create connection pair
    let pair = connections.get(deviceId);
    if (!pair) {
      pair = { iphone: null, desktop: null };
      connections.set(deviceId, pair);
    }

    // Store socket in pair
    if (role === 'iphone') {
      // Close existing iPhone connection if any
      if (pair.iphone && pair.iphone !== socket) {
        fastify.log.info('[IPHONE] Closing existing connection for device %s', deviceId);
        try {
          if (typeof pair.iphone.close === 'function') {
            pair.iphone.close(4003, 'New iPhone connection');
          } else if (typeof pair.iphone.terminate === 'function') {
            pair.iphone.terminate();
          }
        } catch (e) {
          fastify.log.warn('[IPHONE] Error closing old connection: %s', e.message);
        }
      }
      pair.iphone = socket;

      // Notify desktop that iPhone connected
      if (pair.desktop && pair.desktop.readyState === 1) {
        pair.desktop.send(JSON.stringify({ type: 'IPHONE_CONNECTED' }));
      }
    } else {
      // Close existing Desktop connection if any
      if (pair.desktop && pair.desktop !== socket) {
        fastify.log.info('[DESKTOP] Closing existing connection for device %s', deviceId);
        try {
          if (typeof pair.desktop.close === 'function') {
            pair.desktop.close(4003, 'New Desktop connection');
          } else if (typeof pair.desktop.terminate === 'function') {
            pair.desktop.terminate();
          }
        } catch (e) {
          fastify.log.warn('[DESKTOP] Error closing old connection: %s', e.message);
        }
      }
      pair.desktop = socket;

      // If iPhone is already connected, notify desktop
      if (pair.iphone && pair.iphone.readyState === 1) {
        socket.send(JSON.stringify({ type: 'IPHONE_CONNECTED' }));
      }
    }

    // Handle incoming messages
    socket.on('message', (data, isBinary) => {
      const partner = role === 'iphone' ? pair.desktop : pair.iphone;

      if (!partner || partner.readyState !== 1) {
        // Partner not connected, drop message silently
        return;
      }

      if (isBinary) {
        // Binary data (PCM audio from iPhone) - forward as-is
        partner.send(data, { binary: true });
      } else {
        // Text/JSON message - parse and forward
        try {
          const msg = JSON.parse(data.toString());
          fastify.log.info('[%s → %s] %s', role.toUpperCase(), role === 'iphone' ? 'DESKTOP' : 'IPHONE', msg.type);
          partner.send(data.toString());
        } catch (e) {
          // Forward as-is if not valid JSON
          partner.send(data.toString());
        }
      }
    });

    // Handle connection close
    socket.on('close', (code, reason) => {
      fastify.log.info('[%s] Disconnected (code=%d, reason=%s)', role.toUpperCase(), code, reason?.toString() || 'none');

      // Remove from pair
      if (role === 'iphone' && pair.iphone === socket) {
        pair.iphone = null;
        // Notify desktop
        if (pair.desktop && pair.desktop.readyState === 1) {
          pair.desktop.send(JSON.stringify({ type: 'IPHONE_DISCONNECTED' }));
        }
      } else if (role === 'desktop' && pair.desktop === socket) {
        pair.desktop = null;
        // Notify iPhone
        if (pair.iphone && pair.iphone.readyState === 1) {
          pair.iphone.send(JSON.stringify({ type: 'DESKTOP_DISCONNECTED' }));
        }
      }

      // Clean up empty pairs
      if (!pair.iphone && !pair.desktop) {
        connections.delete(deviceId);
        fastify.log.info('Cleaned up empty pair for device %s', deviceId);
      }
    });

    // Handle errors
    socket.on('error', (error) => {
      fastify.log.error('[%s] WebSocket error: %s', role.toUpperCase(), error.message);
    });
  });
});

// Start server
const start = async () => {
  try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    fastify.log.info(`DentDoc Audio Relay running on port ${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
