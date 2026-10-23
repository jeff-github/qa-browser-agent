export function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export async function ocrImage(worker, imagePath, evidence) {
  const result = await worker.recognize(imagePath, {}, { blocks: true });
  const text = result.data.text || '';
  const words = extractWords(result.data)
    .filter(word => word.text && word.bbox)
    .map(word => ({
      text: word.text,
      confidence: word.confidence ?? 0,
      bbox: word.bbox,
    }));

  evidence?.event('ocr_complete', {
    imagePath,
    textLength: text.length,
    wordCount: words.length,
    sample: text.slice(0, 1000),
  });

  return { text, words };
}

function extractWords(data) {
  if (Array.isArray(data.words)) return data.words;

  const words = [];
  const visitLine = line => {
    if (Array.isArray(line?.words)) words.push(...line.words);
  };
  const visitParagraph = paragraph => {
    if (Array.isArray(paragraph?.lines)) paragraph.lines.forEach(visitLine);
  };
  const visitBlock = block => {
    if (Array.isArray(block?.paragraphs)) block.paragraphs.forEach(visitParagraph);
  };

  if (Array.isArray(data.blocks)) data.blocks.forEach(visitBlock);
  return words;
}

export function findWordSequence(words, target) {
  const targetParts = normalizeText(target).split(' ').filter(Boolean);
  if (targetParts.length === 0) return null;

  const normalizedWords = words.map(word => normalizeText(word.text));

  for (let i = 0; i <= normalizedWords.length - targetParts.length; i++) {
    const exact = targetParts.every((part, index) => normalizedWords[i + index] === part);
    if (!exact) continue;

    const matched = words.slice(i, i + targetParts.length);
    const left = Math.min(...matched.map(word => word.bbox.x0));
    const top = Math.min(...matched.map(word => word.bbox.y0));
    const right = Math.max(...matched.map(word => word.bbox.x1));
    const bottom = Math.max(...matched.map(word => word.bbox.y1));
    const confidence = matched.reduce((sum, word) => sum + word.confidence, 0) / matched.length;

    return {
      target,
      text: matched.map(word => word.text).join(' '),
      confidence,
      bbox: { x0: left, y0: top, x1: right, y1: bottom },
      center: {
        x: Math.round((left + right) / 2),
        y: Math.round((top + bottom) / 2),
      },
    };
  }

  return null;
}

export function findTextTarget(words, labels) {
  for (const label of labels) {
    const found = findWordSequence(words, label);
    if (found) return { ...found, strategy: 'exact-sequence' };
  }

  for (const label of labels) {
    const labelNorm = normalizeText(label);
    const partial = words.find(word => {
      const wordNorm = normalizeText(word.text);
      return wordNorm.length > 2 && (labelNorm.includes(wordNorm) || wordNorm.includes(labelNorm));
    });

    if (!partial) continue;

    return {
      target: label,
      text: partial.text,
      confidence: partial.confidence,
      bbox: partial.bbox,
      center: {
        x: Math.round((partial.bbox.x0 + partial.bbox.x1) / 2),
        y: Math.round((partial.bbox.y0 + partial.bbox.y1) / 2),
      },
      strategy: 'partial-word',
    };
  }

  return null;
}

export async function verifyScreenByOcr({ worker, screenshotPath, label, shouldContain = [], shouldNotContain = [], evidence }) {
  const { text } = await ocrImage(worker, screenshotPath, evidence);
  const normalized = normalizeText(text);
  const missing = shouldContain.filter(item => !normalized.includes(normalizeText(item)));
  const forbiddenFound = shouldNotContain.filter(item => normalized.includes(normalizeText(item)));
  const passed = missing.length === 0 && forbiddenFound.length === 0;

  evidence.event('ocr_assertion', {
    label,
    shouldContain,
    shouldNotContain,
    missing,
    forbiddenFound,
    passed,
    textSample: text.slice(0, 1500),
  });

  return { text, passed, missing, forbiddenFound };
}
