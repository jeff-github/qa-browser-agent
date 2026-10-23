import path from 'path';
import minimist from 'minimist';

export function loadConfig(argv = process.argv.slice(2), env = process.env) {
  const args = minimist(argv);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const baseUrl = args.baseUrl || env.BASE_URL || 'http://localhost:3000';
  const startPath = args.startPath || env.START_PATH || '/login';
  const headed = readBoolean(args.headed, env.HEADED, false);
  const runName = args.runName || env.RUN_NAME || `ocr-visual-${stamp}`;

  return {
    baseUrl,
    startPath,
    headed,
    stamp,
    runDir: path.join('runs', runName),
    viewport: {
      width: Number(args.viewportWidth || env.VIEWPORT_WIDTH || 1440),
      height: Number(args.viewportHeight || env.VIEWPORT_HEIGHT || 1000),
    },
    loginEmail: args.loginEmail || env.LOGIN_EMAIL || '',
    loginPassword: args.loginPassword || env.LOGIN_PASSWORD || '',
    loginOtp: args.loginOtp || env.LOGIN_OTP || '',
    otpFile: args.otpFile || env.LOGIN_OTP_FILE || path.join('runs', runName, 'otp.txt'),
    waitForOtp: readBoolean(args.waitForOtp, env.WAIT_FOR_OTP, true),
    otpTimeoutMs: Number(args.otpTimeoutMs || env.OTP_TIMEOUT_MS || 10 * 60 * 1000),
    manualAuth: readBoolean(args.manualAuth, env.MANUAL_AUTH, true),
    searchValue: String(args.searchValue || env.SEARCH_VALUE || '840'),
    failOnApiError: readBoolean(args.failOnApiError, env.FAIL_ON_API_ERROR, false),
    failOnConsoleError: readBoolean(args.failOnConsoleError, env.FAIL_ON_CONSOLE_ERROR, false),
  };
}

export function resolveStartUrl(config) {
  return new URL(config.startPath, config.baseUrl).toString();
}

function readBoolean(argValue, envValue, defaultValue) {
  const value = argValue ?? envValue;
  if (value === undefined) return defaultValue;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (/^(true|1|yes|y)$/i.test(String(value))) return true;
  if (/^(false|0|no|n)$/i.test(String(value))) return false;
  return defaultValue;
}
