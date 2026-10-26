import { chmod, copyFile, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

import { remoteHelperTargets } from "../src/feature/machines/remote-protocol";
import { nativeLibrary, appDirectory } from "./config";

/**
 * The SSH helper is chosen by probing the *remote* machine over SSH, so SSH
 * support needs a helper per remote platform. macOS targets must be built on
 * macOS, so a Linux build ships Linux-only and SSH to macOS remotes fails with
 * "The bundled SSH helper is missing or damaged" until a macOS-packaged helper
 * set is merged in. Local repositories are unaffected.
 */
const helperTargets = remoteHelperTargets.filter((target) =>
	target.startsWith("linux-")
);

if (process.platform !== "linux" || process.arch !== "x64") {
	throw new Error("Linux packaging currently supports x64 only.");
}

// Sharp and its platform packages resolve from sharp's own location, the same
// anchor the macOS bundle uses; they are not reachable from this workspace root.
const require = createRequire(import.meta.resolve("sharp"));

const appDir = resolve(appDirectory, "dist/appdir");
const usr = resolve(appDir, "usr");
const bin = resolve(usr, "bin");
const lib = resolve(usr, "lib");
const share = resolve(usr, "share");

/** Libraries the addon links directly; an AppImage cannot assume host versions. */
const bundledLibraries = [
	"libxcb.so.1",
	"libxkbcommon.so.0",
	"libxkbcommon-x11.so.0",
	"libXau.so.6",
	"libXdmcp.so.6",
] as const;

/** Same external runtime Sharp needs as the macOS bundle. */
const imagePackages = [
	"sharp",
	"@img/sharp-linux-x64",
	"@img/sharp-libvips-linux-x64",
	"@img/colour",
	"detect-libc",
	"semver",
] as const;

const run = async (command: string[]): Promise<void> => {
	const child = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" });

	if ((await child.exited) !== 0)
		throw new Error(`Command failed: ${command.join(" ")}`);
};

await rm(appDir, { recursive: true, force: true });

await mkdir(bin, { recursive: true });
await mkdir(lib, { recursive: true });
await mkdir(resolve(share, "applications"), { recursive: true });
await mkdir(resolve(share, "icons/hicolor/256x256/apps"), { recursive: true });

// The JS bundle is loaded by the launcher at startup; the addon and the image
// runtime stay on disk beside it, because NAPI addons cannot be embedded.
await run([
	process.execPath,
	"build",
	"src/main.tsx",
	"--target=bun",
	"--production",
	"--external=sharp",
	"--outfile",
	resolve(usr, "lib/1git/app.js"),
]);
await copyFile(nativeLibrary, resolve(usr, "lib/1git/gpuix-native.node"));

for (const name of imagePackages) {
	const manifest = require.resolve(`${name}/package.json`);

	await cp(dirname(manifest), resolve(usr, "lib/1git/node_modules", name), {
		recursive: true,
		dereference: true,
	});
}

await run([
	process.execPath,
	"run",
	"native/build-remote-helpers.ts",
	...helperTargets,
]);
await mkdir(resolve(usr, "lib/1git/remote-helpers"));

for (const target of helperTargets) {
	for (const extension of ["gz", "json"]) {
		await copyFile(
			resolve(appDirectory, `build/remote-helpers/${target}.${extension}`),
			resolve(usr, `lib/1git/remote-helpers/${target}.${extension}`)
		);
	}
}

// The compiled-bun runtime has no node_modules resolution, so a NAPI addon
// loaded through a bare specifier inside it always fails. Keep the JS bundle on
// disk, as the macOS .app does, and ship the running bun binary beside it: the
// launcher then needs no host bun, and sharp resolves its @img runtime from the
// sibling node_modules.
await copyFile(process.execPath, resolve(usr, "lib/1git/bun"));
await chmod(resolve(usr, "lib/1git/bun"), 0o755);

// Resolve through ldconfig rather than a hardcoded multiarch path: runners and
// Arch hosts put the same libraries in different directories. Entries are
// "name (libc...) => path", and names are prefixes of one another.
const ldconfig = Bun.spawn(["ldconfig", "-p"], { stdout: "pipe" });

const libraryPaths = new Map(
	(await new Response(ldconfig.stdout).text())
		.split("\n")
		.map((line) => /^\t(\S+) \(.*\) => (\S+)$/u.exec(line))
		.filter((entry): entry is RegExpExecArray => entry !== null)
		.map(([, name, path]) => [name, path] as const)
);

for (const library of bundledLibraries) {
	const located = libraryPaths.get(library);

	if (!located) throw new Error(`Could not locate ${library} on this system.`);

	await copyFile(located, resolve(lib, library));
}

await copyFile(
	resolve(appDirectory, "../../apps/web/public/apple-touch-icon.png"),
	resolve(share, "icons/hicolor/256x256/apps/1git.png")
);
await copyFile(
	resolve(appDirectory, "../../LICENSE"),
	resolve(appDir, "LICENSE.txt")
);

await writeFile(
	resolve(bin, "1git"),
	`#!/bin/sh
# Resolve the bundle location whether invoked via a symlink or the mount point.
HERE=$(dirname "$(readlink -f "$0")")
ROOT="$HERE/.."
export NAPI_RS_NATIVE_LIBRARY_PATH="$ROOT/lib/1git/gpuix-native.node"
export GPUIX_REMOTE_HELPERS_DIR="$ROOT/lib/1git/remote-helpers"
# The addon and sharp's runtime sit beside this bundle in lib/1git.
exec "$ROOT/lib/1git/bun" run "$ROOT/lib/1git/app.js"
`
);
await chmod(resolve(bin, "1git"), 0o755);

await writeFile(
	resolve(share, "applications/1git.desktop"),
	`[Desktop Entry]
Type=Application
Name=1git
Comment=A native Git workspace with local and SSH repositories
Exec=1git
Icon=1git
Categories=Development;RevisionControl;
Terminal=false
StartupWMClass=1git
`
);

process.stdout.write(`Assembled AppDir at ${appDir}\n`);
