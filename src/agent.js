import 'dotenv/config';
import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import minimist from 'minimist';
import OpenAI from 'openai';

const args = minimist(process.argv.slice(2));

const baseUrl = args.baseUrl || process.env.BASE_URL || 'http://localhost:3000';
const startPath = args.startPath || process.env.START_PATH || '/login';
const headed = args.headed || process.env.HEADED === 'true';
const goal = args.goal || process.env.AGENT_GOAL || 'Navigate the portal, capture screenshots, detect visible UI/API errors, and produce a QA report.';

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const runDir = path.join('runs', stamp);
const screenshotDir = path.join(runDir, 'screenshots');

await fs.mkdir(screenshotDir, { recursive: true });

const events = [];

function logEvent(type, data = {}) {
  events.push({
    time: new Date().toISOString(),
    type,
    ...data,
  });
}

async function screenshot(page, name) {
  const safeName = String(name).replace(/[^a-z0-9-_]+/gi, '-').toLowerCase();
  const file = path.join(
    screenshotDir,
    `${String(events.length).padStart(3, '0')}-${safeName}.png`
  );

  await page.screenshot({
    path: file,
    fullPage: true,
  });

  logEvent('screenshot', {
    file,
    url: page.url(),
  });

  console.log(`Screenshot saved: ${file}`);
  return file;
}

async function enableFlutterAccessibility(page) {
  const accessibilityButton = page
    .getByRole('button', { name: /enable accessibility/i })
    .first();

  if (await accessibilityButton.isVisible().catch(() => false)) {
    console.log('Enabling Flutter accessibility...');
    await accessibilityButton.click().catch(() => {});
    await page.waitForTimeout(1500);

    logEvent('flutter_accessibility_enabled', {
      url: page.url(),
    });

    return true;
  }

  return false;
}

async function waitForAuthenticatedState(page) {
  console.log('Waiting for authenticated dashboard state...');

  for (let i = 0; i < 30; i++) {
    const currentUrl = page.url();

    const bodyText = await page
      .locator('body')
      .innerText({ timeout: 2000 })
      .catch(() => '');

    const looksLoggedOut =
      /\/login|\/email-otp/i.test(currentUrl) ||
      /sign in|log in|email otp|verification code/i.test(bodyText);

    const looksLoggedIn =
      /study coordinator dashboard|participant summary|participants|audit logs|manage questionnaires/i.test(bodyText) &&
      !looksLoggedOut;

    logEvent('auth_state_check', {
      attempt: i + 1,
      url: currentUrl,
      looksLoggedIn,
      looksLoggedOut,
      bodyTextSample: bodyText.slice(0, 500),
    });

    if (looksLoggedIn) {
      console.log('Authenticated dashboard appears ready.');
      return true;
    }

    await page.waitForTimeout(1000);
  }

  console.log('Authenticated dashboard was not confidently detected. Continuing cautiously.');
  return false;
}

async function dumpDomDebug(page) {
  console.log('===== DOM DEBUG START =====');

  const bodyHtml = await page.locator('body').innerHTML().catch(() => '');
  const bodyText = await page.locator('body').innerText().catch(() => '');

  await fs.writeFile(path.join(runDir, 'body.html'), bodyHtml);
  await fs.writeFile(path.join(runDir, 'body.txt'), bodyText);

  console.log(`Body text length: ${bodyText.length}`);
  console.log(`Body html length: ${bodyHtml.length}`);

  logEvent('dom_debug_dumped', {
    bodyTextLength: bodyText.length,
    bodyHtmlLength: bodyHtml.length,
    bodyHtmlFile: path.join(runDir, 'body.html'),
    bodyTextFile: path.join(runDir, 'body.txt'),
  });

  console.log('===== DOM DEBUG END =====');

  return {
    bodyHtml,
    bodyText,
  };
}

async function testDashboardTargets(page) {
  const navigationTargets = [
    {
      label: 'participants-sidebar',
      locator: page.locator('text=Participants').first(),
    },
    {
      label: 'audit-logs-sidebar',
      locator: page.locator('text=Audit Logs').first(),
    },
    {
      label: 'manage-questionnaires',
      locator: page.locator('text=Manage Questionnaires').first(),
    },
    {
      label: 'actions',
      locator: page.locator('text=Actions').first(),
    },
    {
      label: 'reactivate',
      locator: page.locator('text=Reactivate').first(),
    },
    {
      label: 'search-participants',
      locator: page.locator('input[placeholder*="Search"], textarea[placeholder*="Search"]').first(),
      fill: '840',
    },
  ];

  for (const target of navigationTargets) {
    try {
      const currentUrl = page.url();

      if (/\/login|\/email-otp/i.test(currentUrl)) {
        logEvent('navigation_stopped_logged_out', {
          url: currentUrl,
          attemptedTarget: target.label,
        });

        console.log(`Stopped navigation because app appears logged out: ${currentUrl}`);
        break;
      }

      console.log(`Attempting target: ${target.label}`);

      const count = await target.locator.count();

      console.log(`Locator count for ${target.label}: ${count}`);

      logEvent('locator_count', {
        label: target.label,
        count,
        url: page.url(),
      });

      if (count === 0) {
        logEvent('target_not_found', {
          label: target.label,
          url: page.url(),
        });
        continue;
      }

      await target.locator.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(1000);

      if (target.fill) {
        await target.locator.fill(target.fill, {
          timeout: 10000,
        });

        logEvent('fill_success', {
          label: target.label,
          value: target.fill,
          url: page.url(),
        });
      } else {
        await target.locator.click({
          force: true,
          timeout: 10000,
        });

        logEvent('click_success', {
          label: target.label,
          url: page.url(),
        });
      }

      console.log(`Completed target: ${target.label}`);

      await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(3000);

      await screenshot(page, target.label);

    } catch (err) {
      console.log(`FAILED TARGET: ${target.label}`);
      console.log(err.message);

      logEvent('target_failed', {
        label: target.label,
        message: err.message,
        url: page.url(),
      });
    }
  }
}

async function analyzeWithOpenAI({ pageText, url, screenshotPath }) {
  if (process.env.ENABLE_AI_ANALYSIS !== 'true' || !process.env.OPENAI_API_KEY) {
    return 'OpenAI analysis skipped: explicit opt-in and API key required.';
  }

  const client = new OpenAI();

  const prompt = `
You are a senior QA automation engineer for a regulated clinical trial portal.

Goal:
${goal}

URL:
${url}

Analyze this visible page text and event context.

Return:
1. likely bugs
2. missing assertions
3. next pages/buttons to test
4. suggested Playwright checks

Visible text:
${pageText.slice(0, 12000)}

Screenshot path:
${screenshotPath}
`;

  const response = await client.responses.create({
    model: process.env.OPENAI_MODEL || 'gpt-5.2',
    input: prompt,
  });

  return response.output_text;
}

const browser = await chromium.launch({
  headless: !headed,
});

const context = await browser.newContext({
  viewport: {
    width: 1440,
    height: 1000,
  },
  ignoreHTTPSErrors: true,
  recordVideo: {
    dir: path.join(runDir, 'videos'),
  },
});

await context.tracing.start({
  screenshots: true,
  snapshots: true,
  sources: true,
});

const page = await context.newPage();

page.on('console', msg => {
  if (['error', 'warning'].includes(msg.type())) {
    logEvent('console', {
      level: msg.type(),
      text: msg.text(),
      url: page.url(),
    });
  }
});

page.on('response', async response => {
  const status = response.status();

  if (status >= 400) {
    let body = '';

    try {
      body = (await response.text()).slice(0, 2000);
    } catch {}

    logEvent('http_error', {
      status,
      url: response.url(),
      body,
    });
  }
});

page.on('requestfailed', request => {
  logEvent('request_failed', {
    url: request.url(),
    method: request.method(),
    failure: request.failure()?.errorText || '',
  });
});

page.on('pageerror', err => {
  logEvent('pageerror', {
    message: err.message,
    stack: err.stack,
    url: page.url(),
  });
});

const rl = readline.createInterface({
  input,
  output,
});

try {
  const startUrl = new URL(startPath, baseUrl).toString();

  console.log(`Opening: ${startUrl}`);

  await page.goto(startUrl, {
    waitUntil: 'domcontentloaded',
  });

  await page.waitForLoadState('networkidle', {
    timeout: 15000,
  }).catch(() => {});

  await enableFlutterAccessibility(page);
  await screenshot(page, 'login-or-start');

  console.log('\nBrowser opened.');
  console.log('Log in manually in the browser. Do NOT paste credentials into terminal/chat.');

  await rl.question('Press Enter here after login is complete...');

  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(3000);

  await enableFlutterAccessibility(page);
  await screenshot(page, 'after-login-before-auth-check');

  await waitForAuthenticatedState(page);

  await screenshot(page, 'authenticated-start');

  const { bodyText } = await dumpDomDebug(page);

  await testDashboardTargets(page);

  const finalBodyText = await page.locator('body').innerText().catch(() => bodyText || '');
  const lastShot = await screenshot(page, 'final');

  const aiAnalysis = await analyzeWithOpenAI({
    pageText: finalBodyText,
    url: page.url(),
    screenshotPath: lastShot,
  });

  await fs.writeFile(
    path.join(runDir, 'events.json'),
    JSON.stringify(events, null, 2)
  );

  const report = `# QA Browser Agent Report

Run:
${stamp}

Base URL:
${baseUrl}

Goal:
${goal}

## Summary

- Screenshots captured: ${events.filter(e => e.type === 'screenshot').length}
- Console warnings/errors: ${events.filter(e => e.type === 'console').length}
- Request failures: ${events.filter(e => e.type === 'request_failed').length}
- HTTP errors: ${events.filter(e => e.type === 'http_error').length}
- Page errors: ${events.filter(e => e.type === 'pageerror').length}
- Auth state checks: ${events.filter(e => e.type === 'auth_state_check').length}
- Locator counts captured: ${events.filter(e => e.type === 'locator_count').length}
- Targets not found: ${events.filter(e => e.type === 'target_not_found').length}
- Target failures: ${events.filter(e => e.type === 'target_failed').length}
- Click successes: ${events.filter(e => e.type === 'click_success').length}
- Fill successes: ${events.filter(e => e.type === 'fill_success').length}

## DOM Debug

- Body HTML: \`${path.join(runDir, 'body.html')}\`
- Body Text: \`${path.join(runDir, 'body.txt')}\`

## AI Analysis

${aiAnalysis}

## Notable Events

\`\`\`json
${JSON.stringify(events.filter(e => e.type !== 'screenshot'), null, 2)}
\`\`\`

## Artifacts

- Screenshots: \`${screenshotDir}\`
- Trace: \`${path.join(runDir, 'trace.zip')}\`
- Raw events: \`${path.join(runDir, 'events.json')}\`
`;

  await fs.writeFile(path.join(runDir, 'report.md'), report);

  console.log(`\nDone. Report: ${path.join(runDir, 'report.md')}`);
} finally {
  await context.tracing.stop({
    path: path.join(runDir, 'trace.zip'),
  }).catch(() => {});

  await context.close().catch(() => {});
  await browser.close().catch(() => {});
  rl.close();
}
