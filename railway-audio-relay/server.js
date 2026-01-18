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
 *
 * NOTE: @fastify/websocket passes a connection object, not raw WebSocket.
 * Always use connection.socket to get the actual WebSocket instance.
 */

const Fastify = require('fastify');
const websocket = require('@fastify/websocket');

const fastify = Fastify({ logger: true });

// Environment
const PORT = process.env.PORT || 3001;
const DENTDOC_API_URL = process.env.DENTDOC_API_URL || 'https://dentdoc-app.vercel.app';

// Connection registry: Map<iphoneDeviceId, { iphone: WebSocket, desktop: WebSocket, deviceId: string }>
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

// Status check endpoint - check if iPhone is connected for a device
// Used by Desktop to test iPhone connection without opening WebSocket
fastify.get('/status/:deviceId', async (request, reply) => {
  const { deviceId } = request.params;
  const token = request.headers.authorization?.replace('Bearer ', '');

  // Basic token validation
  if (!token || token.length < 10) {
    return reply.code(401).send({ error: 'Invalid or missing token' });
  }

  const pair = connections.get(deviceId);

  if (!pair) {
    return {
      deviceId,
      iphoneConnected: false,
      desktopConnected: false
    };
  }

  return {
    deviceId,
    iphoneConnected: pair.iphone && pair.iphone.readyState === 1,
    desktopConnected: pair.desktop && pair.desktop.readyState === 1
  };
});

/**
 * Safely close a WebSocket - handles all implementations
 * Works with: ws, @fastify/websocket, Node streams
 */
function safeClose(socket, code = 4003, reason = 'Connection replaced') {
  if (!socket) return;

  try {
    // Check if socket is still open (readyState 1 = OPEN)
    if (socket.readyState === 1) {
      socket.close(code, reason);
      return;
    }
  } catch (_) {
    // close() failed, try terminate()
  }

  try {
    if (typeof socket.terminate === 'function') {
      socket.terminate();
      return;
    }
  } catch (_) {
    // terminate() failed, try destroy()
  }

  try {
    if (typeof socket.destroy === 'function') {
      socket.destroy();
    }
  } catch (_) {
    // All methods failed, socket is probably already dead
  }
}

/**
 * Get or create a connection pair for a device
 */
function getOrCreatePair(deviceId) {
  let pair = connections.get(deviceId);
  if (!pair) {
    pair = { iphone: null, desktop: null, deviceId };
    connections.set(deviceId, pair);
  }
  return pair;
}

/**
 * Replace a socket in a pair, safely closing the old one
 */
function replaceSocket(pair, role, newSocket) {
  const oldSocket = pair[role];

  if (oldSocket && oldSocket !== newSocket) {
    fastify.log.info('[%s] Closing existing connection for device %s', role.toUpperCase(), pair.deviceId);
    safeClose(oldSocket, 4003, 'New connection');
  }

  pair[role] = newSocket;
}

/**
 * Clean up when a socket disconnects
 */
function cleanupSocket(pair, role, socket) {
  // Only clean up if this socket is still the active one
  if (pair[role] === socket) {
    pair[role] = null;

    // Notify partner
    const partnerRole = role === 'iphone' ? 'desktop' : 'iphone';
    const partner = pair[partnerRole];
    const notifyType = role === 'iphone' ? 'IPHONE_DISCONNECTED' : 'DESKTOP_DISCONNECTED';

    if (partner && partner.readyState === 1) {
      try {
        partner.send(JSON.stringify({ type: notifyType }));
      } catch (e) {
        fastify.log.warn('Failed to notify partner: %s', e.message);
      }
    }
  }

  // Clean up empty pairs
  if (!pair.iphone && !pair.desktop) {
    connections.delete(pair.deviceId);
    fastify.log.info('Cleaned up empty pair for device %s', pair.deviceId);
  }
}

// WebSocket endpoint
fastify.register(async function (fastify) {
  fastify.get('/stream', { websocket: true }, (connection, request) => {
    // IMPORTANT: Extract the actual WebSocket from the connection object
    // @fastify/websocket wraps the socket - we need the real one
    const socket = connection.socket || connection;

    const url = new URL(request.url, `http://${request.headers.host}`);
    const deviceId = url.searchParams.get('device');
    const role = url.searchParams.get('role'); // 'iphone' or 'desktop'
    const token = url.searchParams.get('token');

    // Validate parameters
    if (!deviceId || !role || !token) {
      fastify.log.warn('Missing parameters: device=%s, role=%s, token=%s', deviceId, role, !!token);
      safeClose(socket, 4000, 'Missing required parameters');
      return;
    }

    if (role !== 'iphone' && role !== 'desktop') {
      safeClose(socket, 4001, 'Invalid role');
      return;
    }

    // Basic token validation (length check)
    if (!token || token.length < 10) {
      safeClose(socket, 4002, 'Invalid token');
      return;
    }

    fastify.log.info('[%s] Connected for device %s', role.toUpperCase(), deviceId);

    // Get or create connection pair
    const pair = getOrCreatePair(deviceId);

    // Store socket in pair (closes old connection if exists)
    replaceSocket(pair, role, socket);

    // Notify about connection
    if (role === 'iphone') {
      // Notify desktop that iPhone connected
      if (pair.desktop && pair.desktop.readyState === 1) {
        try {
          pair.desktop.send(JSON.stringify({ type: 'IPHONE_CONNECTED' }));
        } catch (e) {
          fastify.log.warn('Failed to notify desktop: %s', e.message);
        }
      }
    } else {
      // If iPhone is already connected, notify desktop
      if (pair.iphone && pair.iphone.readyState === 1) {
        try {
          socket.send(JSON.stringify({ type: 'IPHONE_CONNECTED' }));
        } catch (e) {
          fastify.log.warn('Failed to send IPHONE_CONNECTED: %s', e.message);
        }
      }
    }

    // Handle incoming messages
    socket.on('message', (data, isBinary) => {
      const partner = role === 'iphone' ? pair.desktop : pair.iphone;

      try {
        if (isBinary) {
          // Binary data (PCM audio from iPhone) - forward as-is
          if (partner && partner.readyState === 1) {
            partner.send(data, { binary: true });
          }
        } else {
          // Text/JSON message - parse and check for PING
          let msg;
          try {
            msg = JSON.parse(data.toString());
          } catch (_) {
            // Not JSON, forward anyway
            if (partner && partner.readyState === 1) {
              partner.send(data.toString());
            }
            return;
          }

          // Handle PING - respond with PONG (keep-alive)
          if (msg.type === 'PING') {
            try {
              socket.send(JSON.stringify({ type: 'PONG' }));
            } catch (e) {
              fastify.log.warn('Failed to send PONG: %s', e.message);
            }
            return; // Don't forward PING to partner
          }

          // Log and forward other messages
          fastify.log.info('[%s → %s] %s', role.toUpperCase(), role === 'iphone' ? 'DESKTOP' : 'IPHONE', msg.type);
          if (partner && partner.readyState === 1) {
            partner.send(data.toString());
          }
        }
      } catch (e) {
        fastify.log.warn('Failed to forward message: %s', e.message);
      }
    });

    // Handle connection close
    socket.on('close', (code, reason) => {
      fastify.log.info('[%s] Disconnected (code=%d, reason=%s)', role.toUpperCase(), code, reason?.toString() || 'none');
      cleanupSocket(pair, role, socket);
    });

    // Handle errors (important for stability)
    socket.on('error', (error) => {
      fastify.log.warn('[%s] Socket error: %s', role.toUpperCase(), error.message);
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
