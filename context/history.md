# History (newest first)

## Not released yet (on main)
- **Desktop:** the N5 look (flat, black frame, soft panels), the slim icon rail, the bottom status bar, Lucide icons everywhere.
- **Website:** redone in the N5 look:
  - plain headline, demo video, live GitHub facts;
  - five feature rows, a fair comparison table, a footer on what the app sends, a changelog page;
  - Archivo headings.
- **Server image:** the old `rewind-server` image is no longer published.

## 0.1.30
- **Game logos:**
  - Steam icons from their newer address, and a stricter name match (no more "Minecraft Dungeons" for "Minecraft").
  - Aliases for renamed or delisted games, and a Logo… button to pick any picture.
- **Editor:** theater mode lasts only for the current clip.
- **Old folders:** emptied recorder folders can go to the Recycle Bin.
- **About:** KronorK in the beta testers.
- The first release named Hindsight (installer and title).

## 0.1.29
- **Pages and lists:** Notifications page, To trim section, Repair all.
- **NAS badge:** stays visible, with a red cross for clips not on the NAS yet.
- **Speed:** faster clip opening (the video loads first), instant back to the library, and thumbnails show at once.
- **Logos and colours:** Steam game logos, Windows blue plus 12 accents and the Tinted theme.
- **Fixes:** the Species Unknown folder merge, the AI download progress bar, and an icon cache refresh in the installer.

## 0.1.28 and earlier
- **0.1.28:** game detection from the picture (optional AI pack, off by default).
- **0.1.27:** notification centre, safer Cleanup, game picker, Try repair.
- **0.1.26:** auto encoder, safe NAS edits, faster library, On this day, Montage, duplicates, diagnostics.
- **0.1.24–0.1.25:** Discord track, NAS checksums, sync progress, heal with review.

## Open items
- **NAS app redesign:** the N5 look, game rows, To trim, notifications, Steam logos, which PC, and an editor matching the desktop. In progress in another session, not deployed.
- **User's TrueNAS:** still on the old image. It needs switching to `hindsight-server` (the user's sign-in is needed).
- **GitHub Actions billing lock:** if it's still there, the server image can't build.
- **The `rewind-server` package:** needs the user's `delete:packages` permission step before it can be deleted.
- **App's internal name:** still Rewind (install folder, exe). Renaming it safely needs a one-time migration.
