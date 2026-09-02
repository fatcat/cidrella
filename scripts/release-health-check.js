#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const NODE_DIST_INDEX = 'https://nodejs.org/dist/index.json';
const NODE_RELEASE_SCHEDULE = 'https://raw.githubusercontent.com/nodejs/Release/main/schedule.json';
const S6_OVERLAY_LATEST = 'https://api.github.com/repos/just-containers/s6-overlay/releases/latest';

const args = process.argv.slice(2);
let bundledNodeVersion = '';
let jsonOut = '';

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--bundled-node-version') {
    bundledNodeVersion = args[++i] || '';
  } else if (arg === '--json-out') {
    jsonOut = args[++i] || '';
  } else {
    console.error(`Unknown argument: ${arg}`);
    process.exit(2);
  }
}

if (!bundledNodeVersion) {
  console.error('Missing --bundled-node-version');
  process.exit(2);
}

function normalizeVersion(version) {
  return String(version || '').replace(/^v/, '');
}

// Prerelease-aware ordering. The previous version split on '.' and ran each
// segment through parseInt, so "24.19.0-rc.1" became [24,19,0,1] (parseInt
// stops at the '-') and therefore ranked ABOVE "24.19.0". It decides the Node
// security/LTS comparison and the s6-overlay check, and both read upstream
// indexes that do contain -rc and -nightly tags, so that inversion could
// recommend a prerelease runtime as if it were newer than the stable release.
//
// Same rules as server/src/utils/semver.js and scripts/lib/slots.sh: a version
// WITHOUT a prerelease outranks the same core WITH one, numeric identifiers
// compare numerically, and a shorter identifier list ranks below a longer one
// sharing its prefix. Kept as a local copy rather than an import because this
// script is CommonJS build tooling and semver.js is an ESM server module.
// See REVIEW.md, duplicate-logic audit #34.
function compareVersions(a, b) {
  const parse = (v) => {
    const clean = normalizeVersion(v).split('+')[0];
    const [core, pre] = clean.split(/-(.*)/, 2);
    const nums = core.split('.').map((n) => Number.parseInt(n, 10) || 0);
    return { nums, pre: pre ? pre.split('.') : [] };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length); i += 1) {
    const diff = (pa.nums[i] || 0) - (pb.nums[i] || 0);
    if (diff !== 0) return diff;
  }
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;   // release outranks its own prerelease
  if (pb.pre.length === 0) return -1;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i += 1) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xN = /^\d+$/.test(x);
    const yN = /^\d+$/.test(y);
    if (xN && yN) {
      const d = Number.parseInt(x, 10) - Number.parseInt(y, 10);
      if (d !== 0) return d;
    } else if (xN) return -1;
    else if (yN) return 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function majorOf(version) {
  return Number.parseInt(normalizeVersion(version).split('.')[0], 10);
}

function toDate(value) {
  return value ? new Date(`${value}T00:00:00Z`) : null;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'cidrella-release-health-check',
      Accept: 'application/json,text/plain;q=0.9,*/*;q=0.8',
    },
  });
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }
  return response.json();
}

function runJsonCommand(command, argsForCommand, cwd) {
  const cacheDir = path.join(path.resolve(__dirname, '..'), 'dist', '.npm-cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const result = spawnSync(command, argsForCommand, {
    cwd,
    env: {
      ...process.env,
      npm_config_cache: cacheDir,
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderr = result.error
    ? result.error.message
    : result.stderr.trim();
  const output = result.stdout.trim();
  if (!output) {
    return { ok: result.status === 0 && !result.error, data: {}, stderr };
  }
  try {
    return { ok: result.status === 0 && !result.error, data: JSON.parse(output), stderr };
  } catch (error) {
    return {
      ok: false,
      data: {},
      stderr: `${stderr}\nCould not parse JSON from ${command} ${argsForCommand.join(' ')}: ${error.message}`.trim(),
    };
  }
}

function checkNpmProject(projectRoot, relativeDir) {
  const cwd = path.join(projectRoot, relativeDir);
  const packageJson = path.join(cwd, 'package.json');
  if (!fs.existsSync(packageJson)) return null;

  // Packages deliberately held back on their current major. The build's
  // update prompt must NOT offer these, or an accepted prompt re-upgrades a
  // dependency we chose to stay on (this bit us when PrimeVue, reverted 5->4
  // to dodge its paid-license watermark, got re-upgraded to 5 by the prompt).
  // Declared in the project's package.json so the policy lives with the deps:
  //   "releaseHealth": { "holdMajor": ["primevue", "@primeuix/themes"] }
  let heldMajors = [];
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJson, 'utf8'));
    heldMajors = Array.isArray(pkg.releaseHealth?.holdMajor) ? pkg.releaseHealth.holdMajor : [];
  } catch { /* ignore malformed package.json here; other checks surface it */ }

  const audit = runJsonCommand('npm', ['audit', '--omit=dev', '--json'], cwd);
  const outdated = runJsonCommand('npm', ['outdated', '--omit=dev', '--json'], cwd);
  const vulnerabilities = audit.data?.vulnerabilities || {};
  const vulnerablePackages = Object.entries(vulnerabilities)
    .filter(([, value]) => value && value.severity)
    .map(([name, value]) => ({
      name,
      severity: value.severity,
      via: Array.isArray(value.via)
        ? value.via.map((entry) => (typeof entry === 'string' ? entry : entry.title)).filter(Boolean).slice(0, 5)
        : [],
      fixAvailable: Boolean(value.fixAvailable),
    }))
    .sort((a, b) => {
      const rank = { critical: 4, high: 3, moderate: 2, low: 1 };
      return (rank[b.severity] || 0) - (rank[a.severity] || 0) || a.name.localeCompare(b.name);
    });

  const outdatedPackages = Object.entries(outdated.data || {})
    .map(([name, value]) => ({
      name,
      current: value.current,
      wanted: value.wanted,
      latest: value.latest,
      type: value.type || '',
    }))
    .filter((pkg) => pkg.current && pkg.latest && pkg.current !== pkg.latest)
    // Drop held packages entirely so neither the routine nor the major
    // update prompt ever offers them.
    .filter((pkg) => !heldMajors.includes(pkg.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const actionableUpdates = outdatedPackages
    .filter((pkg) => pkg.wanted && pkg.current !== pkg.wanted);
  const majorUpdates = outdatedPackages
    .filter((pkg) => !pkg.wanted || pkg.current === pkg.wanted);

  return {
    dir: relativeDir || '.',
    auditError: audit.ok || vulnerablePackages.length > 0 ? '' : audit.stderr,
    outdatedError: outdated.ok || outdatedPackages.length > 0 ? '' : outdated.stderr,
    vulnerabilities: vulnerablePackages,
    outdated: actionableUpdates,
    majorUpdates,
  };
}

function parseDockerfile(projectRoot) {
  const dockerfile = path.join(projectRoot, 'Dockerfile');
  if (!fs.existsSync(dockerfile)) {
    return null;
  }
  const text = fs.readFileSync(dockerfile, 'utf8');
  const fromMatches = [...text.matchAll(/^FROM\s+node:([^\s]+)(?:\s+AS\s+([^\s]+))?/gmi)];
  const nodeImages = fromMatches.map((match) => {
    const tag = match[1];
    const versionMatch = tag.match(/^(\d+)(?:\.(\d+)\.(\d+))?(-.*)?$/);
    return {
      image: `node:${tag}`,
      tag,
      stage: match[2] || '',
      major: versionMatch ? Number.parseInt(versionMatch[1], 10) : null,
      pinnedPatch: Boolean(versionMatch && versionMatch[2] && versionMatch[3]),
    };
  });

  const s6Match = text.match(/^ARG\s+S6_OVERLAY_VERSION=([^\s#]+)/m);
  return {
    present: true,
    nodeImages,
    s6OverlayVersion: s6Match ? normalizeVersion(s6Match[1]) : '',
  };
}

async function checkDocker(projectRoot, latestLtsMajor, latestLtsVersion, distIndex) {
  const parsed = parseDockerfile(projectRoot);
  if (!parsed) {
    return {
      present: false,
      nodeImages: [],
      nodeLtsUpdateAvailable: false,
      nodeSecurityUpdateRequired: false,
      s6Overlay: {
        current: '',
        latest: '',
        updateAvailable: false,
      },
      checkError: '',
    };
  }

  let s6Latest = '';
  let checkError = '';
  try {
    const latest = await fetchJson(S6_OVERLAY_LATEST);
    s6Latest = normalizeVersion(latest.tag_name || latest.name || '');
  } catch (error) {
    checkError = `s6-overlay latest release check failed: ${error.message}`;
  }

  const nodeImages = parsed.nodeImages.map((image) => {
    const sameMajor = image.major
      ? distIndex.filter((release) => majorOf(release.version) === image.major).sort((a, b) => compareVersions(b.version, a.version))
      : [];
    const latestSameMajor = normalizeVersion(sameMajor[0]?.version || '');
    const currentComparable = image.pinnedPatch ? image.tag.replace(/-.*/, '') : latestSameMajor;
    const securityReleases = image.pinnedPatch
      ? sameMajor
        .filter((release) => compareVersions(release.version, currentComparable) > 0 && release.security === true)
        .map((release) => ({ version: normalizeVersion(release.version) }))
      : [];
    return {
      ...image,
      latestSameMajor,
      latestLtsMajor,
      latestLtsVersion,
      nodeLtsUpdateAvailable: Boolean(image.major && latestLtsMajor > image.major),
      securityUpdateRequired: securityReleases.length > 0,
      securityReleases,
      fixTargetTag: image.tag.replace(/^(\d+)(?:\.\d+\.\d+)?/, String(latestLtsMajor)),
    };
  });

  return {
    present: true,
    nodeImages,
    nodeLtsUpdateAvailable: nodeImages.some((image) => image.nodeLtsUpdateAvailable),
    nodeSecurityUpdateRequired: nodeImages.some((image) => image.securityUpdateRequired),
    s6Overlay: {
      current: parsed.s6OverlayVersion,
      latest: s6Latest,
      updateAvailable: Boolean(parsed.s6OverlayVersion && s6Latest && compareVersions(s6Latest, parsed.s6OverlayVersion) > 0),
    },
    checkError,
  };
}

function printReport(report) {
  console.log('Release dependency/runtime health check');
  console.log(`  Bundled Node: v${report.node.current}`);

  if (report.node.securityUpdateRequired) {
    console.log(`  SECURITY: newer Node security release(s) exist on v${report.node.currentMajor}.`);
    for (const release of report.node.securityReleases) {
      console.log(`    - ${release.version}`);
    }
    console.log(`    Target update: v${report.node.recommendedVersion}`);
    console.log('    Fix path: accept the security update prompt to rewrite BUNDLED_NODE_VERSION, then rerun the build.');
  } else if (report.node.routineUpdateAvailable) {
    console.log(`  Update available: Node v${report.node.latestSameMajor} is newer than bundled v${report.node.current}.`);
    console.log('    Fix path: accept the routine update prompt to rewrite BUNDLED_NODE_VERSION, then rerun the build.');
  } else {
    console.log('  Node patch line: current');
  }

  if (report.node.ltsUpdateAvailable) {
    console.log(`  LTS notice: active LTS is v${report.node.latestLtsMajor}; bundled major is v${report.node.currentMajor}.`);
    console.log(`    Suggested LTS target: v${report.node.latestLtsVersion}`);
    console.log('    Fix path: accept the routine update prompt to move the bundled runtime to the active LTS line.');
  }

  for (const project of report.npmProjects) {
    if (project.vulnerabilities.length > 0) {
      console.log(`  SECURITY: npm audit found ${project.vulnerabilities.length} vulnerable package(s) in ${project.dir}:`);
      for (const vuln of project.vulnerabilities.slice(0, 10)) {
        const fix = vuln.fixAvailable ? 'fix available' : 'no automatic fix reported';
        console.log(`    - ${vuln.name} (${vuln.severity}, ${fix})${vuln.via.length ? `: ${vuln.via.join('; ')}` : ''}`);
      }
      console.log(`    Fix path: accept the security update prompt to run npm audit fix --omit=dev in ${project.dir}.`);
    }
    if (project.outdated.length > 0) {
      console.log(`  Updates available in ${project.dir}: ${project.outdated.length} package(s)`);
      for (const pkg of project.outdated.slice(0, 10)) {
        console.log(`    - ${pkg.name}: ${pkg.current} -> wanted ${pkg.wanted}, latest ${pkg.latest}`);
      }
      console.log(`    Fix path: accept the routine update prompt to run npm update --omit=dev in ${project.dir}.`);
    }
    if (project.majorUpdates?.length > 0) {
      console.log(`  Major updates available in ${project.dir}: ${project.majorUpdates.length} package(s)`);
      for (const pkg of project.majorUpdates.slice(0, 10)) {
        console.log(`    - ${pkg.name}: ${pkg.current} -> latest ${pkg.latest} (outside declared range)`);
      }
      console.log('    Note: not applied by routine npm update; evaluate separately before changing package.json ranges.');
    }
    if (project.auditError) {
      console.log(`  WARNING: npm audit check failed in ${project.dir}: ${project.auditError}`);
    }
    if (project.outdatedError) {
      console.log(`  WARNING: npm outdated check failed in ${project.dir}: ${project.outdatedError}`);
    }
  }

  if (report.docker.present) {
    console.log('  Docker checks:');
    for (const image of report.docker.nodeImages) {
      const stage = image.stage ? ` (${image.stage})` : '';
      if (image.securityUpdateRequired) {
        console.log(`    SECURITY: Docker base ${image.image}${stage} is pinned behind Node security release(s):`);
        for (const release of image.securityReleases) {
          console.log(`      - ${release.version}`);
        }
        console.log('      Fix path: accept the security update prompt to update Dockerfile FROM node tags, then rebuild the image.');
      } else if (image.nodeLtsUpdateAvailable) {
        console.log(`    LTS notice: Docker base ${image.image}${stage} uses Node ${image.major}; active LTS is Node ${image.latestLtsMajor}.`);
        console.log(`      Suggested Docker tag: ${image.fixTargetTag}`);
        console.log('      Fix path: accept the routine update prompt to update Dockerfile FROM node tags.');
      } else {
        console.log(`    Docker base ${image.image}${stage}: Node major aligned with required runtime baseline.`);
      }
      if (!image.pinnedPatch) {
        console.log(`      Patch/security note: ${image.image} is a floating major tag; Docker publishing must rebuild/pull to pick up current ${image.latestSameMajor}.`);
      }
    }
    if (report.docker.s6Overlay.current) {
      if (report.docker.s6Overlay.updateAvailable) {
        console.log(`    s6-overlay update available: ${report.docker.s6Overlay.current} -> ${report.docker.s6Overlay.latest}`);
        console.log('      Fix path: accept the routine update prompt to update ARG S6_OVERLAY_VERSION in Dockerfile.');
      } else if (report.docker.s6Overlay.latest) {
        console.log(`    s6-overlay: current (${report.docker.s6Overlay.current})`);
      }
    }
    if (report.docker.checkError) {
      console.log(`    WARNING: ${report.docker.checkError}`);
    }
    console.log('    Alpine/apk package note: Docker OS package security is handled by rebuilding from a current base image and apk repositories; versions are intentionally not pinned here.');
  }
}

async function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const current = normalizeVersion(bundledNodeVersion);
  const currentMajor = majorOf(current);

  const [distIndex, schedule] = await Promise.all([
    fetchJson(NODE_DIST_INDEX),
    fetchJson(NODE_RELEASE_SCHEDULE),
  ]);

  const sameMajor = distIndex
    .filter((release) => majorOf(release.version) === currentMajor)
    .sort((a, b) => compareVersions(b.version, a.version));
  const latestSameMajor = normalizeVersion(sameMajor[0]?.version || current);
  const newerSameMajor = sameMajor.filter((release) => compareVersions(release.version, current) > 0);
  const securityReleases = newerSameMajor
    .filter((release) => release.security === true)
    .map((release) => ({ version: normalizeVersion(release.version) }));

  const now = new Date();
  const activeLtsMajors = Object.entries(schedule)
    .map(([key, value]) => ({
      major: Number.parseInt(key.replace(/^v/, ''), 10),
      lts: toDate(value.lts),
      end: toDate(value.end),
    }))
    .filter((entry) => entry.lts && entry.end && entry.lts <= now && now < entry.end)
    .map((entry) => entry.major)
    .sort((a, b) => b - a);
  const latestLtsMajor = activeLtsMajors[0] || currentMajor;
  const latestLtsRelease = distIndex
    .filter((release) => majorOf(release.version) === latestLtsMajor)
    .sort((a, b) => compareVersions(b.version, a.version))[0];
  const latestLtsVersion = normalizeVersion(latestLtsRelease?.version || latestSameMajor);
  const npmProjects = ['client', 'server']
    .map((relativeDir) => checkNpmProject(projectRoot, relativeDir))
    .filter(Boolean);
  const docker = await checkDocker(projectRoot, latestLtsMajor, latestLtsVersion, distIndex);

  const report = {
    node: {
      current,
      currentMajor,
      latestSameMajor,
      latestLtsMajor,
      latestLtsVersion,
      securityUpdateRequired: securityReleases.length > 0,
      securityReleases,
      routineUpdateAvailable: compareVersions(latestSameMajor, current) > 0,
      ltsUpdateAvailable: latestLtsMajor > currentMajor,
      recommendedVersion: securityReleases.length > 0 || compareVersions(latestSameMajor, current) > 0
        ? latestSameMajor
        : latestLtsVersion,
    },
    npmProjects,
    docker,
  };

  report.summary = {
    nodeSecurity: report.node.securityUpdateRequired,
    packageSecurity: npmProjects.some((project) => project.vulnerabilities.length > 0),
    nodeRoutine: report.node.routineUpdateAvailable,
    nodeLts: report.node.ltsUpdateAvailable,
    packageRoutine: npmProjects.some((project) => project.outdated.length > 0),
    packageMajor: npmProjects.some((project) => project.majorUpdates?.length > 0),
    dockerSecurity: docker.nodeSecurityUpdateRequired,
    dockerRoutine: docker.nodeLtsUpdateAvailable || docker.s6Overlay.updateAvailable,
    dockerCheckFailures: Boolean(docker.checkError),
    checkFailures: npmProjects.some((project) => project.auditError || project.outdatedError) || Boolean(docker.checkError),
  };

  printReport(report);

  if (jsonOut) {
    fs.writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
  }
}

main().catch((error) => {
  console.error(`Release health check failed: ${error.message}`);
  process.exit(1);
});
