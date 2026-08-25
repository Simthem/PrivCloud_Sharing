import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function sourceFiles(relativeDirectory) {
  const directory = path.join(root, relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const relative = path.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) return sourceFiles(relative);
      return /\.(?:ts|tsx|mjs)$/.test(entry.name) ? [relative] : [];
    }),
  );
  return nested.flat();
}

async function allFiles(relativeDirectory) {
  const directory = path.join(root, relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const relative = path.join(relativeDirectory, entry.name);
      return entry.isDirectory() ? allFiles(relative) : [relative];
    }),
  );
  return nested.flat();
}

async function read(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

test("maintained OSS runtime source contains no commercial access gates", async () => {
  const files = (
    await Promise.all(
      ["backend/src", "frontend/src", "bridge/src"].map(sourceFiles),
    )
  ).flat();
  const forbidden = [
    /premiumClient/i,
    /premium_client_plan_required/i,
    /planRequired/i,
    /\bStripe\b/i,
    /\bentitlement\b/i,
    /PremiumClientAccess/i,
    /\bSaaS\b/i,
  ];

  for (const relativePath of files) {
    const source = await read(relativePath);
    for (const pattern of forbidden) {
      assert.doesNotMatch(
        source,
        pattern,
        `${relativePath} matched ${pattern}`,
      );
    }
  }
});

test("the public tree contains no native Android application surface", async () => {
  const [backendFiles, integrationFiles, backendPackage] = await Promise.all([
    sourceFiles("backend/src"),
    allFiles("integrations"),
    read("backend/package.json").then(JSON.parse),
  ]);
  const forbiddenBackendMarkers = [
    /AndroidManifest/i,
    /\bCapacitor\b/i,
    /NATIVE_APP_ORIGINS/,
    /X-PrivCloud-Native/i,
    /native\/claim/i,
    /fr\.privcloud\.sharing/i,
    /\bAndroid (?:client|relay|app)\b/i,
  ];

  for (const relativePath of backendFiles) {
    const source = await read(relativePath);
    for (const pattern of forbiddenBackendMarkers) {
      assert.doesNotMatch(
        source,
        pattern,
        `${relativePath} matched ${pattern}`,
      );
    }
  }
  assert.equal(
    backendFiles.some((file) =>
      /(?:^|[\/])(?:realtime|nativeOAuth|nativeOrigins)(?:[.\/]|$)/i.test(file),
    ),
    false,
  );
  assert.equal(backendPackage.dependencies?.ws, undefined);
  assert.equal(backendPackage.devDependencies?.["@types/ws"], undefined);
  assert.equal(
    integrationFiles.some((file) =>
      /(?:^|[\\/])(?:android|ios-share|mobile-pwa|capacitor|gradle)(?:[\\/]|$)/i.test(
        file,
      ),
    ),
    false,
  );
});

test("WebDAV stays authenticated but free of plan/subscription guards", async () => {
  const [appModule, controller, modal] = await Promise.all([
    read("backend/src/app.module.ts"),
    read("backend/src/webdav/webdav-proxy.controller.ts"),
    read("frontend/src/components/upload/WebDavImportModal.tsx"),
  ]);

  assert.match(appModule, /WebDavModule/);
  assert.match(controller, /@UseGuards\(JwtGuard\)/);
  assert.doesNotMatch(controller, /(?:Plan|Premium|Subscription).*Guard/i);
  assert.match(modal, /listWebDavViaProxy/);
  assert.match(modal, /downloadWebDavViaProxy/);
  assert.match(modal, /isOpenSourceBridgeCompatible/);
});

test("the distributed Companion proves local OSS authorization", async () => {
  const [bridge, integrationPage, installer, dockerfile, fullDockerfile] =
    await Promise.all([
      read("bridge/src/privcloud-bridge.mjs"),
      read("frontend/src/pages/integrations/index.tsx"),
      read("bridge/install/install-linux-dev.sh"),
      read("Dockerfile"),
      read("Dockerfile.full-build"),
    ]);

  assert.match(bridge, /openSourceLocalAuthorization:\s*true/);
  assert.match(
    bridge,
    /req\.method === "POST" && url\.pathname === "\/v1\/tokens"/,
  );
  assert.doesNotMatch(bridge, /grant\/redeem|premium_client_plan_required/i);
  assert.match(
    integrationPage,
    /\/install\/companion\/install\/install-linux-dev\.sh/,
  );
  assert.doesNotMatch(
    integrationPage,
    /\/install\/beta|BETA_VERSION|android-companion/i,
  );
  assert.match(installer, /PRIVCLOUD_BRIDGE_ORIGINS/);
  assert.match(installer, /PRIVCLOUD_COMPANION_NATIVE_ORIGINS/);
  assert.match(
    dockerfile,
    /COPY .*bridge\/install .*install\/companion\/install/,
  );
  assert.match(
    fullDockerfile,
    /COPY .*bridge\/install .*install\/companion\/install/,
  );
});

test("the public CSP permits same-origin and decrypted blob previews", async () => {
  for (const relativePath of [
    "reverse-proxy/Caddyfile",
    "reverse-proxy/Caddyfile.trust-proxy",
  ]) {
    const caddyfile = await read(relativePath);
    const csp = caddyfile
      .split("\n")
      .find((line) => line.includes("Content-Security-Policy"));
    assert.ok(csp, `${relativePath} must set a Content-Security-Policy`);
    assert.match(csp, /frame-src 'self' blob:/);
    assert.match(csp, /frame-ancestors 'self'/);
    assert.match(csp, /object-src 'none'/);
  }
});

test("client tools have explicit reproducible packaging commands", async () => {
  const [rootPackage, bridgePackage, companionBuild, integrationBuild] =
    await Promise.all([
      read("package.json").then(JSON.parse),
      read("bridge/package.json").then(JSON.parse),
      read("bridge/scripts/build-release.mjs"),
      read("integrations/scripts/build.mjs"),
    ]);
  assert.match(rootPackage.scripts["build:companion"], /bridge run build/);
  assert.match(
    rootPackage.scripts["build:integrations"],
    /integrations\/scripts\/build/,
  );
  assert.match(rootPackage.scripts["build:client-tools"], /build:companion/);
  assert.match(rootPackage.scripts["build:client-tools"], /build:integrations/);
  assert.match(bridgePackage.scripts.build, /build-release\.mjs/);
  assert.match(companionBuild, /SHA256SUMS/);
  assert.match(integrationBuild, /createStoredZip/);
  assert.match(integrationBuild, /--base-url/);
});

test("ignored private artifacts cannot leak into an OSS container", async () => {
  const [dockerIgnore, gitIgnore, proxy] = await Promise.all([
    read(".dockerignore"),
    read(".gitignore"),
    read("frontend/src/proxy.ts"),
  ]);
  assert.match(dockerIgnore, /frontend\/public\/install\/beta\//);
  assert.match(gitIgnore, /frontend\/public\/install\/beta\//);
  assert.doesNotMatch(proxy, /\/install\/beta/);
});

test("GitHub Actions publishes container images only to GHCR", async () => {
  const workflowPaths = await allFiles(".github/workflows");
  const publishingWorkflows = [];
  for (const workflowPath of workflowPaths) {
    const workflow = await read(workflowPath);
    assert.doesNotMatch(workflow, /DOCKER_(?:USERNAME|PASSWORD)/);
    assert.doesNotMatch(workflow, /(?:docker\.io|registry-1\.docker\.io)/i);
    if (
      /docker\/build-push-action|docker push|buildx build[^\n]*--push/.test(
        workflow,
      )
    ) {
      publishingWorkflows.push(workflowPath);
    }
  }
  assert.deepEqual(publishingWorkflows, [
    ".github/workflows/build-docker-image.yml",
  ]);

  const buildWorkflow = await read(".github/workflows/build-docker-image.yml");
  assert.match(buildWorkflow, /REGISTRY:\s*ghcr\.io/);
  assert.match(
    buildWorkflow,
    /images:\s*\$\{\{ env\.REGISTRY \}\}\/\$\{\{ env\.IMAGE_NAME \}\}/,
  );
  assert.match(buildWorkflow, /registry:\s*\$\{\{ env\.REGISTRY \}\}/);
});

test("all release packages stay on the same version", async () => {
  const manifests = [
    "package.json",
    "backend/package.json",
    "frontend/package.json",
    "bridge/package.json",
    "docs/package.json",
    "scripts/package.json",
  ];
  const versions = await Promise.all(
    manifests.map(async (manifest) => JSON.parse(await read(manifest)).version),
  );
  assert.equal(
    new Set(versions).size,
    1,
    JSON.stringify({ manifests, versions }),
  );

  // The Companion advertises its version from a source constant, outside any
  // manifest: without this check a release bump leaves it behind and only the
  // packaging script catches it.
  const companion = await read("bridge/src/privcloud-bridge.mjs");
  assert.equal(
    /const VERSION = "([^"]+)";/.exec(companion)?.[1],
    versions[0],
    "bridge/src/privcloud-bridge.mjs must declare the released version",
  );

  const lockfiles = [
    "package-lock.json",
    "backend/package-lock.json",
    "frontend/package-lock.json",
    "docs/package-lock.json",
    "scripts/package-lock.json",
  ];
  const lockVersions = await Promise.all(
    lockfiles.map(async (lockfile) => {
      const lock = JSON.parse(await read(lockfile));
      return [lock.version, lock.packages?.[""]?.version];
    }),
  );
  assert.deepEqual(
    new Set(lockVersions.flat()),
    new Set([versions[0]]),
    JSON.stringify({ lockfiles, lockVersions }),
  );
});

test("E2E deletion opt-out is enforced in both policy and app lifecycle", async () => {
  const [policy, app, userService] = await Promise.all([
    read("frontend/src/utils/e2ePromptPolicy.util.ts"),
    read("frontend/src/pages/_app.tsx"),
    read("backend/src/user/user.service.ts"),
  ]);
  assert.match(policy, /e2eAutoGenerationDisabled/);
  assert.match(app, /shouldPromptForE2EKey/);
  assert.match(app, /cancelled = true/);
  assert.match(userService, /e2eAutoGenerationDisabledAt:\s*new Date\(\)/);
});
