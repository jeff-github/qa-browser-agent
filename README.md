# QA Browser Agent

Playwright/OCR workflows capture screenshots, traces, video, console errors, HTTP
failures and classified assertion failures. Optional OpenAI analysis suggests checks.

## Setup (Node.js 22+)
```powershell
npm ci
npm run install:browsers
Copy-Item .env.example .env
npm run check
npm run agent:headed
```
Set `BASE_URL` to an authorized test app. The default is localhost. The headed
runner pauses for manual login. Use `npm run agent:visual:headed` for OCR workflows
and adapt `src/lib/workflow-definition.js` to the target UI. Sample clinical-style
page labels and coordinate fallbacks are not generic navigation rules.
Tesseract obtains its English model at runtime; no model binary is included.

## Evidence and AI
Generated `runs/` content is excluded from Git. Screenshots, traces, page text and
response snippets can contain sensitive data; use synthetic accounts and records.
AI analysis requires `ENABLE_AI_ANALYSIS=true` and `OPENAI_API_KEY`. Enabling it sends
page text, URL and screenshot path to OpenAI. Automatic input redaction is not implemented.
This is scripted browser/OCR automation with optional AI analysis, not a validated
autonomous agent or formal LLM benchmark. Some failures are recorded while execution
continues. Configure strict API/console failure flags as appropriate.
CI validates JavaScript syntax; browser behavior requires a configured target.

## Status
Public portfolio edition of existing project code. Original credentials, captured
run data, and environment defaults are excluded. See the limitations above.
