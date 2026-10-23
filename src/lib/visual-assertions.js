import sharp from 'sharp';

async function rawRegion(file, clip = null) {
  let image = sharp(file);
  if (clip) {
    image = image.extract({
      left: Math.max(0, Math.round(clip.x)),
      top: Math.max(0, Math.round(clip.y)),
      width: Math.max(1, Math.round(clip.width)),
      height: Math.max(1, Math.round(clip.height)),
    });
  }
  return image.resize(96, 96).grayscale().raw().toBuffer();
}

export async function imageDelta(before, after, clip = null) {
  const beforeBuffer = await rawRegion(before, clip);
  const afterBuffer = await rawRegion(after, clip);
  let changedPixels = 0;
  let totalDelta = 0;

  for (let i = 0; i < beforeBuffer.length; i++) {
    const delta = Math.abs(beforeBuffer[i] - afterBuffer[i]);
    totalDelta += delta;
    if (delta > 8) changedPixels++;
  }

  return {
    changedPixels,
    totalPixels: beforeBuffer.length,
    changedRatio: changedPixels / beforeBuffer.length,
    meanDelta: totalDelta / beforeBuffer.length,
  };
}

export async function assertScreenChanged({ before, after, label, clip = null, evidence, threshold = 0.005 }) {
  const delta = await imageDelta(before, after, clip);
  const changed = delta.changedRatio >= threshold;

  evidence.event('screen_change_assertion', {
    label,
    changed,
    threshold,
    before,
    after,
    clip,
    delta,
  });

  return { changed, delta };
}
