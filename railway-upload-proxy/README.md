# DentDoc Upload-Proxy

Stream-Proxy für AssemblyAI Upload. **Speichert keine Audio-Daten!**

## Architektur

```
Desktop-App
    │
    └─► Railway Upload-Proxy (/upload)  ←── API-Key hier!
            │
            └─► AssemblyAI /v2/upload (STREAM)
                    │
                    └─► upload_url zurück
```

**Wichtig:**
- Audio wird NICHT gespeichert
- Audio wird NICHT geloggt
- Audio wird direkt durchgestreamt
- AssemblyAI API-Key bleibt auf Railway (nicht im Desktop!)

## Railway Deployment

### 1. Neues Projekt erstellen

1. Gehe zu [railway.app](https://railway.app)
2. "New Project" → "Deploy from GitHub repo"
3. Wähle dieses Repository (oder "Empty Project" → "Add Service" → "GitHub")

### 2. Service konfigurieren

Falls du ein Mono-Repo hast (Desktop + Proxy im gleichen Repo):

1. Klicke auf den Service
2. "Settings" → "Root Directory" → `railway-upload-proxy`

### 3. Environment Variables setzen

In Railway unter "Variables":

```
ASSEMBLYAI_API_KEY=dein_assemblyai_api_key
DENTDOC_AUTH_TOKEN=dein_sicheres_token
```

**Token generieren:**
```bash
openssl rand -hex 32
```

### 4. Deploy

Railway deployed automatisch bei jedem Push zu main.

Die URL wird angezeigt unter "Settings" → "Domains", z.B.:
`dentdoc-upload-proxy.up.railway.app`

## Desktop-App konfigurieren

In der Desktop-App `.env`:

```
UPLOAD_PROXY_URL=https://dentdoc-upload-proxy.up.railway.app
UPLOAD_PROXY_TOKEN=das_gleiche_token_wie_oben
```

## Testen

```bash
# Health Check
curl https://dentdoc-upload-proxy.up.railway.app/health

# Upload (mit echtem Audio-File)
curl -X POST \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @test.wav \
  https://dentdoc-upload-proxy.up.railway.app/upload
```

## Lokale Entwicklung

```bash
cd railway-upload-proxy
npm install

# .env erstellen
cp .env.example .env
# Werte ausfüllen

npm run dev
```

## Kosten

Railway Free Tier: $5 Guthaben/Monat
Bei normalem Nutzung: ~$1-3/Monat
