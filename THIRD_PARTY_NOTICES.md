# Third-party notices

## FFmpeg

Rewind's installer includes FFmpeg (`ffmpeg.exe`, `ffprobe.exe` and its shared libraries), which Rewind runs as a separate program for capture, encoding and editing.

- FFmpeg is licensed under the **GNU Lesser General Public License v2.1 or later** (LGPL). The build used is an LGPL-only build, with no GPL or non-free components.
- Build: `ffmpeg-master-latest-win64-lgpl-shared` from https://github.com/BtbN/FFmpeg-Builds (`scripts/get-ffmpeg.ps1` fetches the exact package).
- Source code: https://ffmpeg.org/download.html and https://github.com/BtbN/FFmpeg-Builds
- The full license text ships with the app as `ffmpeg/LICENSE.txt` in the install folder.

FFmpeg is a trademark of Fabrice Bellard, originator of the FFmpeg project. Rewind is not affiliated with or endorsed by the FFmpeg project.

## Rust and JavaScript dependencies

Rewind is built with Tauri, React, cpal, the `windows` crate and other open-source libraries under MIT, Apache-2.0 and similar licenses. See `src-tauri/Cargo.lock` and `pnpm-lock.yaml` for the full list.
