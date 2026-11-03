import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useState } from "react";
import { api, errText, fmtSize, Settings, Upload, UPLOAD_HOSTS, UploadHost, UploadProgress } from "./api";

/** Live upload progress for every clip, plus each clip's past links. */
export function useUploads() {
  const [progress, setProgress] = useState<Record<string, UploadProgress>>({});
  const [history, setHistory] = useState<Record<string, Upload[]>>({});
  const refresh = useCallback(() => {
    api.uploadHistory().then(setHistory).catch(() => {});
  }, []);
  useEffect(() => {
    refresh();
    const un = listen<UploadProgress>("upload-progress", (e) => {
      const p = e.payload;
      setProgress((all) => {
        const next = { ...all, [p.path]: p };
        // Finished ones fade out of "in progress" after a moment.
        if (p.stage === "done" || p.stage === "error") {
          setTimeout(() => setProgress((a) => (a[p.path] === p ? (({ [p.path]: _, ...rest }) => rest)(a) : a)), 6000);
        }
        return next;
      });
      if (p.stage === "done") refresh();
    });
    return () => {
      un.then((f) => f());
    };
  }, [refresh]);
  return { progress, history, refresh };
}

export function hostLabel(h: UploadHost) {
  return UPLOAD_HOSTS.find((x) => x.id === h)?.label ?? h;
}

export function progressText(p: UploadProgress) {
  if (p.stage === "preparing") return "Making a shareable MP4…";
  if (p.stage === "uploading") return p.total ? `Uploading ${Math.round((p.sent / p.total) * 100)}%` : "Uploading…";
  if (p.stage === "done") return "Link copied";
  return p.error ?? "Upload failed";
}

/** Studio's Share box: pick a service, upload, copy or open the link. */
export function SharePanel({
  path,
  settings,
  progress,
  links,
}: {
  path: string;
  settings: Settings | null;
  progress: UploadProgress | undefined;
  links: Upload[] | undefined;
}) {
  const [host, setHost] = useState<UploadHost>(settings?.uploadHost ?? "catbox");
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => setHost(settings?.uploadHost ?? "catbox"), [settings?.uploadHost]);
  const busy = progress && (progress.stage === "preparing" || progress.stage === "uploading");
  const last = links?.[links.length - 1];
  const expired = last?.expires != null && last.expires < Date.now();
  const go = async () => {
    setErr(null);
    try {
      await api.uploadClip(path, host);
    } catch (e) {
      setErr(errText(e));
    }
  };
  const copy = (url: string) =>
    api.copyText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  const pct = progress?.stage === "uploading" && progress.total ? (progress.sent / progress.total) * 100 : progress?.stage === "preparing" ? 4 : 0;
  return (
    <div className="share-box">
      <div className="row" style={{ gap: 8 }}>
        <select className="select" value={host} onChange={(e) => setHost(e.target.value as UploadHost)} aria-label="Upload to" disabled={!!busy}>
          {UPLOAD_HOSTS.map((h) => (
            <option key={h.id} value={h.id}>
              {h.label}
            </option>
          ))}
        </select>
        <button className="btn primary" style={{ flex: 1 }} disabled={!!busy} onClick={go} title={UPLOAD_HOSTS.find((h) => h.id === host)?.hint}>
          {busy ? progressText(progress!) : "Upload & copy link"}
        </button>
      </div>
      {busy && (
        <div className="upload-bar" aria-hidden="true">
          <i style={{ width: `${pct}%` }} />
        </div>
      )}
      {(err || progress?.stage === "error") && <small className="err-text">{err ?? progress?.error}</small>}
      {last && !busy && (
        <div className="share-link">
          <small className="muted">
            {hostLabel(last.host)} · {fmtSize(last.bytes)}
            {last.expires != null && (expired ? " · expired" : ` · until ${new Date(last.expires).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`)}
          </small>
          <span className="link-text" title={last.url}>
            {last.url.replace(/^https?:\/\//, "")}
          </span>
          <span className="row" style={{ gap: 6 }}>
            <button className="btn small" disabled={expired} onClick={() => copy(last.url)}>
              {copied ? "Copied" : "Copy"}
            </button>
            <button className="btn small" disabled={expired} onClick={() => openUrl(last.url).catch(() => {})}>
              Open
            </button>
          </span>
        </div>
      )}
      <small className="muted" style={{ lineHeight: 1.45 }}>
        Uploads an MP4 that plays inside Discord for everyone (no Nitro). Anyone with the link can watch it.
      </small>
    </div>
  );
}

type Toggle = (p: { label: string; checked: boolean; onChange: (v: boolean) => void }) => React.ReactElement;

/** Settings → Sharing. Secrets (webhook, password) are sent once and never shown again. */
export function SharingSettings({
  s,
  set,
  Toggle,
  hidden,
  onError,
}: {
  s: Settings;
  set: (p: Partial<Settings>) => void;
  Toggle: Toggle;
  hidden?: boolean;
  onError: (m: string) => void;
}) {
  const [have, setHave] = useState({ discordWebhook: false, streamablePassword: false });
  const [hook, setHook] = useState("");
  const [pw, setPw] = useState("");
  const refresh = useCallback(() => {
    api.secretsSet().then(setHave).catch(() => {});
  }, []);
  useEffect(refresh, [refresh]);
  const save = async (name: "discord_webhook" | "streamable_password", value: string, done: () => void) => {
    try {
      await api.setSecret(name, value);
      done();
      refresh();
    } catch (e) {
      onError(errText(e));
    }
  };
  const host = UPLOAD_HOSTS.find((h) => h.id === s.uploadHost);
  return (
    <section className="group" hidden={hidden}>
      <h2>Sharing</h2>
      <label className="setting">
        <span>
          Upload to
          <small>{host?.hint}</small>
        </span>
        <select className="select" value={s.uploadHost} onChange={(e) => set({ uploadHost: e.target.value as UploadHost })}>
          {UPLOAD_HOSTS.map((h) => (
            <option key={h.id} value={h.id}>
              {h.label}
            </option>
          ))}
        </select>
      </label>
      {s.uploadHost === "litterbox" && (
        <label className="setting sub">
          <span>Keep clips on Litterbox for</span>
          <select className="select" value={s.litterboxTime} onChange={(e) => set({ litterboxTime: e.target.value as Settings["litterboxTime"] })}>
            <option value="1h">1 hour</option>
            <option value="12h">12 hours</option>
            <option value="24h">1 day</option>
            <option value="72h">3 days</option>
          </select>
        </label>
      )}
      <label className="setting">
        <span>
          Upload every new clip automatically
          <small>Each saved clip uploads in the background and its link is copied, ShareX-style. Clips are public to anyone with the link.</small>
        </span>
        <Toggle label="Auto-upload" checked={s.autoUpload} onChange={(v) => set({ autoUpload: v })} />
      </label>

      <div className="setting">
        <span>
          Discord webhook
          <small>
            {have.discordWebhook
              ? "Saved (stored encrypted on this PC)."
              : "In Discord: channel settings → Integrations → Webhooks → New Webhook → Copy Webhook URL."}
          </small>
        </span>
        <span className="row" style={{ flexWrap: "nowrap", flexShrink: 0 }}>
          {!have.discordWebhook && (
            <input
              className="text-input"
              type="password"
              placeholder="https://discord.com/api/webhooks/…"
              value={hook}
              onChange={(e) => setHook(e.target.value)}
              aria-label="Discord webhook address"
            />
          )}
          {have.discordWebhook ? (
            <button className="btn small" onClick={() => save("discord_webhook", "", () => {})}>
              Remove
            </button>
          ) : (
            <button className="btn small" disabled={!hook.trim()} onClick={() => save("discord_webhook", hook, () => setHook(""))}>
              Save
            </button>
          )}
        </span>
      </div>
      {s.uploadHost !== "discord" && (
        <label className="setting sub">
          <span>
            Also post the link to that channel
            <small>A link plays inline in Discord whatever the clip's size, so no 10 MB squeeze.</small>
          </span>
          <Toggle
            label="Post links to Discord"
            checked={s.postLinkToDiscord && have.discordWebhook}
            onChange={(v) => set({ postLinkToDiscord: v })}
          />
        </label>
      )}

      <div className="setting">
        <span>
          Streamable account
          <small>{have.streamablePassword ? `Signed in as ${s.streamableEmail || "?"} (password stored encrypted).` : "Only needed to upload to Streamable."}</small>
        </span>
        <span className="row" style={{ flexWrap: "nowrap", flexShrink: 0 }}>
          {!have.streamablePassword && (
            <>
              <input
                className="text-input"
                style={{ width: 150 }}
                placeholder="Email"
                value={s.streamableEmail}
                onChange={(e) => set({ streamableEmail: e.target.value })}
                aria-label="Streamable email"
              />
              <input
                className="text-input"
                style={{ width: 120 }}
                type="password"
                placeholder="Password"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                aria-label="Streamable password"
              />
            </>
          )}
          {have.streamablePassword ? (
            <button className="btn small" onClick={() => save("streamable_password", "", () => {})}>
              Sign out
            </button>
          ) : (
            <button className="btn small" disabled={!pw || !s.streamableEmail} onClick={() => save("streamable_password", pw, () => setPw(""))}>
              Save
            </button>
          )}
        </span>
      </div>
    </section>
  );
}
