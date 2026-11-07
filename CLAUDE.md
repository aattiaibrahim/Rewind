# Hindsight (repo folder "Rewind")

A Windows game clipper (Tauri 2 + React + Rust, NVIDIA NVENC), its NAS web app (`server/`), and its website (`docs/`).
The app was called Rewind; the internal name (`productName`, `com.rewind.app`, `rewind.exe`) stays Rewind so updates install
over the same app. Everything users see says Hindsight.

**Read `context/` before exploring the code.** It's kept short on purpose:

- `context/architecture.md`: where everything lives (Rust modules, React views, server, website), and where data is stored.
- `context/workflows.md`: build, test, preview, screenshots, releasing the app and the server image, the website.
- `context/conventions.md`: the look (N5 floating panels), icons, writing style, and how to edit files safely here.
- `context/rules.md`: things that must always or never happen (publishing, privacy, safety of clips).
- `context/history.md`: what each recent release added, and what's still open.

Keep these files up to date when something they describe changes.
