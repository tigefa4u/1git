---
name: screenshot
description: |
  Capture screenshots of the 1git native GPUIX app on Linux for visual verification,
  including a live-preview loop that re-captures the window after each edit.
  Use when previewing UI changes, verifying a window renders, watching an edit land,
  or capturing proof of a native surface. Targets Omarchy/Hyprland (Wayland)
  with grim and hyprctl.
metadata:
  version: 1.0.0
  platform: linux-x64 (Omarchy / Hyprland / Wayland)
---

# Screenshot the 1git app

Capture the app window without the rest of the desktop in frame, so the image
shows the surface under review and nothing that merely surrounds it.

## Prerequisites

The native addon must exist, or `preload.ts` throws before any import:

```bash
cd apps/gpuix && bun native/build.ts
```

Build once per patch-set change; a matching `build-id` makes it a no-op.
Requires the X11, xkbcommon, wayland, and vulkan development libraries, plus
`cargo` and `clang`.

## Launch in preview mode

`GPUIX_PREVIEW=1` skips session restore and repository discovery, opening the
app in its preview state with fixture content. Use it for UI work; use a plain
run when the real repository must load.

```bash
cd apps/gpuix
GPUIX_PREVIEW=1 bun --preload ./native/preload.ts src/main.tsx
```

Wait for `[gpuix] mount complete` on stdout before capturing: the window is
created before React finishes mounting, and a capture taken in between shows an
empty frame. Roughly 25-30 s on a cold native build, a few seconds after.

## Find the window

The GPUIX window has an **empty `class`** on Linux and title `1git`. Match on
the title, not the class:

```bash
hyprctl clients -j | bun -e '
const clients = JSON.parse(await Bun.stdin.text());
const win = clients.find((c) => c.title === "1git");
if (!win) {
  console.error("1git window not found; open clients:");
  for (const c of clients) console.error(" ", c.class || "(no class)", "|", c.title);
  process.exit(1);
}
const [x, y] = win.at;
const [w, h] = win.size;
console.log(`${x},${y} ${w}x${h}`);
'
```

`at` is the window origin including the Hyprland gap and border, and `size` is
the window body excluding them. `grim -g` takes the same coordinate system, so
the two compose directly.

## Capture

```bash
grim -g "<x>,<y> <w>x<h>" -t png /tmp/1git.png
```

`-t png` selects the format; `-g` restricts the region. A full-screen capture
with `grim -o <output>` or bare `grim` also works but includes the bar, other
windows, and the wallpaper, which usually hides the detail under review.

## Live preview while editing

To watch edits land without restarting the app, launch with `--hot` so HMR
re-renders in place, then re-capture the same window after each change.

```bash
cd apps/gpuix
GPUIX_PREVIEW=1 bun --preload ./native/preload.ts --hot src/main.tsx
```

On the first file save the app logs a remount and keeps running in one process:

```
[gpuix] created native window
[gpuix] mount complete
[gpuix] remount: unmount previous tree
[gpuix] remount complete
```

Only after `remount complete` is the new tree painted; a capture taken between
the two lines renders the previous edit. Wait for the line, or allow roughly
10 s, then re-capture with the same `grim -g` geometry from the launch session:

```bash
grim -g "<x>,<y> <w>x<h>" -t png /tmp/1git-edit2.png
```

Re-resolve the geometry with `hyprctl` if the window was moved or resized. This
is verified: editing a heading string while the app ran produced a capture
showing the new string, in the same process, with no restart.

### This is re-capture, not a stream

Nothing pushes frames out. GPUIX owns the surface and the addon exposes no frame
callback or image stream to JS, so each preview requires an explicit `grim` call.
`captureScreenshot()` is gated to macOS/Windows test-support builds and fails on
Linux, so it is not a substitute.

`--hot` reloads the whole tree, not just the edited module, so app-level state —
open tab, scroll position, expanded sections — resets on every change. That is
fine for tuning a specific surface, and a limitation when the state being
verified is itself stateful.

To confirm the change rather than assume it, pick an edit that is visibly
distinct (a marker string, a color, a size) so the difference is unambiguous in
the capture, and revert it when the preview is done.

## Verify the capture

Never report a screenshot as proof without looking at it:

```bash
read /tmp/1git.png
```

Confirm the expected content is actually present. A valid PNG is not evidence
that the window rendered: a capture taken before mount completes, or after the
app exited, is still a well-formed image of the desktop.

## Cleanup

Always kill the app when finished, so the next capture is unambiguous:

```bash
pkill -f "preload.ts"
```

Multiple GPUIX windows on the same workspace make the `title === "1git"` lookup
ambiguous. Kill leftovers first.

## Pitfalls

- **Empty frame** — captured before `mount complete`. Wait for the log line.
- **Wrong window** — the title match is `1git`, but Chromium tabs of this repo
  carry titles like `1git/bun.lock at master`. Match equality, not `includes`.
- **Nothing captured** — the app exited early. Read its stdout/stderr first;
  `preload.ts` failure and addon load failures are the usual causes.
- **Missing decorations in frame** — `titlebarTransparent: true`,
  `appOwnsTitlebarDrag: true`, and `windowBackground: "blurred"` are macOS
  options that Linux ignores. Capture at the window geometry to show the
  client area, which renders correctly.
- **Blur is absent** — Linux has no compositor blur equivalent of the macOS
  sidebar vibrancy, so the window background is flat. Not a rendering failure.
- **Stale frame after an edit** — captured between `remount` lines, so it shows
  the previous tree. Wait for `remount complete`.
- **Lost state after an edit** — `--hot` remounts the entire tree, resetting
  navigation and scroll position. Relaunch without `--hot` when state matters.

## Non-interactive capture

`omarchy capture screenshot fullscreen save` is the Omarchy-blessed path, but it
covers the whole screen. Prefer `grim -g` with the `hyprctl` geometry when the
screenshot must frame only the app.
