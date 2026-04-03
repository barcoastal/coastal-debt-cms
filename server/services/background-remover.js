// server/services/background-remover.js

const fs = require('fs');
const path = require('path');

const uploadsDir = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'uploads')
  : path.join(__dirname, '..', '..', 'public', 'uploads');

async function removeBackground(inputImagePath) {
  // Dynamic import for ESM module
  const { removeBackground: removeBg } = await import('@imgly/background-removal-node');

  // Read the input image
  const absolutePath = inputImagePath.startsWith('/')
    ? inputImagePath
    : path.join(uploadsDir, inputImagePath);

  const imageBuffer = fs.readFileSync(absolutePath);
  const blob = new Blob([imageBuffer], { type: 'image/png' });

  // Remove background
  const resultBlob = await removeBg(blob, {
    output: { format: 'image/png' }
  });

  // Save as new file
  const resultBuffer = Buffer.from(await resultBlob.arrayBuffer());
  const baseName = path.basename(absolutePath, path.extname(absolutePath));
  const outputFilename = `${baseName}-nobg-${Date.now()}.png`;
  const outputPath = path.join(uploadsDir, outputFilename);
  fs.writeFileSync(outputPath, resultBuffer);

  return {
    file_path: outputPath,
    url: `/lp/uploads/${outputFilename}`
  };
}

module.exports = { removeBackground };
