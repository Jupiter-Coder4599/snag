// Everything Instagram-specific lives here, so when Instagram changes
// something, this is the only file that should need edits.

export const LOGIN_URL = 'https://www.instagram.com/accounts/login/';

// A tiny page on instagram.com. The hidden WebView sits here so it can make
// same-origin requests with your login, without loading the whole feed.
export const BRIDGE_URL = 'https://www.instagram.com/robots.txt';

// Plain mobile Chrome user agent (Instagram treats the default WebView agent worse).
export const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 14; SM-S921U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

// Matches instagram.com/reel/CODE, /reels/CODE, /p/CODE, /tv/CODE,
// and instagram.com/username/reel/CODE. Ignores ?igsh=... tracking.
const LINK_RE = /instagram\.com\/(?:[A-Za-z0-9_.]+\/)?(reels?|p|tv)\/([A-Za-z0-9_-]+)/i;

export function parseInstagramLink(text) {
  if (!text) return null;
  const m = String(text).match(LINK_RE);
  if (!m) return null;
  const kind = m[1].toLowerCase().startsWith('reel') ? 'reel' : m[1].toLowerCase();
  return { code: m[2], url: `https://www.instagram.com/${kind}/${m[2]}/` };
}

// Runs on every page load in the WebView: reports whether you're logged in.
export const SESSION_SCRIPT = `
(function () {
  function report() {
    try {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'session',
        loggedIn: /(?:^|; )ds_user_id=/.test(document.cookie)
      }));
    } catch (e) {}
  }
  report();
  if (!window.__snagTimer) window.__snagTimer = setInterval(report, 3000);
})();
true;
`;

// Injected into the WebView to find the video file(s) for one post.
// Runs inside instagram.com with your own session — no outside servers.
export function buildExtractScript(reqId, code) {
  return `
(async function () {
  var reqId = ${JSON.stringify(reqId)};
  var code = ${JSON.stringify(code)};
  function send(o) {
    o.type = 'extract';
    o.reqId = reqId;
    window.ReactNativeWebView.postMessage(JSON.stringify(o));
  }
  function best(list) {
    if (!list || !list.length) return null;
    var sorted = list.slice().sort(function (a, b) {
      return (b.width * b.height || 0) - (a.width * a.height || 0);
    });
    return sorted[0].url;
  }
  try {
    // Shortcode -> numeric media id (base64-style alphabet).
    var A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    var c = code.length > 11 ? code.slice(0, 11) : code;
    var n = BigInt(0);
    for (var i = 0; i < c.length; i++) {
      var k = A.indexOf(c[i]);
      if (k < 0) throw new Error('That link has an unexpected post code.');
      n = n * BigInt(64) + BigInt(k);
    }

    // Method 1: Instagram's own web API (same one instagram.com uses).
    var res = await fetch('/api/v1/media/' + n.toString() + '/info/', {
      credentials: 'include',
      headers: { 'X-IG-App-ID': '936619743392459', 'X-Requested-With': 'XMLHttpRequest' }
    });
    if (res.ok) {
      var j = await res.json();
      var item = j.items && j.items[0];
      if (item) {
        var parts = item.carousel_media && item.carousel_media.length ? item.carousel_media : [item];
        var urls = parts.map(function (p) { return best(p.video_versions); }).filter(Boolean);
        if (urls.length) {
          send({ ok: true, urls: urls, username: (item.user && item.user.username) || null });
          return;
        }
        send({ ok: false, error: 'This post has no video in it.' });
        return;
      }
    }

    // Method 2: read the video address out of the post page itself.
    var page = await fetch('/reel/' + code + '/', { credentials: 'include' });
    var html = await page.text();
    var found = [];
    var re = /"video_url":"((?:[^"\\\\]|\\\\.)+)"/g;
    var m;
    while ((m = re.exec(html))) {
      try { found.push(JSON.parse('"' + m[1] + '"')); } catch (e) {}
    }
    found = found.filter(function (u, idx) { return found.indexOf(u) === idx; });
    if (found.length) {
      send({ ok: true, urls: found, username: null });
      return;
    }

    if (res.status === 401 || res.status === 403) {
      send({ ok: false, error: "Instagram wants you logged in. Log in, then retry." });
    } else {
      send({ ok: false, error: "Instagram didn't return a video for this link (status " + res.status + "). It may be private or removed." });
    }
  } catch (e) {
    send({ ok: false, error: 'Lookup failed: ' + ((e && e.message) || e) });
  }
})();
true;
`;
}
