export function attachTelemetry(page, evidence) {
  page.on('console', msg => {
    if (['error', 'warning'].includes(msg.type())) {
      evidence.event('console', {
        level: msg.type(),
        text: msg.text(),
        url: page.url(),
      });
    }
  });

  page.on('response', async response => {
    const event = {
      type: 'response',
      status: response.status(),
      url: response.url(),
      method: response.request().method(),
    };
    evidence.api(event);

    if (response.status() >= 400) {
      let body = '';
      try {
        body = (await response.text()).slice(0, 2000);
      } catch {
        body = '[unavailable]';
      }
      evidence.event('http_error', { ...event, body });
    }
  });

  page.on('requestfailed', request => {
    const event = {
      type: 'request_failed',
      url: request.url(),
      method: request.method(),
      failure: request.failure()?.errorText || '',
    };
    evidence.api(event);
    evidence.event('request_failed', event);
  });

  page.on('pageerror', err => {
    evidence.event('pageerror', {
      message: err.message,
      stack: err.stack,
      url: page.url(),
    });
  });
}

export function assertNoBadApiResponses(evidence, label) {
  const bad = evidence.apiEvents.filter(event => {
    if (event.type === 'request_failed') return true;
    return event.type === 'response' && event.status >= 400;
  });

  const passed = bad.length === 0;
  evidence.event('api_assertion', { label, badCount: bad.length, bad, passed });
  return { passed, bad };
}

export function assertNoConsoleErrors(evidence, label) {
  const bad = evidence.events.filter(event => event.type === 'console' && event.level === 'error');
  const passed = bad.length === 0;
  evidence.event('console_assertion', { label, badCount: bad.length, bad, passed });
  return { passed, bad };
}
