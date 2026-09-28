/**
 * ISOLATED DIAGNOSTIC — not part of the Lighthouse gate.
 *
 * Captures a full Chrome trace (plus the Lantern simulation traces) for a single
 * route so LCP time can be attributed to decode / style / layout / paint /
 * scheduling instead of guessed from aggregate LHR numbers.
 *
 * Why this shape, verified against the installed Lighthouse 12.6.1:
 *  - navigation() never launches a browser: it `puppeteer.connect`s to an
 *    existing DevTools endpoint (core/gather/navigation-runner.js). Passing a
 *    `page` skips that entirely, so the browser is launched here and the
 *    configured chromeFlags are the ones actually applied.
 *  - flags.chromeFlags is ignored in the programmatic path; only cli/run.js
 *    parses that flag.
 *  - flags.saveAssets is also ignored there: only cli/run.js:155 calls
 *    assetSaver.saveAssets(). So the saver is invoked directly, which needs no
 *    CLI subprocess and keeps this a single-process diagnostic.
 *
 * It deliberately does not import the batch runner, so the normal 56-route gate
 * keeps working untouched.
 *
 * Usage:
 *   PUBLIC_SITE_URL=https://ci.example.invalid NETLIFY_IMAGE_CDN=false \
 *     CHROME_PATH=<chromium> node scripts/diagnose-projects-lcp-trace.mjs [/projects/]
 *
 * Output: .tmp/lighthouse-trace-projects/  (gitignored)
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import lighthouse from 'lighthouse';
import * as assetSaver from 'lighthouse/core/lib/asset-saver.js';
import { ReportGenerator } from 'lighthouse/report/generator/report-generator.js';

const require = createRequire(import.meta.url);
const FallbackServer = require('@lhci/cli/src/collect/fallback-server.js');
const { determineChromePath } = require('@lhci/cli/src/utils.js');

const ROOT = process.cwd();
const ROUTE = process.argv[2] || '/projects/';
// Optional second argument lets repeat runs land in their own directory without
// overwriting an earlier trace.
const OUT_DIR = process.argv[3]
  ? path.resolve(ROOT, process.argv[3])
  : path.join(ROOT, '.tmp', 'lighthouse-trace-projects');
const OUT_BASE = path.join(OUT_DIR, 'lhr');

// Same value as .lighthouserc.json ci.collect.settings.chromeFlags
const CHROME_FLAGS = ['--no-sandbox', '--disable-dev-shm-usage'];

function loadPuppeteer() {
  // Same resolution order as @lhci/cli puppeteer-manager.
  for (const id of ['puppeteer', 'puppeteer-core']) {
    try {
      return require(id);
    } catch {
      // Try the next candidate.
    }
  }
  try {
    return require(path.join(process.cwd(), 'node_modules', 'puppeteer-core'));
  } catch {
    throw new Error('Neither puppeteer nor puppeteer-core is installed.');
  }
}

function resolveChromePath() {
  const explicit = process.env.LH_DIAGNOSTIC_CHROME_PATH || process.env.CHROME_PATH;
  const resolved = determineChromePath({ chromePath: explicit });
  if (!resolved) throw new Error('No Chrome/Chromium found. Set CHROME_PATH or LH_DIAGNOSTIC_CHROME_PATH.');
  return resolved;
}

/**
 * Captures the renderer's real GPU/raster configuration over CDP.
 *
 * A local trace cannot stand in for a GitHub-hosted Linux runner, so the point
 * is to record what the browser actually did: driver strings, compositing and
 * rasterization status, and the effective command line. Software vs hardware
 * rendering is decided from reported fields, never from the mere presence of a
 * GPU process.
 */
async function collectGpuInfo(browser) {
  const info = { capturedAt: new Date().toISOString() };

  try {
    info.browserVersion = await browser.version();
  } catch (error) {
    info.browserVersionError = String(error?.message || error);
  }

  let session;
  try {
    session = await browser.target().createCDPSession();
  } catch (error) {
    info.cdpError = String(error?.message || error);
    return info;
  }

  try {
    const systemInfo = await session.send('SystemInfo.getInfo');
    const gpu = systemInfo.gpu || {};
    const aux = gpu.auxAttributes || {};

    info.modelName = systemInfo.modelName;
    info.modelVersion = systemInfo.modelVersion;
    info.devices = (gpu.devices || []).map((device) => ({
      vendorString: device.vendorString,
      deviceString: device.deviceString,
      driverVendor: device.driverVendor,
      driverVersion: device.driverVersion,
      vendorId: device.vendorId,
      deviceId: device.deviceId,
      subSysId: device.subSysId,
      revision: device.revision,
    }));
    info.auxAttributes = {
      glRenderer: aux.glRenderer,
      glVendor: aux.glVendor,
      glVersion: aux.glVersion,
      glImplementationParts: aux.glImplementationParts,
      skiaBackendType: aux.skiaBackendType,
      displayType: aux.displayType,
      sandboxed: aux.sandboxed,
      inProcessGpu: aux.inProcessGpu,
      supportsVulkan: aux.supportsVulkan,
      vulkanVersion: aux.vulkanVersion,
      supportsDx12: aux.supportsDx12,
      passthroughCmdDecoder: aux.passthroughCmdDecoder,
      directRenderingVersion: aux.directRenderingVersion,
      processCrashCount: aux.processCrashCount,
    };
    info.featureStatus = gpu.featureStatus || {};
    info.rendering = {
      gpuCompositing: gpu.featureStatus?.gpu_compositing,
      rasterization: gpu.featureStatus?.rasterization,
      opengl: gpu.featureStatus?.opengl,
      skiaGraphite: gpu.featureStatus?.skia_graphite,
      directRenderingDisplayCompositor: gpu.featureStatus?.direct_rendering_display_compositor,
      softwareRenderingFlag: aux.softwareRendering ?? null,
      looksSoftware: /swiftshader|llvmpipe|software/i.test(
        `${aux.glRenderer || ''} ${(gpu.devices || []).map((d) => d.deviceString || '').join(' ')}`
      ),
    };
  } catch (error) {
    info.systemInfoError = String(error?.message || error);
  }

  try {
    const { arguments: argv } = await session.send('Browser.getBrowserCommandLine');
    info.commandLine = argv;
  } catch (error) {
    info.commandLineError = String(error?.message || error);
  }

  try {
    await session.detach();
  } catch {
    // Best effort.
  }

  return info;
}

async function main() {
  const distDir = path.join(ROOT, 'dist');
  if (!fs.existsSync(distDir)) throw new Error('dist/ not found — run the production build first');

  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const entry of fs.readdirSync(OUT_DIR)) {
    fs.rmSync(path.join(OUT_DIR, entry), { recursive: true, force: true });
  }

  const chromePath = resolveChromePath();
  console.log(`[diagnose] route       = ${ROUTE}`);
  console.log(`[diagnose] chrome      = ${chromePath}`);
  console.log(`[diagnose] chromeFlags = ${CHROME_FLAGS.join(' ')}`);
  console.log(`[diagnose] output dir  = ${path.relative(ROOT, OUT_DIR)}`);

  // Same static server LHCI collect uses for staticDistDir.
  const server = new FallbackServer(distDir, false);
  await server.listen();
  const url = new URL(ROUTE, `http://localhost:${server.port}`).toString();
  console.log(`[diagnose] target url  = ${url}`);

  const puppeteer = loadPuppeteer();
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: CHROME_FLAGS,
  });

  let runnerResult;
  let gpuInfo;
  try {
    const page = await browser.newPage();
    // Captured before the run so the renderer state matches the measured run.
    gpuInfo = await collectGpuInfo(browser);
    runnerResult = await lighthouse(
      url,
      {
        // Mirrors .lighthouserc.json ci.collect.settings
        formFactor: 'mobile',
        screenEmulation: { mobile: true },
        throttlingMethod: 'simulate',
      },
      undefined,
      page
    );
  } finally {
    await browser.close();
    await server.close();
  }

  const { lhr, artifacts } = runnerResult;

  // Same call cli/run.js:155 makes for --save-assets.
  await assetSaver.saveAssets(artifacts, lhr.audits, OUT_BASE);

  fs.writeFileSync(`${OUT_BASE}.report.json`, `${JSON.stringify(lhr, null, 2)}\n`, 'utf8');
  fs.writeFileSync(`${OUT_BASE}.report.html`, ReportGenerator.generateReportHtml(lhr), 'utf8');
  fs.writeFileSync(path.join(OUT_DIR, 'gpu-info.json'), `${JSON.stringify(gpuInfo, null, 2)}\n`, 'utf8');

  console.log(`[diagnose] gpu-info    = ${path.relative(ROOT, path.join(OUT_DIR, 'gpu-info.json'))}`);
  if (gpuInfo?.rendering) {
    console.log(
      `[diagnose] renderer    = gpuCompositing=${gpuInfo.rendering.gpuCompositing} rasterization=${gpuInfo.rendering.rasterization} looksSoftware=${gpuInfo.rendering.looksSoftware}`
    );
    for (const device of gpuInfo.devices || []) {
      console.log(
        `[diagnose] gpu device  = ${device.deviceString || '(unnamed)'} ${device.driverVendor || ''} ${device.driverVersion || ''}`.trim()
      );
    }
  }

  const num = (key) => {
    const value = lhr.audits?.[key]?.numericValue;
    return Number.isFinite(value) ? Math.round(value) : null;
  };

  console.log(`[diagnose] FCP         = ${num('first-contentful-paint') ?? 'n/a'} ms`);
  console.log(`[diagnose] LCP         = ${num('largest-contentful-paint') ?? 'n/a'} ms`);
  console.log(`[diagnose] TBT         = ${num('total-blocking-time') ?? 'n/a'} ms`);
  console.log(
    `[diagnose] perf score  = ${
      lhr.categories?.performance?.score != null ? Math.round(lhr.categories.performance.score * 100) : 'n/a'
    }`
  );

  const node = lhr.audits?.['largest-contentful-paint-element']?.details?.items?.[0]?.items?.[0]?.node;
  if (node) console.log(`[diagnose] LCP element = ${node.selector}`);

  console.log('[diagnose] artifacts:');
  for (const entry of fs.readdirSync(OUT_DIR).sort()) {
    const size = fs.statSync(path.join(OUT_DIR, entry)).size;
    console.log(`  ${String(Math.round(size / 1024)).padStart(8)} KB  ${entry}`);
  }
}

main().catch((error) => {
  console.error('[diagnose] failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
