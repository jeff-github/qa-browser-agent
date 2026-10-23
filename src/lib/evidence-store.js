import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

function safeSegment(value) {
  return String(value || 'artifact').replace(/[^a-z0-9-_]+/gi, '-').toLowerCase();
}

export class EvidenceStore {
  constructor(options) {
    const { runDir, stamp } = options;
    this.runDir = runDir;
    this.screenshotDir = path.join(runDir, 'screenshots');
    this.events = [];
    this.apiEvents = [];
    this.artifacts = [];
    this.sequence = 0;
    this.stamp = stamp;
    this.config = options.config || options;
  }

  async init() {
    await fs.mkdir(this.screenshotDir, { recursive: true });
    await fs.mkdir(path.join(this.runDir, 'videos'), { recursive: true });
  }

  event(type, data = {}) {
    const entry = {
      sequence: this.sequence++,
      time: new Date().toISOString(),
      type,
      ...data,
    };
    this.events.push(entry);
    return entry;
  }

  api(event) {
    this.apiEvents.push({
      time: new Date().toISOString(),
      ...event,
    });
  }

  async hashFile(file) {
    const buffer = await fs.readFile(file);
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }

  async registerArtifact(file, kind, metadata = {}) {
    const stat = await fs.stat(file);
    const sha256 = await this.hashFile(file);
    const artifact = {
      kind,
      file,
      sha256,
      bytes: stat.size,
      createdAt: new Date().toISOString(),
      ...metadata,
    };
    this.artifacts.push(artifact);
    return artifact;
  }

  async screenshot(page, name, options = {}) {
    const file = path.join(
      this.screenshotDir,
      `${String(this.sequence).padStart(4, '0')}-${safeSegment(name)}.png`
    );

    await page.screenshot({
      path: file,
      fullPage: !options.clip,
      clip: options.clip,
    });

    const artifact = await this.registerArtifact(file, 'screenshot', {
      name,
      url: page.url(),
      clip: options.clip || null,
      viewport: page.viewportSize(),
    });

    this.event('screenshot', artifact);
    console.log(`Screenshot: ${file}`);
    return file;
  }

  async writeJson(name, value, kind = 'json') {
    const file = path.join(this.runDir, name);
    await fs.writeFile(file, JSON.stringify(value, null, 2));
    await this.registerArtifact(file, kind);
    return file;
  }

  async writeText(name, value, kind = 'text') {
    const file = path.join(this.runDir, name);
    await fs.writeFile(file, value);
    await this.registerArtifact(file, kind);
    return file;
  }

  async finalize(extra = {}) {
    await this.writeJson('events.json', this.events, 'events');
    await this.writeJson('api-events.json', this.apiEvents, 'api-events');

    const manifest = {
      schemaVersion: 1,
      runId: path.basename(this.runDir),
      createdAt: new Date().toISOString(),
      stamp: this.stamp,
      config: {
        baseUrl: this.config.baseUrl,
        startPath: this.config.startPath,
        viewport: this.config.viewport,
      },
      counts: {
        events: this.events.length,
        apiEvents: this.apiEvents.length,
        artifacts: this.artifacts.length,
      },
      artifacts: this.artifacts,
      ...extra,
    };

    return this.writeJson('manifest.json', manifest, 'manifest');
  }
}
