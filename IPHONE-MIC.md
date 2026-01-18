# iPhone als Mikrofon - Technische Dokumentation

## Übersicht

Das iPhone dient als kabelloses Mikrofon für die DentDoc Desktop-App. Audio wird vom iPhone über einen WebSocket-Relay-Server zum Desktop gestreamt, wo es in eine WAV-Datei geschrieben und dann normal verarbeitet wird (VAD, Upload, Transkription).

**Kernprinzipien:**
- **iPhone = dummes Mikrofon** (kein VAD, kein Upload, kein Account, keine Speicherung)
- **Railway Relay = reines Kabel** (keine Logik, kein Buffer, keine WAV-Erstellung)
- **Desktop = Master** (kontrolliert Start/Stop, schreibt WAV, führt Pipeline aus)
- **Pairing = einmalig** (QR-Code scannen, dann persistente Verbindung)

---

## Architektur

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              PAIRING FLOW                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   Desktop                    Backend (Vercel)              iPhone            │
│   ───────                    ────────────────              ──────            │
│      │                             │                          │              │
│      │  POST /api/iphone/pair/start                          │              │
│      │ ─────────────────────────► │                          │              │
│      │                             │                          │              │
│      │  { pairingId, pairingUrl }  │                          │              │
│      │ ◄───────────────────────── │                          │              │
│      │                             │                          │              │
│      │  [Zeigt QR-Code]            │                          │              │
│      │                             │                          │              │
│      │                             │   Scannt QR → öffnet URL │              │
│      │                             │ ◄──────────────────────── │              │
│      │                             │                          │              │
│      │                             │  POST /api/iphone/pair/confirm          │
│      │                             │ ◄──────────────────────── │              │
│      │                             │                          │              │
│      │                             │  { iphoneDeviceId,       │              │
│      │                             │    iphoneAuthToken,      │              │
│      │                             │    streamUrl }           │              │
│      │                             │ ─────────────────────────►│              │
│      │                             │                          │              │
│      │  [Polling: GET /status]     │                          │              │
│      │ ─────────────────────────► │                          │              │
│      │                             │                          │              │
│      │  { status: 'paired' }       │                          │              │
│      │ ◄───────────────────────── │                          │              │
│      │                             │                          │              │
│      │  [Speichert iphoneDeviceId] │   [Speichert Credentials │              │
│      │                             │    in localStorage]      │              │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                             RECORDING FLOW                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   iPhone                Railway Relay              Desktop                   │
│   ──────                ─────────────              ───────                   │
│      │                       │                        │                      │
│      │  WS Connect           │                        │                      │
│      │  ?device=X&role=iphone&token=Y                 │                      │
│      │ ─────────────────────►│                        │                      │
│      │                       │                        │                      │
│      │                       │   WS Connect           │                      │
│      │                       │   ?device=X&role=desktop&token=Z              │
│      │                       │◄────────────────────── │                      │
│      │                       │                        │                      │
│      │                       │  { IPHONE_CONNECTED }  │                      │
│      │                       │ ──────────────────────►│                      │
│      │                       │                        │                      │
│      │                       │                        │  [User drückt F9]    │
│      │                       │                        │                      │
│      │   { type: 'START' }   │                        │                      │
│      │◄───────────────────── │◄────────────────────── │                      │
│      │                       │                        │                      │
│      │  [Startet AudioWorklet]                        │  [Startet FFmpeg]    │
│      │                       │                        │                      │
│      │   PCM Audio (binary)  │                        │                      │
│      │ ─────────────────────►│ ──────────────────────►│                      │
│      │   PCM Audio (binary)  │                        │  [FFmpeg schreibt    │
│      │ ─────────────────────►│ ──────────────────────►│   in WAV-Datei]      │
│      │   PCM Audio (binary)  │                        │                      │
│      │ ─────────────────────►│ ──────────────────────►│                      │
│      │        ...            │         ...            │                      │
│      │                       │                        │                      │
│      │                       │                        │  [User drückt F9]    │
│      │                       │                        │                      │
│      │   { type: 'STOP' }    │                        │                      │
│      │◄───────────────────── │◄────────────────────── │                      │
│      │                       │                        │                      │
│      │  [Stoppt AudioWorklet]│                        │  [Schließt FFmpeg]   │
│      │                       │                        │                      │
│      │  { IPHONE_READY }     │                        │                      │
│      │ ─────────────────────►│ ──────────────────────►│                      │
│      │                       │                        │                      │
│      │                       │                        │  [WAV → VAD →        │
│      │                       │                        │   Upload → API]      │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Komponenten

### 1. Railway Audio Relay Server

**Pfad:** `railway-audio-relay/server.js`
**Deployed auf:** `wss://dentdoc-desktop-production-a7a1.up.railway.app`

Der Relay ist ein **reiner WebSocket-Proxy** - er speichert keine Daten, macht kein VAD, schreibt keine Dateien.

```javascript
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

      if (!partner || partner.readyState !== 1) {
        // Partner not connected, drop message silently
        return;
      }

      try {
        if (isBinary) {
          // Binary data (PCM audio from iPhone) - forward as-is
          partner.send(data, { binary: true });
        } else {
          // Text/JSON message - parse and forward
          try {
            const msg = JSON.parse(data.toString());
            fastify.log.info('[%s → %s] %s', role.toUpperCase(), role === 'iphone' ? 'DESKTOP' : 'IPHONE', msg.type);
          } catch (_) {
            // Not JSON, that's fine
          }
          partner.send(data.toString());
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
```

**Wichtige Erkenntnisse:**
- `@fastify/websocket` übergibt ein **Connection-Objekt**, nicht den echten WebSocket
- Man muss `connection.socket` verwenden, nicht `connection` direkt
- `safeClose()` braucht Fallbacks: `close()` → `terminate()` → `destroy()`
- Ohne diese Fixes: `pair.iphone.close is not a function` Error → Reconnect-Loop

---

### 2. Backend API (Vercel/Next.js)

#### 2.1 Pairing starten (Desktop ruft auf)

**Pfad:** `app/api/iphone/pair/start/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/auth/jwt';
import { db } from '@/lib/db/drizzle';
import { iphonePairingCodes, iphoneDevices } from '@/lib/db/schema';
import { eq, and, isNull, gt } from 'drizzle-orm';

// Generate a 6-character alphanumeric code (easy to type)
function generatePairingId(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Excluded I, O, 0, 1 to avoid confusion
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * POST /api/iphone/pair/start
 *
 * Starts the iPhone pairing process by generating a pairing code.
 * Desktop calls this, then displays QR code with the URL.
 *
 * Response: { pairingId: "AB7K9Q", pairingUrl: "https://dentdoc-app.vercel.app/mic/AB7K9Q" }
 */
export async function POST(request: NextRequest) {
  try {
    const user = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Check if user already has an active paired iPhone
    const [existingDevice] = await db
      .select()
      .from(iphoneDevices)
      .where(
        and(
          eq(iphoneDevices.userId, user.id),
          isNull(iphoneDevices.unpairedAt)
        )
      )
      .limit(1);

    if (existingDevice) {
      return NextResponse.json(
        {
          error: 'already_paired',
          message: 'Ein iPhone ist bereits gekoppelt. Bitte erst entkoppeln.',
          deviceName: existingDevice.deviceName
        },
        { status: 409 }
      );
    }

    // Generate unique pairing ID
    let pairingId: string;
    let attempts = 0;
    const maxAttempts = 10;
    const now = new Date();

    do {
      pairingId = generatePairingId();
      const [existing] = await db
        .select()
        .from(iphonePairingCodes)
        .where(
          and(
            eq(iphonePairingCodes.pairingId, pairingId),
            gt(iphonePairingCodes.expiresAt, now)
          )
        )
        .limit(1);

      if (!existing) break;
      attempts++;
    } while (attempts < maxAttempts);

    if (attempts >= maxAttempts) {
      return NextResponse.json(
        { error: 'Failed to generate unique pairing code' },
        { status: 500 }
      );
    }

    // Create pairing code (expires in 10 minutes)
    const expiresAt = new Date(now.getTime() + 10 * 60 * 1000);

    await db.insert(iphonePairingCodes).values({
      userId: user.id,
      pairingId,
      expiresAt,
    });

    const baseUrl = 'https://dentdoc-app.vercel.app';
    const pairingUrl = `${baseUrl}/mic/${pairingId}`;

    return NextResponse.json({
      pairingId,
      pairingUrl,
      expiresAt: expiresAt.toISOString(),
    });
  } catch (error) {
    console.error('iPhone pair start error:', error);
    return NextResponse.json(
      { error: 'Failed to start pairing' },
      { status: 500 }
    );
  }
}
```

#### 2.2 Pairing bestätigen (iPhone ruft auf)

**Pfad:** `app/api/iphone/pair/confirm/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db/drizzle';
import { iphonePairingCodes, iphoneDevices } from '@/lib/db/schema';
import { eq, and, isNull, gt } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';

/**
 * POST /api/iphone/pair/confirm
 *
 * iPhone calls this after scanning QR code to complete pairing.
 *
 * Body: { pairingId: "AB7K9Q", deviceInfo: { model: "iPhone 14 Pro", iosVersion: "17.2" } }
 * Response: { iphoneDeviceId, iphoneAuthToken, streamUrl, deviceName }
 */
export async function POST(request: NextRequest) {
  try {
    const { pairingId, deviceInfo } = await request.json();

    if (!pairingId) {
      return NextResponse.json(
        { error: 'invalid_code', message: 'Pairing code required' },
        { status: 400 }
      );
    }

    const now = new Date();

    // Find valid pairing code
    const [pairingCode] = await db
      .select()
      .from(iphonePairingCodes)
      .where(
        and(
          eq(iphonePairingCodes.pairingId, pairingId),
          gt(iphonePairingCodes.expiresAt, now),
          isNull(iphonePairingCodes.usedAt)
        )
      )
      .limit(1);

    if (!pairingCode) {
      // Check if expired or already used
      const [anyCode] = await db
        .select()
        .from(iphonePairingCodes)
        .where(eq(iphonePairingCodes.pairingId, pairingId))
        .limit(1);

      if (anyCode) {
        if (anyCode.usedAt) {
          return NextResponse.json(
            { error: 'already_used', message: 'Code already used' },
            { status: 400 }
          );
        }
        if (anyCode.expiresAt < now) {
          return NextResponse.json(
            { error: 'expired', message: 'Code expired' },
            { status: 400 }
          );
        }
      }

      return NextResponse.json(
        { error: 'invalid_code', message: 'Invalid pairing code' },
        { status: 400 }
      );
    }

    // Generate iPhone credentials
    const iphoneDeviceId = `iphone_${uuidv4()}`;
    const iphoneAuthToken = jwt.sign(
      { deviceId: iphoneDeviceId, userId: pairingCode.userId, type: 'iphone' },
      process.env.JWT_SECRET || 'fallback-secret',
      { expiresIn: '365d' }
    );

    const deviceName = deviceInfo?.model || 'iPhone';

    // Create iPhone device record
    await db.insert(iphoneDevices).values({
      userId: pairingCode.userId,
      iphoneDeviceId,
      iphoneAuthToken,
      deviceName,
      deviceInfo: JSON.stringify(deviceInfo || {}),
    });

    // Mark pairing code as used
    await db
      .update(iphonePairingCodes)
      .set({ usedAt: now })
      .where(eq(iphonePairingCodes.id, pairingCode.id));

    // Return credentials for iPhone to store
    const streamUrl = process.env.AUDIO_RELAY_URL || 'wss://dentdoc-desktop-production-a7a1.up.railway.app';

    return NextResponse.json({
      iphoneDeviceId,
      iphoneAuthToken,
      streamUrl,
      deviceName,
    });
  } catch (error) {
    console.error('iPhone pair confirm error:', error);
    return NextResponse.json(
      { error: 'Failed to confirm pairing' },
      { status: 500 }
    );
  }
}
```

#### 2.3 Pairing Status prüfen (Desktop pollt)

**Pfad:** `app/api/iphone/pair/status/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/auth/jwt';
import { db } from '@/lib/db/drizzle';
import { iphonePairingCodes, iphoneDevices } from '@/lib/db/schema';
import { eq, and, isNull } from 'drizzle-orm';

/**
 * GET /api/iphone/pair/status?pairingId=AB7K9Q
 *
 * Desktop polls this to check if iPhone completed pairing.
 */
export async function GET(request: NextRequest) {
  try {
    const user = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const pairingId = searchParams.get('pairingId');

    if (!pairingId) {
      return NextResponse.json({ error: 'pairingId required' }, { status: 400 });
    }

    // Check if pairing code was used
    const [pairingCode] = await db
      .select()
      .from(iphonePairingCodes)
      .where(
        and(
          eq(iphonePairingCodes.pairingId, pairingId),
          eq(iphonePairingCodes.userId, user.id)
        )
      )
      .limit(1);

    if (!pairingCode) {
      return NextResponse.json({ status: 'not_found' }, { status: 404 });
    }

    if (pairingCode.usedAt) {
      // Pairing completed - get device info
      const [device] = await db
        .select()
        .from(iphoneDevices)
        .where(
          and(
            eq(iphoneDevices.userId, user.id),
            isNull(iphoneDevices.unpairedAt)
          )
        )
        .limit(1);

      return NextResponse.json({
        status: 'paired',
        device: device ? {
          iphoneDeviceId: device.iphoneDeviceId,
          deviceName: device.deviceName,
        } : null
      });
    }

    const now = new Date();
    if (pairingCode.expiresAt < now) {
      return NextResponse.json({ status: 'expired' });
    }

    return NextResponse.json({
      status: 'pending',
      expiresAt: pairingCode.expiresAt.toISOString()
    });
  } catch (error) {
    console.error('iPhone pair status error:', error);
    return NextResponse.json(
      { error: 'Failed to get status' },
      { status: 500 }
    );
  }
}
```

#### 2.4 iPhone Status prüfen

**Pfad:** `app/api/iphone/status/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/auth/jwt';
import { db } from '@/lib/db/drizzle';
import { iphoneDevices } from '@/lib/db/schema';
import { eq, and, isNull } from 'drizzle-orm';

/**
 * GET /api/iphone/status
 *
 * Check if user has a paired iPhone.
 */
export async function GET(request: NextRequest) {
  try {
    const user = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const [device] = await db
      .select()
      .from(iphoneDevices)
      .where(
        and(
          eq(iphoneDevices.userId, user.id),
          isNull(iphoneDevices.unpairedAt)
        )
      )
      .limit(1);

    if (!device) {
      return NextResponse.json({ paired: false });
    }

    return NextResponse.json({
      paired: true,
      deviceName: device.deviceName,
      iphoneDeviceId: device.iphoneDeviceId,
      lastSeen: device.lastSeenAt?.toISOString(),
    });
  } catch (error) {
    console.error('iPhone status error:', error);
    return NextResponse.json(
      { error: 'Failed to get status' },
      { status: 500 }
    );
  }
}
```

#### 2.5 iPhone entkoppeln

**Pfad:** `app/api/iphone/unpair/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/auth/jwt';
import { db } from '@/lib/db/drizzle';
import { iphoneDevices } from '@/lib/db/schema';
import { eq, and, isNull } from 'drizzle-orm';

/**
 * DELETE /api/iphone/unpair
 *
 * Unpair user's iPhone.
 */
export async function DELETE(request: NextRequest) {
  try {
    const user = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const [device] = await db
      .select()
      .from(iphoneDevices)
      .where(
        and(
          eq(iphoneDevices.userId, user.id),
          isNull(iphoneDevices.unpairedAt)
        )
      )
      .limit(1);

    if (!device) {
      return NextResponse.json({ error: 'No paired device' }, { status: 404 });
    }

    // Soft delete - set unpairedAt
    await db
      .update(iphoneDevices)
      .set({ unpairedAt: new Date() })
      .where(eq(iphoneDevices.id, device.id));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('iPhone unpair error:', error);
    return NextResponse.json(
      { error: 'Failed to unpair' },
      { status: 500 }
    );
  }
}
```

---

### 3. Datenbank Schema

**Pfad:** `lib/db/schema.ts` (relevanter Teil)

```typescript
// iPhone Pairing - temporary codes for QR code pairing
export const iphonePairingCodes = pgTable('iphone_pairing_codes', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id),
  pairingId: varchar('pairing_id', { length: 10 }).notNull().unique(), // 6-char code like "AB7K9Q"
  expiresAt: timestamp('expires_at').notNull(), // 10 minutes from creation
  usedAt: timestamp('used_at'), // Set when iPhone confirms pairing
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// iPhone Devices - paired iPhones for audio streaming
export const iphoneDevices = pgTable('iphone_devices', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id),
  iphoneDeviceId: text('iphone_device_id').notNull().unique(), // UUID: "iphone_92f1..."
  iphoneAuthToken: text('iphone_auth_token').notNull(), // JWT for relay auth
  deviceName: varchar('device_name', { length: 100 }), // "iPhone 14 Pro"
  deviceInfo: text('device_info'), // JSON: { model, iosVersion }
  lastSeenAt: timestamp('last_seen_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  unpairedAt: timestamp('unpaired_at'), // NULL if still paired
});
```

**Migration:** `lib/db/migrations/0014_iphone_pairing.sql`

```sql
CREATE TABLE "iphone_devices" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"iphone_device_id" text NOT NULL,
	"iphone_auth_token" text NOT NULL,
	"device_name" varchar(100),
	"device_info" text,
	"last_seen_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"unpaired_at" timestamp,
	CONSTRAINT "iphone_devices_iphone_device_id_unique" UNIQUE("iphone_device_id")
);
--> statement-breakpoint
CREATE TABLE "iphone_pairing_codes" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"pairing_id" varchar(10) NOT NULL,
	"expires_at" timestamp NOT NULL,
	"used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "iphone_pairing_codes_pairing_id_unique" UNIQUE("pairing_id")
);
--> statement-breakpoint
ALTER TABLE "iphone_devices" ADD CONSTRAINT "iphone_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "iphone_pairing_codes" ADD CONSTRAINT "iphone_pairing_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
```

---

### 4. iPhone Web Page (Safari)

**Pfad:** `app/mic/[pairingId]/page.tsx`

Diese Seite läuft im Safari auf dem iPhone. Sie:
1. Holt Credentials vom Backend (bei neuem Pairing) oder aus localStorage (bei Return-Visit)
2. Fordert Mikrofon-Berechtigung an (User Gesture erforderlich!)
3. Erstellt AudioContext + AudioWorklet
4. Verbindet sich mit dem Relay
5. Wartet auf START vom Desktop
6. Streamt PCM-Audio zum Desktop
7. Stoppt bei STOP vom Desktop

**Kritische iOS-Regeln:**
- AudioContext **NUR nach User Gesture** erstellen (Button-Click)
- AudioContext **EINMAL erstellen**, nie schließen bis Page-Unmount
- **Kein Auto-Reconnect** - User muss manuell "Neu verbinden" klicken
- **AudioWorklet** statt ScriptProcessorNode (stabiler auf iOS)
- `isConnectingRef` Lock um Race Conditions zu verhindern

```typescript
'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { useParams } from 'next/navigation';

/**
 * iPhone Mic Page - Stable iOS Audio Streaming
 *
 * CRITICAL RULES FOR iOS STABILITY:
 * 1. AudioContext: Create ONCE, never close until page unmount
 * 2. WebSocket: Connect ONCE, no auto-reconnect (user must reload)
 * 3. START/STOP: Only from Desktop, not from connection events
 * 4. Nodes: Disconnect on STOP, but keep AudioContext alive
 */

type Status = 'loading' | 'error' | 'need_activation' | 'connecting' | 'ready' | 'recording' | 'disconnected';

interface DeviceCredentials {
  iphoneDeviceId: string;
  iphoneAuthToken: string;
  streamUrl: string;
  deviceName: string;
}

export default function IphoneMicPage() {
  const params = useParams();
  const pairingId = params.pairingId as string;

  const [status, setStatus] = useState<Status>('loading');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [credentials, setCredentials] = useState<DeviceCredentials | null>(null);

  // Refs - these persist across renders and don't trigger re-renders
  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const isStreamingRef = useRef<boolean>(false);
  const workletReadyRef = useRef<boolean>(false);
  const isConnectingRef = useRef<boolean>(false); // Lock to prevent race conditions

  // ... (vollständiger Code siehe Datei)
}
```

**AudioWorklet Processor:**

**Pfad:** `public/audio-worklet-processor.js`

```javascript
/**
 * AudioWorklet Processor for iPhone Mic Streaming
 *
 * This runs in a separate audio thread and is much more stable than ScriptProcessorNode
 * on iOS Safari. It converts Float32 audio samples to Int16 PCM and sends them to the main thread.
 */
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.isRecording = true;

    // Listen for stop messages from main thread
    this.port.onmessage = (event) => {
      if (event.data.type === 'stop') {
        this.isRecording = false;
      } else if (event.data.type === 'start') {
        this.isRecording = true;
      }
    };
  }

  process(inputs, outputs, parameters) {
    // Get the first input's first channel
    const input = inputs[0];
    if (!input || !input[0] || !this.isRecording) {
      return true; // Keep processor alive
    }

    const float32 = input[0];

    // Convert Float32 [-1, 1] to Int16 [-32768, 32767]
    const int16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }

    // Send PCM data to main thread
    this.port.postMessage({
      type: 'pcm',
      buffer: int16.buffer
    }, [int16.buffer]); // Transfer buffer for efficiency

    return true; // Keep processor alive
  }
}

registerProcessor('pcm-processor', PCMProcessor);
```

---

### 5. Desktop (Electron)

#### 5.1 iPhone Recording starten

**Pfad:** `main.js` (relevanter Teil)

```javascript
// ============================================================================
// iPhone Recording Mode
// ============================================================================
const WebSocket = require('ws');

let isIphoneSession = false;
let iphoneRelayWs = null;
let iphoneFfmpegProcess = null;
let iphoneRecordingPath = null;

async function startRecordingWithIphone() {
  console.log('[iPhone] ========== Start Recording (iPhone Mode) ==========');

  const iphoneDeviceId = store.get('iphoneDeviceId');
  const token = store.get('authToken');

  if (!iphoneDeviceId) {
    throw new Error('Kein iPhone gekoppelt. Bitte erst in Einstellungen koppeln.');
  }

  try {
    isRecording = true;
    isIphoneSession = true;
    updateTrayMenu();

    // Change tray icon to recording state
    const recordingIconPath = path.join(__dirname, 'assets', 'tray-icon-recording.png');
    tray.setImage(recordingIconPath);
    tray.setToolTip('DentDoc - iPhone-Aufnahme wird vorbereitet...');

    // Create output path for WAV
    const tempDir = path.join(app.getPath('temp'), 'dentdoc');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    iphoneRecordingPath = path.join(tempDir, `iphone_${Date.now()}.wav`);

    // Start FFmpeg - reads from stdin, writes WAV
    const ffmpegPath = audioRecorder.getFFmpegPath();
    iphoneFfmpegProcess = spawn(ffmpegPath, [
      '-f', 's16le',           // Input: signed 16-bit little-endian PCM
      '-ar', '16000',          // Sample rate: 16kHz
      '-ac', '1',              // Channels: mono
      '-i', 'pipe:0',          // Input: stdin
      '-acodec', 'pcm_s16le',  // Output codec
      '-y',                    // Overwrite
      iphoneRecordingPath
    ]);

    iphoneFfmpegProcess.stderr.on('data', (data) => {
      console.log('[iPhone FFmpeg]', data.toString().trim());
    });

    iphoneFfmpegProcess.on('error', (err) => {
      console.error('[iPhone FFmpeg] Process error:', err);
    });

    // Connect to Relay
    const relayUrl = process.env.AUDIO_RELAY_URL || 'wss://dentdoc-desktop-production-a7a1.up.railway.app';
    console.log('[iPhone] Connecting to relay:', relayUrl);

    iphoneRelayWs = new WebSocket(`${relayUrl}/stream?device=${iphoneDeviceId}&role=desktop&token=${token}`);

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('iPhone antwortet nicht. Bitte Safari-Seite auf iPhone öffnen.'));
      }, 15000);

      iphoneRelayWs.on('open', () => {
        console.log('[iPhone] Connected to relay, waiting for iPhone...');
        tray.setToolTip('DentDoc - Warte auf iPhone...');
      });

      iphoneRelayWs.on('message', (data) => {
        // Check if JSON (control message) or binary (audio)
        if (Buffer.isBuffer(data) && data.length > 0) {
          // Try to parse as JSON first
          if (data[0] === 0x7b) { // '{'
            try {
              const msg = JSON.parse(data.toString());
              handleIphoneControlMessage(msg, timeout, resolve);
              return;
            } catch (e) {
              // Not JSON, must be audio data
            }
          }

          // Binary PCM audio data - write to FFmpeg (only if still recording)
          if (isIphoneSession && iphoneFfmpegProcess && iphoneFfmpegProcess.stdin && !iphoneFfmpegProcess.stdin.destroyed) {
            try {
              iphoneFfmpegProcess.stdin.write(data);
            } catch (e) {
              // Ignore write errors during shutdown
              console.warn('[iPhone] Write error (likely during shutdown):', e.message);
            }
          }
        } else if (typeof data === 'string') {
          try {
            const msg = JSON.parse(data);
            handleIphoneControlMessage(msg, timeout, resolve);
          } catch (e) {
            console.warn('[iPhone] Invalid message:', data);
          }
        }
      });

      iphoneRelayWs.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`Relay-Verbindung fehlgeschlagen: ${err.message}`));
      });

      iphoneRelayWs.on('close', (code, reason) => {
        console.log('[iPhone] WebSocket closed:', code, reason?.toString());
        if (isIphoneSession && isRecording) {
          console.warn('[iPhone] Connection lost during recording!');
        }
      });
    });

    console.log('[iPhone] ========== Recording Started ==========');

  } catch (error) {
    console.error('[iPhone] Start error:', error);

    // Cleanup on error
    if (iphoneFfmpegProcess) {
      iphoneFfmpegProcess.kill();
      iphoneFfmpegProcess = null;
    }
    if (iphoneRelayWs) {
      iphoneRelayWs.close();
      iphoneRelayWs = null;
    }

    isRecording = false;
    isIphoneSession = false;
    updateTrayMenu();

    // Reset tray
    const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
    tray.setImage(iconPath);
    tray.setToolTip('DentDoc - Bereit zum Aufnehmen');

    throw error;
  }
}

function handleIphoneControlMessage(msg, timeout, resolve) {
  console.log('[iPhone] Control message:', msg.type);

  if (msg.type === 'IPHONE_CONNECTED') {
    console.log('[iPhone] iPhone is connected, sending START');
    // Send START to iPhone
    if (iphoneRelayWs && iphoneRelayWs.readyState === WebSocket.OPEN) {
      iphoneRelayWs.send(JSON.stringify({ type: 'START' }));
    }
  }

  if (msg.type === 'IPHONE_READY') {
    clearTimeout(timeout);
    console.log('[iPhone] iPhone is ready and streaming');
    tray.setToolTip('DentDoc - 🔴 iPhone-Aufnahme läuft...');
    const shortcut = store.get('shortcut') || 'F9';
    updateStatusOverlay('iPhone-Aufnahme läuft...', `Drücken Sie ${shortcut} zum Stoppen`, 'recording');
    resolve();
  }

  if (msg.type === 'IPHONE_DISCONNECTED') {
    console.warn('[iPhone] iPhone disconnected during recording!');
  }
}
```

#### 5.2 iPhone Recording stoppen

```javascript
async function stopRecordingWithIphone() {
  console.log('[iPhone] ========== Stop Recording (iPhone Mode) ==========');

  // IMPORTANT: Set isIphoneSession to false FIRST to stop accepting new audio data
  isIphoneSession = false;

  try {
    tray.setToolTip('DentDoc - Stoppe iPhone-Aufnahme...');

    // Send STOP to iPhone via Relay
    if (iphoneRelayWs && iphoneRelayWs.readyState === WebSocket.OPEN) {
      console.log('[iPhone] Sending STOP to iPhone');
      iphoneRelayWs.send(JSON.stringify({ type: 'STOP' }));
    }

    // Close WebSocket FIRST to stop receiving data
    if (iphoneRelayWs) {
      console.log('[iPhone] Closing WebSocket');
      iphoneRelayWs.close();
      iphoneRelayWs = null;
    }

    // Small delay to let any in-flight writes complete
    await new Promise(r => setTimeout(r, 100));

    // Close FFmpeg stdin -> FFmpeg writes WAV header and exits
    if (iphoneFfmpegProcess && iphoneFfmpegProcess.stdin && !iphoneFfmpegProcess.stdin.destroyed) {
      console.log('[iPhone] Closing FFmpeg stdin');
      iphoneFfmpegProcess.stdin.end();
    }

    // Wait for FFmpeg to finish
    if (iphoneFfmpegProcess) {
      await new Promise((resolve) => {
        iphoneFfmpegProcess.on('close', (code) => {
          console.log('[iPhone] FFmpeg exited with code:', code);
          resolve();
        });
        // Timeout fallback
        setTimeout(resolve, 5000);
      });
    }

    // Get recording path
    const recordingPath = iphoneRecordingPath;

    // Reset state
    iphoneFfmpegProcess = null;
    iphoneRecordingPath = null;
    isRecording = false;
    updateTrayMenu();

    // Reset tray
    const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
    tray.setImage(iconPath);
    tray.setToolTip('DentDoc - Bereit zum Aufnehmen');

    console.log('[iPhone] Recording stopped, file:', recordingPath);
    console.log('[iPhone] ========== Recording Stopped ==========');

    // Return path for processing
    return recordingPath;

  } catch (error) {
    console.error('[iPhone] Stop error:', error);

    // Force cleanup
    if (iphoneFfmpegProcess) {
      iphoneFfmpegProcess.kill();
      iphoneFfmpegProcess = null;
    }
    if (iphoneRelayWs) {
      iphoneRelayWs.close();
      iphoneRelayWs = null;
    }

    isRecording = false;
    isIphoneSession = false;
    iphoneRecordingPath = null;
    updateTrayMenu();

    throw error;
  }
}
```

---

## Stabilitäts-Features

### Heartbeat / Keep-Alive

iOS und WLAN können TCP-Verbindungen "einschlafen" lassen. Um stille Disconnects zu verhindern:

- iPhone und Desktop senden alle **10 Sekunden** ein `PING`
- Relay antwortet mit `PONG`
- Keine Weiterleitung an Partner (bleibt lokal)

```javascript
// iPhone/Desktop
setInterval(() => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'PING' }));
  }
}, 10000);

// Relay
if (msg.type === 'PING') {
  socket.send(JSON.stringify({ type: 'PONG' }));
  return; // Don't forward
}
```

### Graceful Degradation bei Disconnect

Wenn das iPhone während der Aufnahme die Verbindung verliert:

- **Aufnahme läuft weiter** (FFmpeg schreibt weiter, ggf. Stille)
- Desktop zeigt Warnung: "⚠️ iPhone getrennt - Aufnahme läuft weiter"
- Arzt kann Aufnahme normal mit F9 beenden
- **Keine Daten gehen verloren**

```javascript
if (msg.type === 'IPHONE_DISCONNECTED') {
  // DON'T stop recording - doctor keeps control
  updateStatusOverlay('⚠️ iPhone getrennt', 'Aufnahme läuft weiter. F9 zum Stoppen.', 'warning');
}
```

---

## Gelöste Probleme

### 1. `pair.iphone.close is not a function`

**Problem:** @fastify/websocket übergibt ein Connection-Objekt, nicht den echten WebSocket.

**Lösung:** `connection.socket` verwenden + `safeClose()` mit Fallbacks:
```javascript
const socket = connection.socket || connection;

function safeClose(socket, code, reason) {
  try { socket.close(code, reason); return; } catch (_) {}
  try { socket.terminate?.(); return; } catch (_) {}
  try { socket.destroy?.(); } catch (_) {}
}
```

### 2. iOS Reconnect-Loop

**Problem:**
- AudioContext bei jedem START neu erstellt → iOS killt es
- Auto-Reconnect bei WS close → Endlosschleife
- ScriptProcessorNode ist deprecated und instabil auf iOS

**Lösung:**
- AudioContext **EINMAL** nach User Gesture erstellen
- **Kein Auto-Reconnect** - manueller "Neu verbinden" Button
- **AudioWorklet** statt ScriptProcessorNode
- `isConnectingRef` Lock gegen Race Conditions

### 3. `ERR_STREAM_WRITE_AFTER_END`

**Problem:** Nach dem Stoppen werden noch Audio-Daten an FFmpeg geschrieben.

**Lösung:**
1. `isIphoneSession = false` **ZUERST** setzen
2. Write-Check: `if (isIphoneSession && iphoneFfmpegProcess...)`
3. WebSocket **VOR** FFmpeg schließen
4. Try-Catch um stdin.write()

### 4. Falsche Relay-URL

**Problem:** Desktop verwendete falsche URL `dentdoc-audio-relay` statt `dentdoc-desktop-production-a7a1`.

**Lösung:** URL korrigiert:
```javascript
const relayUrl = process.env.AUDIO_RELAY_URL || 'wss://dentdoc-desktop-production-a7a1.up.railway.app';
```

### 5. QR-Code zeigte falsche URL

**Problem:** Mehrere Stellen hatten hardcoded `dentdoc.app` statt `dentdoc-app.vercel.app`.

**Lösung:** Alle URLs auf `https://dentdoc-app.vercel.app` vereinheitlicht.

### 6. electron-store `Use delete() to clear values`

**Problem:** `store.set('key', undefined)` wirft einen Fehler.

**Lösung:** Nur `store.set()` aufrufen, wenn der Wert existiert:
```javascript
if (status.iphoneDeviceId) {
  store.set('iphoneDeviceId', status.iphoneDeviceId);
}
```

### 7. localStorage Cache verhindert Re-Pairing

**Problem:** iPhone verwendete alte Credentials aus localStorage statt neuen Pairing-Code.

**Lösung:** Bei neuem 6-Zeichen-Code localStorage leeren:
```javascript
const isNewPairingCode = pairingId && pairingId !== '_paired' && /^[A-Z0-9]{6}$/.test(pairingId);
if (isNewPairingCode) {
  localStorage.removeItem('dentdoc_iphone_device_id');
  // ...
}
```

---

## Audio-Optimierung (Quellenbasierte Strategie)

**Grundprinzip:** Alle Audio-Optimierung passiert NACH der Aufnahme auf dem Desktop. iPhone & Mic liefern Rohmaterial – die Pipeline macht es gut.

```
RAW AUDIO (WAV 16 kHz, mono)
   ↓
Auto-Level (quellenabhängig)
   ↓
VAD (Silero) → speech_only.wav
   ↓
Bandpass (200–3000 Hz)
   ↓
AssemblyAI
```

### Zwei Profile

#### Profil A: iPhone (source='iphone')

**Charakteristik:**
- Leise, variabler Abstand, unzuverlässiger Pegel
- Kein echtes AGC auf iOS

**Strategie:** IMMER `loudnorm` – keine RMS-Entscheidung!

```javascript
// iPhone: IMMER loudnorm - maximale Konsistenz
filter = 'loudnorm=I=-16:LRA=11:TP=-1.5';
strategy = 'loudnorm';
```

**Wichtig:**
- ❌ Kein Gain im AudioWorklet (entfernt!)
- ❌ Kein RMS-Branching
- ❌ Kein `none` oder `mild_gain`
- ✅ IMMER `loudnorm` auf Desktop

#### Profil B: Desktop Mic (source='mic')

**Charakteristik:**
- Nah, konsistent, oft schon gut eingepegelt

**Strategie:** RMS-basierte Entscheidung

| RMS | Strategie | Filter |
|-----|-----------|--------|
| < -50 dB | `loudnorm` | `loudnorm=I=-16:LRA=9:TP=-1.5` |
| -50 bis -28 dB | `mild_gain` | `volume=6dB` |
| > -28 dB | `none` | (passthrough) |

```javascript
if (rms < -50) {
  strategy = 'loudnorm';
} else if (rms < -28) {
  strategy = 'mild_gain';
} else {
  strategy = 'none';
}
```

### Entscheidungs-Matrix (Support-Gold)

| Quelle | RMS | Strategie |
|--------|-----|-----------|
| iPhone | egal | loudnorm |
| USB Mic | < -50 | loudnorm |
| USB Mic | -50 … -28 | mild_gain |
| USB Mic | > -28 | none |

### Pfade

**Pfad:** `src/audio-converter.js`

```javascript
async function autoLevel(inputPath, outputPath, options = {}) {
  const source = options.source || 'mic';  // 'iphone' | 'mic'
  const { rms } = await analyzeAudio(inputPath);

  console.log(`[AutoLevel] Source: ${source}`);
  console.log(`[AutoLevel] Input RMS: ${rms?.toFixed(1)} dB`);

  if (source === 'iphone') {
    // iPhone: IMMER loudnorm
    filter = 'loudnorm=I=-16:LRA=11:TP=-1.5';
    strategy = 'loudnorm';
  } else {
    // Desktop Mic: RMS-basiert
    if (rms < -50) { strategy = 'loudnorm'; }
    else if (rms < -28) { strategy = 'mild_gain'; }
    else { strategy = 'none'; }
  }

  console.log(`[AutoLevel] Strategy: ${strategy}`);
}
```

**Pfad:** `public/audio-worklet-processor.js`

```javascript
// KEIN GAIN! iPhone liefert RAW PCM → Desktop macht Auto-Level
const s = Math.max(-1, Math.min(1, float32[i]));  // Kein * GAIN
int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
```

### Pipeline-Integration

**Pfad:** `src/pipeline/index.js`

Auto-Level läuft **VOR** VAD für bessere Spracherkennung:

```
┌─────────────┐    ┌─────────────┐    ┌─────────┐    ┌─────────────┐
│ WAV-Datei   │ → │ Auto-Level  │ → │   VAD   │ → │ speech_only │
│ (RAW)       │    │ (source)    │    │ Silero  │    │    .wav     │
└─────────────┘    └─────────────┘    └─────────┘    └─────────────┘
```

### Logging (Pflicht!)

```
[AutoLevel] Source: iphone
[AutoLevel] Input RMS: -68.1 dB
[AutoLevel] Strategy: loudnorm (iPhone - always)
```

oder

```
[AutoLevel] Source: mic
[AutoLevel] Input RMS: -24.3 dB
[AutoLevel] Strategy: none (good level)
```

---

## Audio-Level Visualisierung (Glow-Animation)

Der Recording-Button im Status-Overlay zeigt eine pulsierende Glow-Animation basierend auf dem Audio-Level.

### Quellen der Audio-Level:

| Quelle | IPC-Channel | Beschreibung |
|--------|-------------|--------------|
| iPhone | `iphone-audio-level` | RMS aus PCM-Chunks in main.js |
| Lokales Mic (ohne VAD) | `audio-level` | Von dashboard.js Renderer |
| Lokales Mic (mit VAD) | `audio-level` | Von vad-controller.js |

### Visualisierung

**Pfad:** `src/status-overlay.html`

```javascript
function updateAudioLevel(level) {
  // Amplify for visible effect
  const amplified = Math.pow(level * 5, 0.6);
  const clamped = Math.min(1, amplified);

  // Scale: 1.0 (silent) to 1.6 (loud)
  icon.style.transform = `scale(${1 + clamped * 0.6})`;

  // Color shift: red → orange → yellow-white
  const g = Math.round(68 + clamped * 150);
  const b = Math.round(68 + clamped * 100);
  icon.style.boxShadow = `0 0 ${20 + clamped * 40}px rgba(239, ${g}, ${b}, ${0.4 + clamped * 0.6})`;
}
```

---

## Audio-Format

- **Sample Rate:** 16000 Hz (16 kHz)
- **Channels:** 1 (Mono)
- **Bit Depth:** 16-bit signed integer (s16le)
- **Endianness:** Little-endian
- **Format:** Raw PCM über WebSocket, WAV auf Desktop
- **Gain:** KEIN Gain auf iPhone (RAW), Auto-Level auf Desktop

**Konvertierung im AudioWorklet (KEIN GAIN!):**
```javascript
// Float32 [-1, 1] → Int16 [-32768, 32767] - RAW, kein Gain
const s = Math.max(-1, Math.min(1, float32[i]));
int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
```

**FFmpeg Kommando:**
```bash
ffmpeg -f s16le -ar 16000 -ac 1 -i pipe:0 -acodec pcm_s16le -y output.wav
```

---

## Nachrichten-Protokoll

| Nachricht | Richtung | Beschreibung |
|-----------|----------|--------------|
| `IPHONE_CONNECTED` | Relay → Desktop | iPhone hat sich verbunden |
| `IPHONE_DISCONNECTED` | Relay → Desktop | iPhone hat sich getrennt |
| `DESKTOP_DISCONNECTED` | Relay → iPhone | Desktop hat sich getrennt |
| `START` | Desktop → iPhone | Aufnahme starten |
| `STOP` | Desktop → iPhone | Aufnahme stoppen |
| `IPHONE_READY` | iPhone → Desktop | iPhone streamt jetzt Audio |
| `PING` | iPhone/Desktop → Relay | Keep-alive Heartbeat (alle 10s) |
| `PONG` | Relay → iPhone/Desktop | Heartbeat-Antwort |
| Binary (PCM) | iPhone → Desktop | Audio-Daten |

---

## Dateien-Übersicht

| Datei | Beschreibung |
|-------|--------------|
| `railway-audio-relay/server.js` | WebSocket Relay Server |
| `app/api/iphone/pair/start/route.ts` | Pairing starten |
| `app/api/iphone/pair/confirm/route.ts` | Pairing bestätigen |
| `app/api/iphone/pair/status/route.ts` | Pairing-Status prüfen |
| `app/api/iphone/status/route.ts` | iPhone-Status prüfen |
| `app/api/iphone/unpair/route.ts` | iPhone entkoppeln |
| `app/mic/[pairingId]/page.tsx` | iPhone Web-Seite |
| `app/mic/page.tsx` | Landing für bereits gekoppelte iPhones |
| `public/audio-worklet-processor.js` | AudioWorklet für PCM-Streaming |
| `lib/db/schema.ts` | Datenbank-Schema |
| `lib/db/migrations/0014_iphone_pairing.sql` | Migration |
| `main.js` | Desktop Electron App (iPhone-Teil) |
| `src/audioRecorderFFmpeg.js` | FFmpeg-Pfad Export |

---

## Umgebungsvariablen

### Backend (Vercel)
```
AUDIO_RELAY_URL=wss://dentdoc-desktop-production-a7a1.up.railway.app
JWT_SECRET=your-secret
```

### Desktop (.env.local)
```
AUDIO_RELAY_URL=wss://dentdoc-desktop-production-a7a1.up.railway.app
```

### Railway
```
PORT=3001
DENTDOC_API_URL=https://dentdoc-app.vercel.app
```

---

## Test-Checkliste

1. **Pairing testen:**
   - [ ] QR-Code scannen mit iPhone
   - [ ] iPhone zeigt "Bereit zur Aktivierung"
   - [ ] "Mikrofon aktivieren" Button klicken
   - [ ] iPhone zeigt "Bereit" (grün)
   - [ ] Desktop zeigt "iPhone gekoppelt"

2. **Aufnahme testen:**
   - [ ] F9 drücken
   - [ ] iPhone zeigt "Aufnahme läuft" (rot)
   - [ ] 10 Sekunden sprechen
   - [ ] F9 drücken
   - [ ] WAV-Datei prüfen (enthält iPhone-Audio)

3. **Pipeline testen:**
   - [ ] VAD aktivieren
   - [ ] Mit iPhone aufnehmen
   - [ ] Prüfen: speech_only.wav korrekt
   - [ ] Transkription enthält gesprochenen Text

4. **Disconnect testen:**
   - [ ] Während Aufnahme: iPhone Safari schließen
   - [ ] Desktop zeigt Warnung
   - [ ] Aufnahme kann beendet werden

5. **Re-Pairing testen:**
   - [ ] iPhone entkoppeln
   - [ ] Neuen QR-Code generieren
   - [ ] Mit anderem Browser/Gerät scannen
   - [ ] Pairing funktioniert

---

## Deployment

### Railway Audio Relay

```bash
cd railway-audio-relay
git add -A
git commit -m "Update relay server"
git push
# Railway auto-deploys from GitHub
```

### Vercel Backend

```bash
cd saas-starter
git add -A
git commit -m "Update backend"
git push
# Vercel auto-deploys from GitHub
```

---

## Autor & Datum

Erstellt: Januar 2025
Letzte Aktualisierung: 18. Januar 2025

---

## Changelog

### 18. Januar 2025 (v2) - Audio-Optimierung Refactoring

**Grundlegende Änderung der Audio-Strategie:**

1. **iPhone Gain entfernt**
   - `public/audio-worklet-processor.js`: GAIN = 1.25 entfernt
   - iPhone liefert jetzt RAW PCM ohne Verstärkung
   - Alle Audio-Optimierung passiert auf dem Desktop

2. **Quellenbasiertes Auto-Level**
   - `src/audio-converter.js`: `autoLevel()` akzeptiert jetzt `{ source: 'iphone' | 'mic' }`
   - iPhone: IMMER `loudnorm` (I=-16, LRA=11, TP=-1.5)
   - Mic: RMS-basierte Entscheidung (loudnorm / mild_gain / none)

3. **Pipeline-Integration**
   - `src/pipeline/index.js`: `processFileWithVAD()` akzeptiert jetzt `{ source }`
   - `main.js`: `processAudioFile()` und `processFileWithVAD()` geben Quelle weiter
   - iPhone-Aufnahmen werden mit `source: 'iphone'` verarbeitet

4. **Filter vereinfacht**
   - `src/audio-converter.js`: `convertToWav16k()` hat keine Filter mehr (highpass/alimiter entfernt)
   - Nur noch Auto-Level (zentral, quellenabhängig)
   - Bandpass (200-3000 Hz) nur vor AssemblyAI

**Ergebnis:**
- ✅ iPhone klingt IMMER verständlich (loudnorm)
- ✅ Gute Mics bleiben unangetastet (none bei RMS > -28)
- ✅ Schlechte Aufnahmen werden gerettet (loudnorm/mild_gain)
- ✅ Support & Debugging trivial (klares Logging)

### 18. Januar 2025 (v1)

1. **"Zum Home-Bildschirm hinzufügen" Prompt**
   - Overlay auf iOS beim ersten "Bereit"-Status
   - Verbessert Stabilität (PWA-Modus)

2. **Mikrofonquelle in Settings speichern (Bugfix)**
   - `microphoneSource` wird jetzt korrekt persistiert

3. **Audio-Level für VAD-Aufnahmen**
   - Glow-Animation im Status-Overlay für alle Aufnahme-Modi
