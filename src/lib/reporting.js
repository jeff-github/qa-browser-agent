export function buildReport({ config, evidence, workflowResult, finalShot }) {
  const events = evidence.events;
  const failedOcrAssertions = events.filter(event => event.type === 'ocr_assertion' && !event.passed);
  const failedApiAssertions = events.filter(event => event.type === 'api_assertion' && !event.passed);
  const failedScreenChanges = events.filter(event => event.type === 'screen_change_assertion' && !event.changed);
  const fallbackUses = events.filter(event => event.type === 'ocr_fallback_used');
  const ocrTargets = events.filter(event => event.type === 'ocr_target_search' && event.found);
  const consoleEvents = events.filter(event => ['console', 'http_error', 'request_failed', 'pageerror'].includes(event.type));

  return `# OCR-Driven Visual Workflow Agent Report

Run:
${config.stamp}

Base URL:
${config.baseUrl}

## Summary

- Workflow passed: ${workflowResult.passed}
- Screenshots captured: ${events.filter(event => event.type === 'screenshot').length}
- Visual clicks: ${events.filter(event => event.type === 'visual_click').length}
- OCR targets found: ${ocrTargets.length}
- OCR fallbacks used: ${fallbackUses.length}
- Failed screen-change assertions: ${failedScreenChanges.length}
- Failed OCR assertions: ${failedOcrAssertions.length}
- Failed API assertions: ${failedApiAssertions.length}
- Console warnings/errors: ${events.filter(event => event.type === 'console').length}
- HTTP errors: ${events.filter(event => event.type === 'http_error').length}
- Request failures: ${events.filter(event => event.type === 'request_failed').length}
- Page errors: ${events.filter(event => event.type === 'pageerror').length}

## Workflow Failures

\`\`\`json
${JSON.stringify(workflowResult.failures, null, 2)}
\`\`\`

## OCR Targets Found

\`\`\`json
${JSON.stringify(ocrTargets, null, 2)}
\`\`\`

## OCR Fallbacks Used

\`\`\`json
${JSON.stringify(fallbackUses, null, 2)}
\`\`\`

## Failed Assertions

\`\`\`json
${JSON.stringify({ failedScreenChanges, failedOcrAssertions, failedApiAssertions }, null, 2)}
\`\`\`

## Console / API Evidence

\`\`\`json
${JSON.stringify(consoleEvents.slice(0, 50), null, 2)}
\`\`\`

## Artifacts

- Screenshots: \`${evidence.screenshotDir}\`
- Trace: \`${evidence.runDir}\\trace.zip\`
- Events: \`${evidence.runDir}\\events.json\`
- API Events: \`${evidence.runDir}\\api-events.json\`
- Manifest: \`${evidence.runDir}\\manifest.json\`
- Final Screenshot: \`${finalShot}\`
`;
}
