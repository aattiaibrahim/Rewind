# Rules

## Always ask first
- **Publishing:** releasing the app, publishing the server image, deploying to the NAS, or deleting a package needs the user's explicit yes, every time.
- **Downloads:** ask before any new download, naming the file, where it comes from and its size.

## Never
- Commit the updater signing key (`%USERPROFILE%\.tauri\rewind-updater.key`).
- Put the user's NAS address, NAS hostname or other personal details in the repo (it's public).
- Put player names or chat in screenshots. Use the dev mock's data.
- Play audio in tests or previews.
- Enter passwords. The TrueNAS sign-in is the user's to do.
- Install or launch the user's installed apps from the shell. Anything launched from this shell runs inside Claude's own environment.
- Delete clips for good, or touch a clip without a way back. Healing and repairs are reviewed one by one, and originals are kept or sent to the Recycle Bin.

## Commits
- End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Commit only files the current task changed. Another session may be working in `server/` at the same time.

## Talking to the user
- They want questions when something is unclear, and options to pick from (mockups) for visual decisions.
- Keep messages short and plain. They follow along on a task list.
