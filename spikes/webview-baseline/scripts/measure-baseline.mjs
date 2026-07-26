import { mkdir, writeFile } from 'node:fs/promises';
import { arch, platform, release, totalmem, type } from 'node:os';
import { resolve } from 'node:path';

const generatedAt = new Date().toISOString();
const report = {
  schemaVersion: 1,
  spike: 'SPIKE-08',
  generatedAt,
  measurementStatus: 'inconclusive',
  environment: {
    os: `${type()} ${release()}`,
    platform: platform(),
    architecture: arch(),
    systemMemoryBytes: totalmem(),
    node: process.version,
    webviewVersion: null,
    hardwareProfile: null,
    build: 'not verified as packaged release'
  },
  metrics: {
    coldStartupMs: { status: 'inconclusive', samples: [], reason: 'Requires 20 packaged-release runs on a reference machine.' },
    warmStartupMs: { status: 'inconclusive', samples: [], reason: 'Requires 20 packaged-release runs on a reference machine.' },
    idleRssMiB: { status: 'inconclusive', samples: [], reason: 'Requires a visible window, 60-second idle sampling, and process-tree attribution.' },
    idleCpuPercent: { status: 'inconclusive', samples: [], reason: 'Requires a visible window and 60-second physical-machine sampling.' },
    longTimelineScroll: { status: 'inconclusive', fixture: '?fixture=10k', reason: 'Requires physical GUI scroll/frame-time capture; the fixture only verifies virtualized mounting.' },
    iframeWorkerIsolation: { status: 'not-run', reason: 'This intentionally plugin-free baseline has no iframe or worker isolation surface.' },
    platformRendering: { status: 'inconclusive', reason: 'Requires Windows WebView2 and Linux WebKitGTK reference-machine screenshots and interaction checks.' }
  },
  budgets: {
    startupWarmP50Ms: 800,
    startupWarmP95Ms: 1500,
    windowsMacosRssHardMiB: 160,
    linuxRssHardMiB: 190,
    longSessionScrollP95Ms: 20
  },
  conclusion: 'No physical GUI, RSS, CPU, startup, or 10k-scroll budget is passed by this generated report.'
};

const markdown = `# SPIKE-08 baseline measurement\n\n- Generated: ${report.generatedAt}\n- Status: **inconclusive**\n- Host: ${report.environment.os} (${report.environment.architecture})\n- WebView version: not recorded\n\n## Required physical-machine measurements\n\n| Metric | Status | Required method |\n| --- | --- | --- |\n| Cold/warm startup | Inconclusive | 20 packaged-release runs; record p50/p95 |\n| Idle RSS / CPU | Inconclusive | Visible window, normal shell, no Pi runtime, 60 s sample |\n| 10k-block scroll | Inconclusive | Open ?fixture=10k, capture frame times and long tasks |\n| Platform rendering | Inconclusive | Check WebView2 and WebKitGTK reference machines |\n| iframe/worker isolation | Not run | Deliberately outside this no-plugin shell |\n\nNo display, RSS, CPU, startup, or scroll budget has been passed. Replace each metric's status, samples, hardware profile, WebView version, and measurement method in the JSON report only after physical reference-hardware collection.\n`;

const reportsDirectory = resolve('reports');
await mkdir(reportsDirectory, { recursive: true });
await Promise.all([
  writeFile(resolve(reportsDirectory, 'baseline-result.json'), `${JSON.stringify(report, null, 2)}\n`),
  writeFile(resolve(reportsDirectory, 'baseline-report.md'), markdown)
]);
console.log('Wrote inconclusive SPIKE-08 report files to reports/.');
