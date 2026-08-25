import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const bridgeDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("the Linux installer validates and installs the Companion with Node.js 24", async (t) => {
  const testDirectory = await mkdtemp(
    path.join(os.tmpdir(), "privcloud-companion-installer-"),
  );
  t.after(() => rm(testDirectory, { recursive: true, force: true }));

  const homeDirectory = path.join(testDirectory, "home");
  const mockBinDirectory = path.join(testDirectory, "bin");
  await mkdir(homeDirectory, { recursive: true });
  await mkdir(mockBinDirectory, { recursive: true });

  const curlMock = path.join(mockBinDirectory, "curl");
  await writeFile(
    curlMock,
    `#!/bin/sh
set -eu
output=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      output="$2"
      shift 2
      ;;
    http://*|https://*)
      url="$1"
      shift
      ;;
    *)
      shift
      ;;
  esac
done
case "$url" in
  */privcloud-companion.mjs)
    cp "$MOCK_COMPANION_SOURCE" "$output"
    ;;
  */register-native-messaging.sh)
    cp "$MOCK_NATIVE_MESSAGING_INSTALLER" "$output"
    ;;
  *)
    echo "Unexpected installer URL: $url" >&2
    exit 1
    ;;
esac
`,
  );
  await chmod(curlMock, 0o755);

  for (const command of ["pkill", "nohup", "systemctl"]) {
    const mock = path.join(mockBinDirectory, command);
    await writeFile(mock, "#!/bin/sh\nexit 1\n");
    await chmod(mock, 0o755);
  }

  const result = spawnSync(
    "sh",
    [path.join(bridgeDirectory, "install/install-linux-dev.sh")],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: homeDirectory,
        MOCK_COMPANION_SOURCE: path.join(
          bridgeDirectory,
          "src/privcloud-bridge.mjs",
        ),
        MOCK_NATIVE_MESSAGING_INSTALLER: path.join(
          bridgeDirectory,
          "install/linux/register-native-messaging.sh",
        ),
        PATH: `${mockBinDirectory}:${process.env.PATH}`,
        PRIVCLOUD_BASE_URL: "http://127.0.0.1:3000",
      },
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(
    result.stdout,
    /PrivCloud Companion installed for http:\/\/127\.0\.0\.1:3000\./,
  );

  const installedSource = path.join(
    homeDirectory,
    ".local/share/privcloud-companion/privcloud-companion.mjs",
  );
  await access(installedSource);
  assert.match(await readFile(installedSource, "utf8"), /const VERSION/);
  await assert.rejects(
    access(
      path.join(
        homeDirectory,
        ".local/share/privcloud-companion/privcloud-companion.tmp.mjs",
      ),
    ),
  );

  const launcher = await readFile(
    path.join(homeDirectory, ".local/bin/privcloud-companion"),
    "utf8",
  );
  assert.match(
    launcher,
    /PRIVCLOUD_BRIDGE_ORIGINS='http:\/\/127\.0\.0\.1:3000'/,
  );
});
