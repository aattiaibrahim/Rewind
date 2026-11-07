# Conventions

## The look: "N5 floating panels" (desktop, website and NAS app)
- **Window:** a black frame (`--frame: #000`) with 8px gaps, holding soft panels (`--bg: #181818`, 10px corners). Raised items are `--raised: #2a2a2a`.
- **Flat:** no glows, gradients or inset highlights. Gradients are only allowed where they do a job: the shade behind text on video, the slider fill, damage stripes, the download shimmer.
- **Buttons:** the main action is a white pill (`--primary: #fff`, black text); the others are grey pills. The accent colour (Windows blue `#4cc2ff` by default, chosen in Settings) is only for selection rings, progress, focus, toggles and the playhead.
- **Navigation:** a slim icon rail (60px) with labels on hover (`.nav-label`) and counts on the icon's corner. A status bar runs along the bottom.
- **Icons:** one set, Lucide (`src/icons.tsx` with `Icon name=...`; Studio imports `lucide-react` directly). No emoji or symbols as icons. Games with no logo get a gamepad on grey.
- **Themes and accents:** Tinted (default), Midnight, Graphite, OLED. 13 accents, including "system", which follows the Windows accent through the `system_accent` command.
- **Website:** the same tokens in `docs/site.css`, Archivo for headings, the system font for text.

## Writing (UI text, commit messages, notes)
- Plain, short, sentence case. Say what happens. No "simply" or "seamless", no exclamation marks.
- The UI speaks about the user's things as "your". Errors say what happened and what to do.
- Release notes are a few plain sentences about what changed for the user.

## Editing files here (Windows)
- **Multi-line edits:** write Python scripts to the scratchpad with the Write tool and run them with the full Python path (`C:\Users\Admin\AppData\Local\Programs\Python\Python314\python.exe`).
  - **Don't use bash heredocs for code containing backslashes or regexes.** They mangle `\`.
- Use the Edit tool for small exact changes. `sed -i` is fine for simple single-line ones.
- **Line endings:** git warns about LF to CRLF on every commit. That's normal.
- **Settings:** new fields need a default in `settings.rs` `Default`, the camelCase field in `api.ts` `Settings`, and a `devMock.ts` value.
- **Tauri commands:** register new ones in `lib.rs`'s `generate_handler!` list and give each a `devMock.ts` entry.

## Safety patterns already in place (reuse them)
- **Deleting:** always through the Recycle Bin (`library::discard` and `trash`), after `library::recycle_check`, which refuses when the bin would delete for good.
- **Moves:** go through `consolidate::run` with a log, so Undo works.
- **NAS:** copies are verified by SHA-256 read back uncached. Replaced NAS files are kept for 30 days in `.hindsight-replaced/`.
- **Background work:** waits while a game is running (`games::game_running()`), a recording is going, or a save or benchmark is running.
