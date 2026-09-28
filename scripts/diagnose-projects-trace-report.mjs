/**
 * ISOLATED DIAGNOSTIC — not part of the Lighthouse gate.
 *
 * Reads a Chrome trace produced by scripts/diagnose-projects-lcp-trace.mjs and
 * reports REAL observed timings relative to navigationStart, alongside the GPU
 * configuration captured over CDP.
 *
 * These are observed trace timestamps, NOT the Lantern-simulated values that
 * appear in the LHR. The two differ substantially, and the difference is the
 * whole point of the diagnostic.
 *
 * Usage:
 *   node scripts/diagnose-projects-trace-report.mjs <dir-containing-lhr-0.trace.json>
 */
import fs from 'node:fs';
import path from 'node:path';

const MICRO = 1000; // us -> ms

function analyze(runDir) {
  const trace = JSON.parse(fs.readFileSync(path.join(runDir, 'lhr-0.trace.json'), 'utf8'));
  const ev = trace.traceEvents;

  const navStart = ev.find((e) => e.name === 'navigationStart' && e.cat.includes('user_timing'));
  if (!navStart) throw new Error('navigationStart not found in trace');
  const t0 = navStart.ts;
  const at = (e) => (e.ts - t0) / MICRO;
  const byName = (name) => ev.filter((e) => e.name === name);

  const firstPaint = byName('firstPaint').slice(-1)[0];
  const fcpEvent = byName('firstContentfulPaint').slice(-1)[0];
  const candidates = byName('largestContentfulPaint::Candidate');
  const lcpCandidate = candidates[candidates.length - 1];
  if (!lcpCandidate) throw new Error('largestContentfulPaint::Candidate not found in trace');
  const lcpArgs = lcpCandidate.args.data;

  const rendererPid = lcpCandidate.pid;
  const onRenderer = (e) => e.pid === rendererPid;

  // Frame commit -> presentation for the frame that produced the LCP candidate.
  const presentations = byName('AnimationFrame::Presentation').filter(onRenderer);
  const presentation =
    presentations.find((p) => p.ts === lcpCandidate.ts) ||
    presentations.find((p) => p.ts >= lcpCandidate.ts) ||
    presentations[presentations.length - 1];
  if (!presentation) throw new Error('AnimationFrame::Presentation not found in trace');

  const commits = byName('Commit').filter(onRenderer);
  const commit = commits.filter((e) => e.ts <= presentation.ts).slice(-1)[0];
  if (!commit) throw new Error('frame Commit not found in trace');

  const layouts = byName('Layout').filter(onRenderer);
  const largestLayout = layouts.slice().sort((a, b) => b.dur - a.dur)[0];

  // `Decode Image` in Chrome traces is usually the favicon (imageType 'ico').
  // The LCP image decode is reported as ImageDecodeTask / Decode LazyPixelRef.
  const decodes = ev
    .filter((e) => onRenderer(e) && (e.name === 'ImageDecodeTask' || e.name === 'Decode LazyPixelRef') && e.dur > 0)
    .sort((a, b) => b.dur - a.dur);
  const lcpDecode = decodes[0] || null;

  const paintImages = byName('PaintImage').filter(onRenderer);
  const finalPaintImage = paintImages.filter((p) => p.ts <= lcpCandidate.ts).slice(-1)[0];

  const gpuInWindow = ev
    .filter((e) => e.name === 'GPUTask' && e.ts >= commit.ts && e.ts <= presentation.ts)
    .map((e) => ({ t: at(e), dur: e.dur / MICRO, pid: e.pid }));
  const gpuTotal = gpuInWindow.reduce((sum, e) => sum + e.dur, 0);
  const gpuLargest = gpuInWindow.reduce((max, e) => Math.max(max, e.dur), 0);

  const longTasks = ev
    .filter((e) => e.name === 'RunTask' && onRenderer(e) && e.dur >= 50000 && e.ts < fcpEvent.ts)
    .map((e) => ({ t: at(e), dur: e.dur / MICRO }));

  return {
    rendererPid,
    firstPaint: firstPaint ? at(firstPaint) : null,
    fcp: at(fcpEvent),
    lcp: at(lcpCandidate),
    lcpNode: lcpArgs.nodeName,
    lcpType: lcpArgs.type,
    lcpSize: lcpArgs.size,
    imageDiscovery: lcpArgs.imageDiscoveryTime,
    imageRequestStart: lcpArgs.imageLoadStart,
    imageReady: lcpArgs.imageLoadEnd,
    largestLayoutStart: largestLayout ? at(largestLayout) : null,
    largestLayoutDuration: largestLayout ? largestLayout.dur / MICRO : null,
    decodeStart: lcpDecode ? at(lcpDecode) : null,
    decodeDuration: lcpDecode ? lcpDecode.dur / MICRO : null,
    paintImage: finalPaintImage ? at(finalPaintImage) : null,
    commit: at(commit),
    presentation: at(presentation),
    commitToPresentation: at(presentation) - at(commit),
    readyToPresentation: at(presentation) - lcpArgs.imageLoadEnd,
    gpuTaskCount: gpuInWindow.length,
    gpuTotal,
    gpuLargest,
    gpuDurations: gpuInWindow.map((e) => Number(e.dur.toFixed(2))),
    longTaskCount: longTasks.length,
    longTaskTotal: longTasks.reduce((sum, e) => sum + e.dur, 0),
    longTaskLargest: longTasks.reduce((max, e) => Math.max(max, e.dur), 0),
  };
}

function main() {
  const runDir = process.argv[2] || '.tmp/lighthouse-trace-projects-ci';
  const result = analyze(runDir);

  const gpuInfoPath = path.join(runDir, 'gpu-info.json');
  const gpuInfo = fs.existsSync(gpuInfoPath) ? JSON.parse(fs.readFileSync(gpuInfoPath, 'utf8')) : null;

  const report = { runDir, ...result };
  if (gpuInfo) {
    report.gpuConfiguration = {
      browserVersion: gpuInfo.browserVersion,
      modelName: gpuInfo.modelName,
      devices: gpuInfo.devices,
      rendering: gpuInfo.rendering,
      glRenderer: gpuInfo.auxAttributes?.glRenderer,
      glVendor: gpuInfo.auxAttributes?.glVendor,
      glVersion: gpuInfo.auxAttributes?.glVersion,
      glImplementationParts: gpuInfo.auxAttributes?.glImplementationParts,
      skiaBackendType: gpuInfo.auxAttributes?.skiaBackendType,
      displayType: gpuInfo.auxAttributes?.displayType,
      sandboxed: gpuInfo.auxAttributes?.sandboxed,
      supportsVulkan: gpuInfo.auxAttributes?.supportsVulkan,
      featureStatus: gpuInfo.featureStatus,
      commandLine: gpuInfo.commandLine,
      captureErrors: {
        systemInfo: gpuInfo.systemInfoError ?? null,
        commandLine: gpuInfo.commandLineError ?? null,
        cdp: gpuInfo.cdpError ?? null,
      },
    };
  }

  const outPath = path.join(runDir, 'trace-report.json');
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  const fmt = (value) => (typeof value === 'number' ? value.toFixed(1) : String(value ?? 'n/a'));
  const lines = [
    '--- REAL TRACE TIMINGS (ms relative to navigationStart) ---',
    `firstPaint              ${fmt(result.firstPaint)}`,
    `FCP                    ${fmt(result.fcp)}`,
    `LCP                    ${fmt(result.lcp)}`,
    `LCP element            ${result.lcpNode} (${result.lcpType}, ${result.lcpSize} px)`,
    `image discovery        ${fmt(result.imageDiscovery)}`,
    `image request start    ${fmt(result.imageRequestStart)}`,
    `image resource ready   ${fmt(result.imageReady)}`,
    `largest Layout start   ${fmt(result.largestLayoutStart)}`,
    `largest Layout dur     ${fmt(result.largestLayoutDuration)}`,
    `image decode start     ${fmt(result.decodeStart)}`,
    `image decode dur       ${fmt(result.decodeDuration)}`,
    `final PaintImage       ${fmt(result.paintImage)}`,
    `frame Commit           ${fmt(result.commit)}`,
    `Presentation           ${fmt(result.presentation)}`,
    `commit -> presentation ${fmt(result.commitToPresentation)}`,
    `ready -> presentation  ${fmt(result.readyToPresentation)}`,
    '',
    '--- GPU WORK INSIDE commit -> presentation ---',
    `task count             ${result.gpuTaskCount}`,
    `total duration         ${fmt(result.gpuTotal)}`,
    `largest task           ${fmt(result.gpuLargest)}`,
    `share of gap           ${fmt((result.gpuTotal / result.commitToPresentation) * 100)}%`,
    `durations              ${result.gpuDurations.join(', ')}`,
    '',
    '--- RENDERER LONG TASKS BEFORE FCP ---',
    `count                  ${result.longTaskCount}`,
    `total duration         ${fmt(result.longTaskTotal)}`,
    `largest task           ${fmt(result.longTaskLargest)}`,
  ];

  if (report.gpuConfiguration) {
    lines.push(
      '',
      '--- GPU CONFIGURATION (CDP) ---',
      `browser                ${report.gpuConfiguration.browserVersion}`,
      `gpuCompositing         ${report.gpuConfiguration.rendering?.gpuCompositing}`,
      `rasterization          ${report.gpuConfiguration.rendering?.rasterization}`,
      `opengl                 ${report.gpuConfiguration.rendering?.opengl}`,
      `looksSoftware          ${report.gpuConfiguration.rendering?.looksSoftware}`,
      `glRenderer             ${report.gpuConfiguration.glRenderer}`,
      `glVendor               ${report.gpuConfiguration.glVendor}`,
      `glVersion              ${report.gpuConfiguration.glVersion}`,
      `glImplementationParts  ${report.gpuConfiguration.glImplementationParts}`,
      `skiaBackendType        ${report.gpuConfiguration.skiaBackendType}`,
      `displayType            ${report.gpuConfiguration.displayType}`,
      `sandboxed              ${report.gpuConfiguration.sandboxed}`,
      `supportsVulkan         ${report.gpuConfiguration.supportsVulkan}`,
      `devices                ${(report.gpuConfiguration.devices || [])
        .map((d) => `${d.deviceString || '(unnamed)'} [${d.driverVendor || '?'} ${d.driverVersion || '?'}]`)
        .join(' | ')}`
    );
  } else {
    lines.push('', '--- GPU CONFIGURATION (CDP) ---', 'gpu-info.json not found next to the trace');
  }

  const text = lines.join('\n');
  process.stdout.write(`${text}\n`);
  fs.writeFileSync(path.join(runDir, 'trace-report.txt'), `${text}\n`, 'utf8');
  console.log(`\nreport written: ${outPath}`);
}

main();
