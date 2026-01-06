# 🚀 DentDoc Auto-Update Guide

## Setup (Einmalig)

### 1. GitHub Repository erstellen

1. Gehe zu [GitHub](https://github.com/new)
2. **Repository Name**: `dentdoc-desktop`
3. **Visibility**: **Private** ✅
4. Erstelle das Repository

### 2. GitHub Personal Access Token erstellen

1. Gehe zu: https://github.com/settings/tokens
2. Klicke **"Generate new token"** → **"Generate new token (classic)"**
3. **Name**: `DentDoc Auto-Update`
4. **Expiration**: `No expiration`
5. **Scopes** auswählen:
   - ✅ `repo` (Full control of private repositories)
6. Klicke **"Generate token"**
7. **WICHTIG**: Kopiere den Token und speichere ihn sicher!

### 3. Token als Umgebungsvariable setzen

**Windows (PowerShell als Administrator)**:
```powershell
# Temporär (nur für aktuelle Session)
$env:GH_TOKEN="dein_github_token_hier"

# ODER Permanent (empfohlen):
[System.Environment]::SetEnvironmentVariable('GH_TOKEN', 'dein_github_token_hier', 'User')
```

**Überprüfen**:
```powershell
echo $env:GH_TOKEN
```

### 4. package.json anpassen

Öffne `package.json` und ersetze `YOUR_GITHUB_USERNAME`:

```json
{
  "publish": {
    "provider": "github",
    "owner": "DEIN_GITHUB_USERNAME",  // ← Hier dein GitHub Username
    "repo": "dentdoc-desktop",
    "private": true
  }
}
```

---

## 📦 Neues Update veröffentlichen

### Schritt 1: Version erhöhen

Öffne `package.json` und erhöhe die Version:

```json
{
  "version": "1.0.1"  // Von 1.0.0 → 1.0.1
}
```

**Versioning-Schema**:
- **1.0.0** → **1.0.1**: Bugfix
- **1.0.0** → **1.1.0**: Neue Features
- **1.0.0** → **2.0.0**: Breaking Changes

### Schritt 2: Build erstellen

```bash
npm run build
```

Dies erstellt:
- `dist/DentDoc-Setup-1.0.1.exe`
- `dist/latest.yml`

### Schritt 3: Release auf GitHub erstellen

**Option A: Mit electron-builder (Automatisch)**

```bash
# Build UND publish in einem Schritt
npm run build -- --publish always
```

**Option B: Manuell auf GitHub**

1. Gehe zu: `https://github.com/DEIN_USERNAME/dentdoc-desktop/releases/new`
2. **Tag**: `v1.0.1` (Version MUSS mit package.json übereinstimmen!)
3. **Release title**: `DentDoc v1.0.1`
4. **Description**: Beschreibe die Änderungen
5. **Attach files**:
   - `DentDoc-Setup-1.0.1.exe`
   - `latest.yml`
6. Klicke **"Publish release"**

### Schritt 4: Fertig! 🎉

- Users bekommen automatisch eine Notification
- Update wird im Hintergrund heruntergeladen
- Beim nächsten App-Start wird installiert

---

## 🔍 Troubleshooting

### Problem: "Cannot find module 'electron-updater'"

**Lösung**:
```bash
npm install electron-updater
```

### Problem: "GH_TOKEN not found"

**Lösung**:
```powershell
# Token setzen
$env:GH_TOKEN="dein_github_token"

# Oder in Windows Settings → Umgebungsvariablen
```

### Problem: Update wird nicht gefunden

**Checkliste**:
- ✅ Version in `package.json` erhöht?
- ✅ Tag auf GitHub beginnt mit `v` (z.B. `v1.0.1`)?
- ✅ `latest.yml` und `.exe` hochgeladen?
- ✅ GitHub Token korrekt?

### Problem: "401 Unauthorized"

**Lösung**: GitHub Token ist falsch oder abgelaufen
- Neuen Token erstellen
- `GH_TOKEN` Umgebungsvariable neu setzen

---

## 📝 Beispiel-Workflow

```bash
# 1. Version erhöhen in package.json (z.B. 1.0.0 → 1.0.1)

# 2. Build & Publish
npm run build -- --publish always

# 3. Fertig! Release ist auf GitHub
```

---

## ⚠️ Wichtige Hinweise

1. **NIEMALS** `.exe` Dateien zu Git committen
2. **IMMER** Version in `package.json` erhöhen vor Build
3. **GitHub Token** geheim halten (NICHT in Code committen!)
4. **Private Repository** nutzen um Code zu schützen
5. Users brauchen **KEIN** GitHub Account für Updates

---

## 🔐 Sicherheit

- ✅ Code bleibt privat
- ✅ Updates sind signiert
- ✅ Nur du kannst Releases erstellen
- ✅ Users laden nur .exe, sehen keinen Code
