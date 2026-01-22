/**
 * Convert SVG icons to PNG and ICO
 * Run: npm install sharp png-to-ico --save-dev && node scripts/convert-icons.js
 */

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const assetsDir = path.join(__dirname, '..', 'assets');

// Tray icons (32x32)
const trayIcons = [
  { svg: 'tray-icon.svg', png: 'tray-icon.png', size: 32 },
  { svg: 'tray-icon-recording.svg', png: 'tray-icon-recording.png', size: 32 }
];

// App icon (multiple sizes for ICO)
const appIcon = { svg: 'icon.svg', png: 'icon.png', size: 256 };
const icoSizes = [16, 32, 48, 256];

async function convertIcons() {
  // Convert tray icons
  for (const icon of trayIcons) {
    const svgPath = path.join(assetsDir, icon.svg);
    const pngPath = path.join(assetsDir, icon.png);

    if (!fs.existsSync(svgPath)) {
      console.log(`Skipping ${icon.svg} - not found`);
      continue;
    }

    await sharp(svgPath)
      .resize(icon.size, icon.size)
      .png()
      .toFile(pngPath);

    console.log(`✓ ${icon.svg} → ${icon.png} (${icon.size}x${icon.size})`);
  }

  // Convert app icon to PNG
  const svgPath = path.join(assetsDir, appIcon.svg);
  const pngPath = path.join(assetsDir, appIcon.png);

  if (fs.existsSync(svgPath)) {
    await sharp(svgPath)
      .resize(appIcon.size, appIcon.size)
      .png()
      .toFile(pngPath);

    console.log(`✓ ${appIcon.svg} → ${appIcon.png} (${appIcon.size}x${appIcon.size})`);

    // Generate ICO with multiple sizes
    try {
      const toIco = require('to-ico');

      // Create PNG buffers for each size
      const pngBuffers = [];
      for (const size of icoSizes) {
        const buffer = await sharp(svgPath)
          .resize(size, size)
          .png()
          .toBuffer();
        pngBuffers.push(buffer);
      }

      // Convert to ICO
      const icoBuffer = await toIco(pngBuffers);
      fs.writeFileSync(path.join(assetsDir, 'icon.ico'), icoBuffer);
      console.log(`✓ icon.svg → icon.ico (${icoSizes.join(', ')}px)`);
    } catch (e) {
      console.log(`⚠ ICO conversion failed: ${e.message}`);
    }
  }

  console.log('\nDone!');
}

convertIcons().catch(console.error);
