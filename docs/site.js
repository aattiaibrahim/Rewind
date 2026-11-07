// Real numbers next to the Download button, straight from GitHub. If GitHub
// can't be reached, the numbers written into the page stay.
(function () {
  var repo = "aattiaibrahim/hindsight";
  var mb = function (b) { return Math.round(b / 1048576) + " MB"; };
  var day = function (iso) { return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }); };
  var set = function (id, text) { var el = document.getElementById(id); if (el && text) el.textContent = text; };
  var installer = function (r) { return (r.assets || []).find(function (a) { return /x64-setup\.exe$/i.test(a.name); }); };

  fetch("https://api.github.com/repos/" + repo + "/releases?per_page=100")
    .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(function (list) {
      var apps = list.filter(function (r) { return /^v\d/.test(r.tag_name) && !r.prerelease && !r.draft; });
      if (!apps.length) return;
      var latest = apps[0];
      var exe = installer(latest);
      var total = apps.reduce(function (n, r) { var a = installer(r); return n + (a ? a.download_count : 0); }, 0);
      set("fact-version", "Version " + latest.tag_name.replace(/^v/, ""));
      if (exe) set("fact-size", mb(exe.size));
      set("fact-date", "Released " + day(latest.published_at));
      if (total) set("fact-downloads", total.toLocaleString() + " downloads");
      document.querySelectorAll("[data-download-label]").forEach(function (a) { a.textContent = "Download " + latest.tag_name.replace(/^v/, ""); });

      var log = document.getElementById("changelog");
      if (log) {
        log.innerHTML = "";
        apps.forEach(function (r) {
          var el = document.createElement("article");
          el.className = "release";
          var h = document.createElement("h3");
          var a = document.createElement("a");
          a.href = r.html_url;
          a.textContent = r.name || r.tag_name;
          var t = document.createElement("time");
          t.dateTime = r.published_at;
          t.textContent = day(r.published_at);
          h.append(a, t);
          var p = document.createElement("p");
          p.className = "notes";
          // Release notes end with install instructions; only the changes are shown here.
          p.textContent = (r.body || "").split(/\n#+\s*Install/i)[0].replace(/\*\*|__|`/g, "").trim() || "Bug fixes and improvements.";
          el.append(h, p);
          log.append(el);
        });
      }
    })
    .catch(function () {
      var log = document.getElementById("changelog");
      if (log) log.innerHTML = '<p>Couldn\'t load the releases just now. <a href="https://github.com/' + repo + '/releases">See them on GitHub</a>.</p>';
    });
})();
