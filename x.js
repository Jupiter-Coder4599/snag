// X (Twitter) support. Uses X's own public embed service, the one that powers
// embedded posts on websites. No login, and nothing outside X is contacted.
import { MOBILE_UA } from './instagram';

// x.com/user/status/123, twitter.com/..., mobile.twitter.com/..., x.com/i/status/123
const LINK_RE =
  /(?:^|[^a-z0-9.])(?:(?:www|mobile)\.)?(?:x|twitter)\.com\/(?:#!\/)?([A-Za-z0-9_]{1,15}|i(?:\/web)?)\/status(?:es)?\/(\d{5,25})/i;

export function parseXLink(text) {
  if (!text) return null;
  const m = String(text).match(LINK_RE);
  if (!m) return null;
  const user = /^i(\/web)?$/i.test(m[1]) ? 'i' : m[1];
  return { site: 'x', code: m[2], url: `https://x.com/${user}/status/${m[2]}` };
}

function embedToken(id) {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

function fullSizePhoto(url) {
  return url.includes('?') ? url : `${url}?name=orig`;
}

// Returns { media: [{ kind, url }], username }
export async function extractX(id) {
  const url = `https://cdn.syndication.twimg.com/tweet-result?id=${id}&lang=en&token=${embedToken(id)}`;
  const res = await fetch(url, { headers: { 'User-Agent': MOBILE_UA, Accept: 'application/json' } });

  if (res.status === 404) throw new Error("X says that post doesn't exist or isn't public.");
  if (!res.ok) throw new Error(`X didn't answer (status ${res.status}). Try again in a bit.`);

  const text = await res.text();
  if (!text) {
    throw new Error("X sent nothing back. Age-restricted or sensitive posts can't be downloaded without logging in.");
  }
  const data = JSON.parse(text);
  if (data.__typename === 'TweetTombstone') {
    throw new Error('X is hiding this post. It may be protected, age-restricted or deleted.');
  }

  const media = (data.mediaDetails || [])
    .map((m) => {
      if (m.type === 'photo') return { kind: 'photo', url: fullSizePhoto(m.media_url_https) };
      // Videos and GIFs: take the highest-quality MP4.
      const mp4 = (m.video_info?.variants || [])
        .filter((v) => v.content_type === 'video/mp4')
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
      return mp4 ? { kind: 'video', url: mp4.url } : null;
    })
    .filter(Boolean);

  if (!media.length) throw new Error('That post has no photos or videos.');
  return { media, username: data.user?.screen_name || null };
}
