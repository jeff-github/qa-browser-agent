import crypto from 'crypto';

function emailFingerprint(email) {
  if (!email) return null;
  return crypto.createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 16);
}

async function fillFirstVisible(locator, value) {
  const count = await locator.count().catch(() => 0);
  for (let index = 0; index < count; index++) {
    const candidate = locator.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    await candidate.fill(value, { timeout: 5000 });
    return true;
  }
  return false;
}

async function clickFirstVisible(locator) {
  const count = await locator.count().catch(() => 0);
  for (let index = 0; index < count; index++) {
    const candidate = locator.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    await candidate.click({ timeout: 5000 });
    return true;
  }
  return false;
}

async function attemptDomLogin({ page, email, password }) {
  const emailFilled = await fillFirstVisible(
    page.locator('input[type="email"], input[name*="email" i], input[autocomplete="username"], input').first(),
    email
  );

  const passwordFilled = await fillFirstVisible(
    page.locator('input[type="password"], input[autocomplete="current-password"]'),
    password
  );

  if (!emailFilled || !passwordFilled) {
    return { attempted: true, submitted: false, reason: 'visible email/password inputs not found' };
  }

  const submitted = await clickFirstVisible(
    page.locator('button[type="submit"], input[type="submit"], text=/sign in|log in|continue/i')
  );

  if (!submitted) {
    await page.keyboard.press('Enter');
  }

  return { attempted: true, submitted: true, strategy: 'dom-inputs' };
}

async function attemptVisualLogin({ page, email, password, evidence }) {
  const viewport = page.viewportSize() || { width: 1440, height: 1000 };
  const points = {
    email: { x: Math.round(viewport.width * 0.5), y: Math.round(viewport.height * 0.488) },
    password: { x: Math.round(viewport.width * 0.5), y: Math.round(viewport.height * 0.552) },
    submit: { x: Math.round(viewport.width * 0.5), y: Math.round(viewport.height * 0.66) },
  };

  evidence.event('credential_login_visual_fallback_started', {
    strategy: 'viewport-relative-coordinates',
    points,
  });

  await page.mouse.click(points.email.x, points.email.y);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.type(email);
  await page.waitForTimeout(300);

  await page.mouse.click(points.password.x, points.password.y);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.type(password);
  await page.waitForTimeout(300);

  await page.mouse.click(points.submit.x, points.submit.y);

  return { attempted: true, submitted: true, strategy: 'visual-coordinate-login', points };
}

export async function completeOtpLogin({ page, otp, evidence }) {
  if (!otp) return { attempted: false, authenticated: false };

  const viewport = page.viewportSize() || { width: 1440, height: 1000 };
  const points = {
    otp: { x: Math.round(viewport.width * 0.5), y: Math.round(viewport.height * 0.506) },
    verify: { x: Math.round(viewport.width * 0.5), y: Math.round(viewport.height * 0.578) },
  };

  evidence.event('otp_verification_started', {
    strategy: 'viewport-relative-coordinates',
    otpProvided: true,
    points,
  });

  await page.mouse.click(points.otp.x, points.otp.y);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.type(String(otp));
  await page.waitForTimeout(300);
  await page.mouse.click(points.verify.x, points.verify.y);
  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(3000);

  const state = await classifyLoginState(page);
  evidence.event('otp_verification_completed', {
    attempted: true,
    currentUrl: state.currentUrl,
    stillOtp: state.requiresOtp,
    authenticated: state.authenticated,
  });

  return { attempted: true, ...state };
}

export async function attemptCredentialLogin({ page, evidence, config }) {
  if (!config.loginEmail || !config.loginPassword) {
    evidence.event('credential_login_skipped', { reason: 'missing credentials' });
    return { attempted: false, authenticated: false };
  }

  evidence.event('credential_login_started', {
    emailFingerprint: emailFingerprint(config.loginEmail),
    passwordProvided: true,
  });

  await page.waitForTimeout(3000);
  const before = await evidence.screenshot(page, 'credential-login-before');
  let result = await attemptDomLogin({
    page,
    email: config.loginEmail,
    password: config.loginPassword,
  }).catch(error => ({
    attempted: true,
    submitted: false,
    reason: error.message,
  }));

  if (!result.submitted) {
    result = await attemptVisualLogin({
      page,
      email: config.loginEmail,
      password: config.loginPassword,
      evidence,
    }).catch(error => ({
      attempted: true,
      submitted: false,
      strategy: 'visual-coordinate-login',
      reason: error.message,
    }));
  }

  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(3000);
  let state = await classifyLoginState(page);
  let otpResult = null;
  if (state.requiresOtp && config.loginOtp) {
    otpResult = await completeOtpLogin({ page, otp: config.loginOtp, evidence });
    state = await classifyLoginState(page);
  }

  const canCaptureAfter = state.authenticated || (state.requiresOtp && !otpResult?.attempted);
  const after = canCaptureAfter ? await evidence.screenshot(page, 'credential-login-after') : null;

  evidence.event('credential_login_completed', {
    ...result,
    otpAttempted: Boolean(otpResult?.attempted),
    before,
    after,
    ...state,
  });

  return { ...result, ...state, otpAttempted: Boolean(otpResult?.attempted) };
}

async function classifyLoginState(page) {
  const currentUrl = page.url();
  const bodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
  const combined = `${currentUrl}\n${bodyText}`;
  const requiresOtp = /email-otp|otp|verification code|check your email|two[- ]?factor|mfa/i.test(combined);
  const stillLogin = /\/login|sign in|log in|password/i.test(combined);
  const authenticated = !requiresOtp && !stillLogin;
  return { currentUrl, requiresOtp, stillLogin, authenticated };
}
