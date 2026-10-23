import { findTextTarget } from './ocr.js';
import { assertScreenChanged } from './visual-assertions.js';

export async function markClick(page, x, y, label) {
  await page.evaluate(
    ({ x, y, label }) => {
      document.querySelectorAll('[data-click-marker]').forEach(element => element.remove());

      const marker = document.createElement('div');
      marker.textContent = '+';
      marker.title = label;
      marker.style.position = 'fixed';
      marker.style.left = `${x - 10}px`;
      marker.style.top = `${y - 10}px`;
      marker.style.width = '20px';
      marker.style.height = '20px';
      marker.style.background = '#d00000';
      marker.style.color = 'white';
      marker.style.zIndex = '999999';
      marker.style.fontSize = '18px';
      marker.style.lineHeight = '20px';
      marker.style.textAlign = 'center';
      marker.style.borderRadius = '50%';
      marker.style.pointerEvents = 'none';
      marker.setAttribute('data-click-marker', label);
      document.body.appendChild(marker);
    },
    { x, y, label }
  );
}

export async function clearClickMarker(page) {
  await page.evaluate(() => {
    document.querySelectorAll('[data-click-marker]').forEach(element => element.remove());
  }).catch(() => {});
}

export async function clickAt({ page, evidence, label, x, y }) {
  await markClick(page, x, y, label);
  await evidence.screenshot(page, `${label}-click-marker`);

  evidence.event('visual_click', { label, x, y, url: page.url() });
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(120);
  await page.mouse.up();
  await clearClickMarker(page);
  await page.waitForTimeout(2500);
}

export async function clickByOcr({
  page,
  worker,
  evidence,
  ocrImage,
  name,
  labels,
  fallback,
  regionForDiff = null,
  expectScreenChange = true,
  retryCount = 2,
  targetRegion = null,
}) {
  console.log(`OCR click: ${name}`);
  const before = await evidence.screenshot(page, `${name}-before`);
  let target = null;

  for (let attempt = 1; attempt <= retryCount; attempt++) {
    const shot = attempt === 1 ? before : await evidence.screenshot(page, `${name}-retry-${attempt}`);
    const ocr = await ocrImage(worker, shot, evidence);
    const words = targetRegion ? ocr.words.filter(word => isWordInRegion(word, targetRegion)) : ocr.words;
    target = findTextTarget(words, labels);

    evidence.event('ocr_target_search', {
      name,
      attempt,
      labels,
      found: Boolean(target),
      target,
    });

    if (target) break;
    await page.waitForTimeout(1000);
  }

  let clickPoint;
  let targetSource = 'ocr';
  if (target) {
    clickPoint = target.center;
  } else if (fallback) {
    clickPoint = fallback;
    targetSource = 'fallback';
    evidence.event('ocr_fallback_used', { name, labels, fallback });
  } else {
    evidence.event('ocr_click_skipped', { name, labels, reason: 'no target and no fallback' });
    return { clicked: false, changed: false, target: null, targetSource: null };
  }

  await clickAt({ page, evidence, label: name, x: clickPoint.x, y: clickPoint.y });
  await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1500);

  const after = await evidence.screenshot(page, `${name}-after`);
  let screenChange = null;
  if (expectScreenChange) {
    screenChange = await assertScreenChanged({
      before,
      after,
      label: name,
      clip: regionForDiff,
      evidence,
    });
  }

  return {
    clicked: true,
    changed: screenChange?.changed ?? null,
    target,
    targetSource,
    before,
    after,
    clickPoint,
  };
}

function isWordInRegion(word, region) {
  const center = {
    x: (word.bbox.x0 + word.bbox.x1) / 2,
    y: (word.bbox.y0 + word.bbox.y1) / 2,
  };
  return (
    center.x >= region.x &&
    center.x <= region.x + region.width &&
    center.y >= region.y &&
    center.y <= region.y + region.height
  );
}

export async function typeText({ page, evidence, label, value }) {
  evidence.event('keyboard_type', { label, value, url: page.url() });
  await page.keyboard.type(value);
  await page.waitForTimeout(2000);
}
