import { ocrImage, verifyScreenByOcr } from './ocr.js';
import { clickByOcr, typeText } from './visual-actions.js';
import { assertScreenChanged } from './visual-assertions.js';
import { assertNoBadApiResponses, assertNoConsoleErrors } from './telemetry.js';

export class WorkflowRunner {
  constructor({ page, worker, evidence, config }) {
    this.page = page;
    this.worker = worker;
    this.evidence = evidence;
    this.config = config;
    this.failures = [];
  }

  recordAssertion(label, assertion, failureType) {
    if (assertion.passed || assertion.changed) return;
    this.failures.push({ label, failureType, assertion });
  }

  async runStep(step) {
    this.evidence.event('workflow_step_started', { step });

    try {
      if (step.type === 'ocr-click') {
        const result = await clickByOcr({
          page: this.page,
          worker: this.worker,
          evidence: this.evidence,
          ocrImage,
          name: step.id,
          labels: step.labels,
          fallback: step.fallback,
          regionForDiff: step.regionForDiff,
          expectScreenChange: step.expectScreenChange,
          targetRegion: step.targetRegion,
        });

        if (step.expectScreenChange && result.changed === false) {
          this.failures.push({ label: step.id, failureType: 'visual-state', result });
        }
      }

      if (step.type === 'type') {
        const before = await this.evidence.screenshot(this.page, `${step.id}-before`);
        await typeText({ page: this.page, evidence: this.evidence, label: step.id, value: step.value });
        const after = await this.evidence.screenshot(this.page, `${step.id}-after`);
        if (step.expectScreenChange !== false) {
          const visual = await assertScreenChanged({
            before,
            after,
            label: step.id,
            clip: step.regionForDiff,
            evidence: this.evidence,
          });
          if (!visual.changed) this.failures.push({ label: step.id, failureType: 'visual-state', visual });
        }

        if (step.shouldContain?.length) {
          const ocrAssertion = await verifyScreenByOcr({
            worker: this.worker,
            screenshotPath: after,
            label: step.id,
            shouldContain: step.shouldContain,
            evidence: this.evidence,
          });
          if (!ocrAssertion.passed) this.failures.push({ label: step.id, failureType: 'ocr-assertion', ocrAssertion });
        }
      }

      if (step.apiAssertion) {
        const api = assertNoBadApiResponses(this.evidence, step.id);
        if (!api.passed) this.failures.push({ label: step.id, failureType: 'api', api });
      }

      const consoleAssertion = assertNoConsoleErrors(this.evidence, step.id);
      if (!consoleAssertion.passed && this.config.failOnConsoleError) {
        this.failures.push({ label: step.id, failureType: 'console', consoleAssertion });
      }

      this.evidence.event('workflow_step_completed', { id: step.id });
    } catch (error) {
      const failure = {
        label: step.id,
        failureType: 'workflow-state',
        message: error.message,
        stack: error.stack,
      };
      this.failures.push(failure);
      this.evidence.event('workflow_step_failed', failure);
    }
  }

  async run(steps) {
    for (const step of steps) {
      await this.runStep(step);
    }

    if (!this.config.failOnApiError) {
      this.failures = this.failures.filter(failure => failure.failureType !== 'api');
    }

    return {
      passed: this.failures.length === 0,
      failures: this.failures,
    };
  }
}
