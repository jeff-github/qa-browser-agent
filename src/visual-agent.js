import 'dotenv/config';
import { chromium } from 'playwright';
import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import path from 'path';
import fs from 'fs/promises';
import { createWorker } from 'tesseract.js';
import { loadConfig, resolveStartUrl } from './lib/config.js';
import { EvidenceStore } from './lib/evidence-store.js';
import { attachTelemetry, assertNoBadApiResponses } from './lib/telemetry.js';
import { verifyScreenByOcr } from './lib/ocr.js';
import { createClinicalWorkflow } from './lib/workflow-definition.js';
import { WorkflowRunner } from './lib/workflow-runner.js';
import { buildReport } from './lib/reporting.js';
import { attemptCredentialLogin, completeOtpLogin } from './lib/login.js';

const config = loadConfig();
const evidence = new EvidenceStore(config);
await evidence.init();

const browser = await chromium.launch({ headless: !config.headed });
const context = await browser.newContext({
  viewport: config.viewport,
  ignoreHTTPSErrors: true,
  recordVideo: { dir: path.join(config.runDir, 'videos') },
});

await context.tracing.start({ screenshots: true, snapshots: true, sources: true });

const page = await context.newPage();
attachTelemetry(page, evidence);

const rl = readline.createInterface({ input, output });
const worker = await createWorker('eng');

let exitCode = 0;

try {
  const startUrl = resolveStartUrl(config);
  console.log(`Opening: ${startUrl}`);
  evidence.event('run_started', {
    baseUrl: config.baseUrl,
    startPath: config.startPath,
    viewport: config.viewport,
  });

  await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await evidence.screenshot(page, 'login-start');

  let loginResult = await attemptCredentialLogin({ page, evidence, config });

  if (!loginResult.authenticated && loginResult.requiresOtp && !loginResult.otpAttempted && config.waitForOtp) {
    const otpSendFailure = latestOtpSendFailure(evidence);
    if (otpSendFailure) {
      loginResult = {
        ...loginResult,
        reason: `OTP send failed with HTTP ${otpSendFailure.status}`,
        otpSendFailure,
      };
    } else {
      const otp = await waitForOtp({ rl, config, evidence });
      loginResult = {
        ...loginResult,
        ...(await completeOtpLogin({ page, otp, evidence })),
        otpAttempted: true,
      };
    }
  }

  if (!loginResult.authenticated && config.manualAuth) {
    console.log('\nLog in manually in the browser.');
    console.log('Do not paste credentials into terminal or chat.');
    if (loginResult.requiresOtp) {
      console.log('The portal appears to require an OTP or verification code.');
    }
    await rl.question('Press Enter here after login is complete...');
  }

  if (!loginResult.authenticated && !config.manualAuth) {
    const workflowResult = {
      passed: false,
      failures: [
        {
          label: 'credential-login',
          failureType: loginResult.requiresOtp ? 'otp-required' : 'authentication',
          reason: loginResult.reason || 'credential login did not reach an authenticated screen',
        },
      ],
    };

    await context.tracing.stop({ path: path.join(config.runDir, 'trace.zip') }).catch(() => {});
    await evidence.registerArtifact(path.join(config.runDir, 'trace.zip'), 'playwright-trace').catch(() => {});
    const report = buildReport({ config, evidence, workflowResult, finalShot: null });
    await evidence.writeText('report.md', report, 'report');
    await evidence.finalize({ workflowResult });
    console.log(`\nDone. Report: ${path.join(config.runDir, 'report.md')}`);
    throw new Error('Credential login did not authenticate; workflow stopped before collecting post-login evidence.');
  }

  await page.waitForTimeout(3000);

  const authenticatedShot = await evidence.screenshot(page, 'authenticated-dashboard');
  const authOcr = await verifyScreenByOcr({
    worker,
    screenshotPath: authenticatedShot,
    label: 'authenticated-dashboard',
    shouldContain: ['Participants'],
    shouldNotContain: ['bad gateway', 'internal server error', 'stack trace'],
    evidence,
  });

  if (!authOcr.passed) {
    evidence.event('workflow_precondition_failed', {
      label: 'authenticated-dashboard',
      missing: authOcr.missing,
      forbiddenFound: authOcr.forbiddenFound,
    });
  }

  const initialApi = assertNoBadApiResponses(evidence, 'authenticated-dashboard');
  const runner = new WorkflowRunner({ page, worker, evidence, config });
  const workflow = createClinicalWorkflow({ searchValue: config.searchValue });
  const workflowResult = await runner.run(workflow);

  if (!initialApi.passed && config.failOnApiError) {
    workflowResult.failures.unshift({ label: 'authenticated-dashboard', failureType: 'api', api: initialApi });
    workflowResult.passed = false;
  }

  const finalShot = await evidence.screenshot(page, 'final');
  await context.tracing.stop({ path: path.join(config.runDir, 'trace.zip') }).catch(() => {});
  await evidence.registerArtifact(path.join(config.runDir, 'trace.zip'), 'playwright-trace').catch(() => {});

  const report = buildReport({ config, evidence, workflowResult, finalShot });
  await evidence.writeText('report.md', report, 'report');
  await evidence.finalize({ workflowResult });

  console.log(`\nDone. Report: ${path.join(config.runDir, 'report.md')}`);
  if (!workflowResult.passed) {
    exitCode = 1;
    console.log(`Workflow completed with ${workflowResult.failures.length} failure(s).`);
  }
} finally {
  await worker.terminate().catch(() => {});
  await context.tracing.stop({ path: path.join(config.runDir, 'trace.zip') }).catch(() => {});
  await context.close().catch(() => {});
  await browser.close().catch(() => {});
  rl.close();
}

process.exitCode = exitCode;

async function waitForOtp({ rl, config, evidence }) {
  evidence.event('otp_wait_started', {
    otpFile: config.otpFile,
    timeoutMs: config.otpTimeoutMs,
    stdinInteractive: Boolean(process.stdin.isTTY),
  });

  if (process.stdin.isTTY) {
    const otp = await rl.question('Enter the fresh email OTP for this login session: ');
    evidence.event('otp_received', { source: 'terminal', length: otp.trim().length });
    return otp.trim();
  }

  console.log(`Waiting for OTP file: ${config.otpFile}`);
  console.log('Write the fresh code into that file to continue this browser session.');

  const deadline = Date.now() + config.otpTimeoutMs;
  while (Date.now() < deadline) {
    const otp = await fs.readFile(config.otpFile, 'utf8').catch(() => '');
    const trimmed = otp.trim();
    if (trimmed) {
      await fs.rm(config.otpFile, { force: true }).catch(() => {});
      evidence.event('otp_received', { source: 'file', length: trimmed.length });
      return trimmed;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  evidence.event('otp_wait_timed_out', {
    otpFile: config.otpFile,
    timeoutMs: config.otpTimeoutMs,
  });
  throw new Error(`Timed out waiting for OTP file: ${config.otpFile}`);
}

function latestOtpSendFailure(evidence) {
  return evidence.events
    .filter(event => event.type === 'http_error' && event.url?.includes('/api/v1/portal/auth/send-otp'))
    .at(-1) || null;
}
