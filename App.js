import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Linking,
  Modal,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { ShareIntentProvider, useShareIntentContext } from 'expo-share-intent';
import { Directory, File, Paths } from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library/legacy';
import {
  BRIDGE_URL,
  LOGIN_URL,
  MOBILE_UA,
  SESSION_SCRIPT,
  buildExtractScript,
  parseInstagramLink,
} from './instagram';
import { UNLOCK_MINUTES, getUnlockedUntil, hasPin, lockNow, setPin, verifyPin } from './pin';
import { addVideo, deleteVideoRow, listVideos, loadJobs, saveJobs, setVideoStatus } from './db';

const C = {
  bg: '#1B2025', // gunmetal
  surface: '#242A31',
  line: '#333A43',
  text: '#E6E8EB',
  muted: '#8A929B',
  accent: '#E8B04A', // amber
  ok: '#7CC4A4',
  bad: '#E3735E',
};

const ACTIVE = ['finding', 'saving'];

// Hosts Snag trusts. Anything else is blocked or opened in your browser.
const LOGIN_HOSTS = ['instagram.com', 'facebook.com'];
const VIDEO_HOSTS = ['cdninstagram.com', 'fbcdn.net'];

function hostOf(url) {
  const m = /^https:\/\/([^/?#:]+)/i.exec(url || '');
  return m ? m[1].toLowerCase() : null;
}

function hostIs(url, domains) {
  const host = hostOf(url);
  if (!host) return false;
  return domains.some((d) => host === d || host.endsWith('.' + d));
}

function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function jobsReducer(state, action) {
  switch (action.type) {
    case 'load':
      return action.jobs;
    case 'add':
      return [action.job, ...state];
    case 'update':
      return state.map((j) => (j.id === action.id ? { ...j, ...action.patch } : j));
    case 'remove':
      return state.filter((j) => j.id !== action.id);
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// PIN pad
// ---------------------------------------------------------------------------

function PinPad({ mode, onDone, onCancel }) {
  // mode: 'set' (new PIN, entered twice) or 'unlock'
  const [entry, setEntry] = useState('');
  const [first, setFirst] = useState(null);
  const [message, setMessage] = useState(null);
  const [working, setWorking] = useState(false);

  const title =
    mode === 'set'
      ? first
        ? 'Enter the PIN again'
        : 'Choose a PIN (4 to 8 digits)'
      : 'Enter your PIN';

  const press = (d) => {
    if (working) return;
    setMessage(null);
    if (d === 'del') setEntry((e) => e.slice(0, -1));
    else if (entry.length < 8) setEntry((e) => e + d);
  };

  const submit = async () => {
    if (entry.length < 4 || working) return;
    setWorking(true);
    try {
      if (mode === 'set') {
        if (!first) {
          setFirst(entry);
          setEntry('');
        } else if (first !== entry) {
          setFirst(null);
          setEntry('');
          setMessage("Those didn't match. Start again.");
        } else {
          onDone(await setPin(entry));
        }
      } else {
        const res = await verifyPin(entry);
        setEntry('');
        if (res.ok) onDone(res.until);
        else if (res.waitSec) setMessage(`Too many wrong tries. Wait ${res.waitSec} seconds.`);
        else setMessage(`Wrong PIN. ${res.triesLeft} tries left before a short lockout.`);
      }
    } finally {
      setWorking(false);
    }
  };

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'ok'];

  return (
    <View style={s.pinWrap}>
      <Text style={s.pinTitle}>{title}</Text>
      <Text style={s.pinSub}>
        Unlocks downloads for {UNLOCK_MINUTES} minutes.
      </Text>
      <View style={s.pinDots}>
        {Array.from({ length: Math.max(4, entry.length) }).map((_, i) => (
          <View key={i} style={[s.pinDot, i < entry.length && s.pinDotOn]} />
        ))}
      </View>
      <Text style={s.pinMsg}>{working ? 'Checking…' : message || ' '}</Text>
      <View style={s.pinGrid}>
        {keys.map((k) => (
          <Pressable
            key={k}
            onPress={() => (k === 'ok' ? submit() : press(k))}
            style={({ pressed }) => [
              s.pinKey,
              k === 'ok' && entry.length >= 4 && s.pinKeyOk,
              pressed && { opacity: 0.6 },
            ]}
          >
            <Text style={[s.pinKeyText, k === 'ok' && entry.length >= 4 && { color: C.bg }]}>
              {k === 'del' ? '⌫' : k === 'ok' ? 'OK' : k}
            </Text>
          </Pressable>
        ))}
      </View>
      <Pressable onPress={onCancel} hitSlop={12} style={{ marginTop: 20 }}>
        <Text style={s.pinCancel}>Not now</Text>
      </Pressable>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

function Snag() {
  const [jobs, dispatch] = useReducer(jobsReducer, []);
  const [videos, setVideos] = useState([]);
  const [input, setInput] = useState('');
  const [notice, setNotice] = useState(null);
  const [loggedIn, setLoggedIn] = useState(false);
  const [pageReady, setPageReady] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [pinState, setPinState] = useState({ ready: false, set: false, until: 0 });
  const [pinMode, setPinMode] = useState(null); // 'set' | 'unlock' | null
  const [detail, setDetail] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [tick, setTick] = useState(0);

  const webRef = useRef(null);
  const pending = useRef(new Map());
  const busy = useRef(false);
  const loaded = useRef(false);

  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext();
  const unlocked = pinState.set && pinState.until > now;

  const refreshVideos = () => {
    try {
      setVideos(listVideos());
    } catch {}
  };

  // ---------- startup ----------
  useEffect(() => {
    try {
      dispatch({ type: 'load', jobs: loadJobs() });
    } catch {}
    refreshVideos();
    loaded.current = true;
    (async () => {
      const set = await hasPin();
      const until = set ? await getUnlockedUntil() : 0;
      setPinState({ ready: true, set, until });
    })();
  }, []);

  // Clock for the unlock countdown.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!loaded.current) return;
    try {
      saveJobs(jobs);
    } catch {}
  }, [jobs]);

  // ---------- adding links ----------
  const addLink = useCallback(
    (text) => {
      const link = parseInstagramLink(text);
      if (!link) {
        setNotice("That isn't an Instagram post or reel link, so Snag ignored it.");
        return false;
      }
      const dupe = jobs.find(
        (j) => j.code === link.code && (j.status === 'queued' || ACTIVE.includes(j.status))
      );
      if (dupe) {
        setNotice('That one is already in the queue.');
        return false;
      }
      setNotice(null);
      dispatch({
        type: 'add',
        job: {
          id: `${Date.now()}-${link.code}`,
          code: link.code,
          url: link.url,
          status: 'queued',
          total: 0,
          done: 0,
          username: null,
          error: null,
          createdAt: Date.now(),
        },
      });
      // Ask for the PIN right away if downloads are locked.
      if (pinState.ready && !(pinState.set && pinState.until > Date.now())) {
        setPinMode(pinState.set ? 'unlock' : 'set');
      }
      return true;
    },
    [jobs, pinState]
  );

  // Links shared from Instagram land here.
  useEffect(() => {
    if (!hasShareIntent || !pinState.ready) return;
    addLink(shareIntent?.webUrl || shareIntent?.text || '');
    resetShareIntent();
  }, [hasShareIntent, shareIntent, resetShareIntent, addLink, pinState.ready]);

  // ---------- hidden Instagram page ----------
  const extract = (code) =>
    new Promise((resolve, reject) => {
      const reqId = Math.random().toString(36).slice(2);
      const timer = setTimeout(() => {
        pending.current.delete(reqId);
        reject(new Error('Instagram took too long to answer. Tap retry.'));
      }, 30000);
      pending.current.set(reqId, { resolve, reject, timer });
      webRef.current?.injectJavaScript(buildExtractScript(reqId, code));
    });

  const onMessage = (event) => {
    if (!hostIs(event.nativeEvent.url, ['instagram.com'])) return;
    let msg;
    try {
      msg = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }
    if (msg.type === 'session') {
      setLoggedIn(!!msg.loggedIn);
      return;
    }
    if (msg.type === 'extract') {
      const p = pending.current.get(msg.reqId);
      if (!p) return;
      clearTimeout(p.timer);
      pending.current.delete(msg.reqId);
      if (msg.ok) p.resolve(msg);
      else p.reject(new Error(msg.error));
    }
  };

  // ---------- login screen ----------
  const closeLogin = () => {
    setLoginOpen(false);
    webRef.current?.reload(); // pick up the new login in the hidden page
  };

  const onLoginMessage = (event) => {
    if (!hostIs(event.nativeEvent.url, ['instagram.com'])) return;
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === 'session' && msg.loggedIn) closeLogin();
    } catch {}
  };

  // Keep the login screen on Instagram; other sites open in your browser.
  const onLoginNavigate = (req) => {
    if (req.url === 'about:blank' || hostIs(req.url, LOGIN_HOSTS)) return true;
    if (/^https?:/i.test(req.url)) Linking.openURL(req.url).catch(() => {});
    return false;
  };

  // ---------- the download queue (one at a time) ----------
  useEffect(() => {
    if (busy.current || !loggedIn || !pageReady || loginOpen || !unlocked) return;
    const job = [...jobs].reverse().find((j) => j.status === 'queued'); // oldest first
    if (!job) return;

    const update = (patch) => dispatch({ type: 'update', id: job.id, patch });
    busy.current = true;

    (async () => {
      try {
        update({ status: 'finding', error: null });
        const found = await extract(job.code);

        // Refuse anything that isn't from Instagram's video servers, and log it.
        const bad = found.urls.filter((u) => !hostIs(u, VIDEO_HOSTS));
        if (bad.length) {
          for (const u of bad) {
            addVideo({
              jobId: job.id,
              account: found.username,
              postUrl: job.url,
              postCode: job.code,
              videoHost: hostOf(u) || 'unknown',
              trusted: false,
              status: 'blocked',
            });
          }
          refreshVideos();
          throw new Error("Blocked: the video came from a server that isn't Instagram's.");
        }

        const perm = await MediaLibrary.requestPermissionsAsync(true, ['video']);
        if (!perm.granted) {
          throw new Error('Allow Snag to save videos, then tap retry.');
        }

        update({ status: 'saving', total: found.urls.length, done: 0, username: found.username });
        const dir = new Directory(Paths.cache, 'snag');
        if (!dir.exists) dir.create();

        for (let i = 0; i < found.urls.length; i++) {
          const name = found.urls.length > 1 ? `${job.code}_${i + 1}.mp4` : `${job.code}.mp4`;
          const target = new File(dir, name);
          if (target.exists) target.delete();
          const file = await File.downloadFileAsync(found.urls[i], target);
          const asset = await MediaLibrary.createAssetAsync(file.uri);
          file.delete(); // the gallery has its own copy now
          addVideo({
            jobId: job.id,
            account: found.username,
            postUrl: job.url,
            postCode: job.code,
            videoHost: hostOf(found.urls[i]),
            trusted: true,
            fileName: asset?.filename || name,
            assetId: asset?.id,
            status: 'saved',
          });
          refreshVideos();
          update({ done: i + 1 });
        }
        dispatch({ type: 'remove', id: job.id }); // it lives in the saved table now
      } catch (e) {
        update({ status: 'failed', error: e?.message || String(e) });
      } finally {
        busy.current = false;
        setTick((t) => t + 1);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs, loggedIn, pageReady, loginOpen, unlocked, tick]);

  // ---------- actions ----------
  const submit = () => {
    if (addLink(input)) setInput('');
  };

  const onPinDone = (until) => {
    setPinState({ ready: true, set: true, until });
    setNow(Date.now());
    setPinMode(null);
  };

  const doLockNow = async () => {
    await lockNow();
    setPinState((p) => ({ ...p, until: 0 }));
  };

  const removeFromGallery = async (v) => {
    try {
      if (v.asset_id) {
        await MediaLibrary.requestPermissionsAsync(false, ['video']);
        const ok = await MediaLibrary.deleteAssetsAsync([v.asset_id]);
        if (!ok) return; // you tapped Deny on Android's confirm
      }
      setVideoStatus(v.id, 'removed');
      refreshVideos();
      setDetail(null);
    } catch (e) {
      setNotice(e?.message || 'Could not remove that video.');
    }
  };

  const forgetRow = (v) => {
    deleteVideoRow(v.id);
    refreshVideos();
    setDetail(null);
  };

  // ---------- status text ----------
  const waitingReason = () => {
    if (!pinState.set) return 'Waiting for you to set a PIN';
    if (!unlocked) return 'Waiting for your PIN';
    if (!loggedIn) return 'Waiting for you to log in to Instagram';
    return 'Queued';
  };

  const jobStatus = (job) => {
    switch (job.status) {
      case 'queued':
        return waitingReason();
      case 'finding':
        return 'Finding the video…';
      case 'saving':
        return job.total > 1 ? `Saving ${job.done + 1} of ${job.total}…` : 'Saving…';
      case 'failed':
        return job.error || 'Failed';
      default:
        return '';
    }
  };

  const minsLeft = Math.max(0, Math.ceil((pinState.until - now) / 60000));

  // ---------- render ----------
  const header = (
    <View>
      <View style={s.header}>
        <Text style={s.title}>Snag</Text>
        <Text style={s.sub}>Share a reel from Instagram to Snag and it saves to your gallery.</Text>
      </View>

      <View style={s.statusBlock}>
        <View style={s.statusRow}>
          <View style={[s.dot, { backgroundColor: unlocked ? C.ok : C.accent }]} />
          <Text style={s.statusText}>
            {!pinState.set
              ? 'Set a PIN to start downloading'
              : unlocked
                ? `Downloads unlocked for ${minsLeft} more min`
                : 'Downloads locked'}
          </Text>
          {pinState.ready && !pinState.set && (
            <Pressable style={s.smallBtn} onPress={() => setPinMode('set')}>
              <Text style={s.smallBtnText}>Set PIN</Text>
            </Pressable>
          )}
          {pinState.set && !unlocked && (
            <Pressable style={s.smallBtn} onPress={() => setPinMode('unlock')}>
              <Text style={s.smallBtnText}>Unlock</Text>
            </Pressable>
          )}
          {unlocked && (
            <Pressable style={s.smallBtn} onPress={doLockNow}>
              <Text style={s.smallBtnText}>Lock now</Text>
            </Pressable>
          )}
        </View>

        <View style={[s.statusRow, s.statusRowLast]}>
          <View style={[s.dot, { backgroundColor: loggedIn ? C.ok : C.bad }]} />
          <Text style={s.statusText}>
            {loggedIn ? 'Logged in to Instagram' : 'Log in to Instagram so Snag can find videos'}
          </Text>
          {!loggedIn && (
            <Pressable style={s.smallBtn} onPress={() => setLoginOpen(true)}>
              <Text style={s.smallBtnText}>Log in</Text>
            </Pressable>
          )}
        </View>
      </View>

      <View style={s.inputRow}>
        <TextInput
          style={s.input}
          value={input}
          onChangeText={setInput}
          placeholder="Or paste an Instagram link"
          placeholderTextColor={C.muted}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="go"
          onSubmitEditing={submit}
        />
        <Pressable style={s.goBtn} onPress={submit}>
          <Text style={s.goBtnText}>Download</Text>
        </Pressable>
      </View>
      {notice && <Text style={s.notice}>{notice}</Text>}

      {jobs.length > 0 && (
        <View style={s.section}>
          <Text style={s.sectionTitle}>In progress</Text>
          {jobs.map((job) => {
            const active = ACTIVE.includes(job.status);
            return (
              <Pressable
                key={job.id}
                style={[s.jobRow, active && s.jobRowActive]}
                onLongPress={() => !active && dispatch({ type: 'remove', id: job.id })}
              >
                <View style={{ flex: 1 }}>
                  <Text style={s.jobTitle} numberOfLines={1}>
                    {job.username ? `@${job.username}` : job.code}
                  </Text>
                  <Text style={[s.jobStatus, job.status === 'failed' && { color: C.bad }]}>
                    {jobStatus(job)}
                  </Text>
                </View>
                {active && <ActivityIndicator color={C.accent} />}
                {job.status === 'failed' && (
                  <Pressable
                    style={s.smallBtn}
                    onPress={() =>
                      dispatch({ type: 'update', id: job.id, patch: { status: 'queued', error: null } })
                    }
                  >
                    <Text style={s.smallBtnText}>Retry</Text>
                  </Pressable>
                )}
              </Pressable>
            );
          })}
        </View>
      )}

      <View style={s.section}>
        <Text style={s.sectionTitle}>Saved videos</Text>
        <View style={s.tableHead}>
          <Text style={[s.th, s.colAccount]}>Account</Text>
          <Text style={[s.th, s.colSource]}>Source</Text>
          <Text style={[s.th, s.colTime]}>Saved</Text>
        </View>
      </View>
    </View>
  );

  return (
    <SafeAreaView style={s.root} edges={['top', 'bottom']}>
      <StatusBar barStyle="light-content" />
      <View style={s.body}>
        <FlatList
          data={videos}
          keyExtractor={(v) => String(v.id)}
          ListHeaderComponent={header}
          contentContainerStyle={{ paddingBottom: 32 }}
          ListEmptyComponent={
            <Text style={s.empty}>
              Nothing saved yet. In Instagram, tap Share on a reel, then pick Snag.
            </Text>
          }
          renderItem={({ item: v }) => {
            const blocked = v.status === 'blocked';
            const removed = v.status === 'removed';
            return (
              <Pressable style={s.tr} onPress={() => setDetail(v)}>
                <Text style={[s.td, s.colAccount, removed && s.dim]} numberOfLines={1}>
                  {v.account ? `@${v.account}` : v.post_code}
                </Text>
                <Text
                  style={[s.td, s.colSource, { color: blocked ? C.bad : C.ok }, removed && s.dim]}
                  numberOfLines={1}
                >
                  {blocked ? `Blocked: ${v.video_host}` : removed ? 'Instagram (removed)' : 'Instagram ✓'}
                </Text>
                <Text style={[s.td, s.colTime, s.muted]} numberOfLines={1}>
                  {ago(v.saved_at)}
                </Text>
              </Pressable>
            );
          }}
        />

        {/* Hidden Instagram page that does the lookups. */}
        <View style={s.hiddenWeb} pointerEvents="none">
          <WebView
            ref={webRef}
            source={{ uri: BRIDGE_URL }}
            userAgent={MOBILE_UA}
            injectedJavaScript={SESSION_SCRIPT}
            onMessage={onMessage}
            onLoadStart={() => setPageReady(false)}
            onLoadEnd={() => setPageReady(true)}
            onShouldStartLoadWithRequest={(req) => hostIs(req.url, ['instagram.com'])}
            javaScriptEnabled
            domStorageEnabled
            thirdPartyCookiesEnabled
            sharedCookiesEnabled
            mediaPlaybackRequiresUserAction
            setSupportMultipleWindows={false}
            style={{ flex: 1 }}
          />
        </View>
      </View>

      {/* Login screen. Shares cookies with the hidden page. */}
      <Modal visible={loginOpen} animationType="slide" onRequestClose={closeLogin}>
        <SafeAreaProvider>
          <SafeAreaView style={s.root} edges={['top', 'bottom']}>
            <View style={s.modalBar}>
              <Text style={s.modalTitle}>Log in to Instagram</Text>
              <Pressable onPress={closeLogin} hitSlop={12}>
                <Text style={s.modalClose}>Close</Text>
              </Pressable>
            </View>
            <WebView
              source={{ uri: LOGIN_URL }}
              userAgent={MOBILE_UA}
              injectedJavaScript={SESSION_SCRIPT}
              onMessage={onLoginMessage}
              onShouldStartLoadWithRequest={onLoginNavigate}
              javaScriptEnabled
              domStorageEnabled
              thirdPartyCookiesEnabled
              sharedCookiesEnabled
              setSupportMultipleWindows={false}
              style={{ flex: 1, backgroundColor: C.bg }}
            />
          </SafeAreaView>
        </SafeAreaProvider>
      </Modal>

      {/* PIN screen */}
      <Modal visible={!!pinMode} animationType="fade" onRequestClose={() => setPinMode(null)}>
        <SafeAreaProvider>
          <SafeAreaView style={s.root} edges={['top', 'bottom']}>
            {pinMode && (
              <PinPad mode={pinMode} onDone={onPinDone} onCancel={() => setPinMode(null)} />
            )}
          </SafeAreaView>
        </SafeAreaProvider>
      </Modal>

      {/* Details for one saved video */}
      <Modal
        visible={!!detail}
        transparent
        animationType="slide"
        onRequestClose={() => setDetail(null)}
      >
        <Pressable style={s.sheetBackdrop} onPress={() => setDetail(null)} />
        {detail && (
          <View style={s.sheet}>
            <Text style={s.sheetTitle}>
              {detail.account ? `@${detail.account}` : detail.post_code}
            </Text>
            <Detail label="Status" value={
              detail.status === 'blocked'
                ? 'Blocked, not saved'
                : detail.status === 'removed'
                  ? 'Removed from gallery'
                  : 'In your gallery'
            } />
            <Detail label="Post" value={detail.post_url} />
            <Detail
              label="Video server"
              value={detail.video_host || 'unknown'}
              color={detail.trusted ? C.ok : C.bad}
            />
            {detail.file_name && <Detail label="File" value={detail.file_name} />}
            <Detail label="When" value={new Date(detail.saved_at).toLocaleString()} />

            <View style={s.sheetActions}>
              <Pressable style={s.smallBtn} onPress={() => Linking.openURL(detail.post_url)}>
                <Text style={s.smallBtnText}>Open post</Text>
              </Pressable>
              {detail.status === 'saved' && (
                <Pressable style={[s.smallBtn, { borderColor: C.bad }]} onPress={() => removeFromGallery(detail)}>
                  <Text style={[s.smallBtnText, { color: C.bad }]}>Remove from gallery</Text>
                </Pressable>
              )}
              {detail.status !== 'saved' && (
                <Pressable style={s.smallBtn} onPress={() => forgetRow(detail)}>
                  <Text style={s.smallBtnText}>Remove row</Text>
                </Pressable>
              )}
            </View>
          </View>
        )}
      </Modal>
    </SafeAreaView>
  );
}

function Detail({ label, value, color }) {
  return (
    <View style={s.detailRow}>
      <Text style={s.detailLabel}>{label}</Text>
      <Text style={[s.detailValue, color && { color }]} selectable>
        {value}
      </Text>
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <ShareIntentProvider>
        <Snag />
      </ShareIntentProvider>
    </SafeAreaProvider>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  body: { flex: 1 },
  header: { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 12 },
  title: { color: C.text, fontSize: 34, fontWeight: '800', letterSpacing: -0.5 },
  sub: { color: C.muted, fontSize: 15, marginTop: 4, lineHeight: 21 },

  statusBlock: {
    marginHorizontal: 20,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: C.line,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 11,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: C.line,
  },
  statusRowLast: { borderBottomWidth: 0 },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 10 },
  statusText: { color: C.text, fontSize: 14, flex: 1, paddingRight: 8 },

  inputRow: { flexDirection: 'row', marginHorizontal: 20, marginTop: 16, gap: 8 },
  input: {
    flex: 1,
    backgroundColor: C.surface,
    color: C.text,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
  },
  goBtn: { backgroundColor: C.accent, borderRadius: 10, paddingHorizontal: 16, justifyContent: 'center' },
  goBtnText: { color: C.bg, fontWeight: '700', fontSize: 15 },
  notice: { color: C.bad, marginHorizontal: 20, marginTop: 8, fontSize: 13 },

  section: { marginTop: 24, paddingHorizontal: 20 },
  sectionTitle: { color: C.text, fontSize: 17, fontWeight: '700', marginBottom: 8 },

  jobRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: C.line,
  },
  jobRowActive: { borderLeftWidth: 3, borderLeftColor: C.accent, paddingLeft: 10 },
  jobTitle: { color: C.text, fontSize: 15, fontWeight: '600' },
  jobStatus: { color: C.muted, fontSize: 13, marginTop: 3 },

  tableHead: {
    flexDirection: 'row',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderColor: C.line,
  },
  th: { color: C.muted, fontSize: 12, fontWeight: '600' },
  tr: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 20,
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: C.line,
  },
  td: { color: C.text, fontSize: 14 },
  colAccount: { flex: 1.3, paddingRight: 8 },
  colSource: { flex: 1.3, paddingRight: 8 },
  colTime: { flex: 0.8, textAlign: 'right' },
  muted: { color: C.muted },
  dim: { opacity: 0.45 },
  empty: { color: C.muted, fontSize: 15, textAlign: 'center', lineHeight: 22, padding: 32 },

  smallBtn: {
    borderWidth: 1,
    borderColor: C.accent,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  smallBtnText: { color: C.accent, fontWeight: '600', fontSize: 13 },

  hiddenWeb: { position: 'absolute', left: 0, top: 0, width: 1, height: 1, opacity: 0 },

  modalBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: C.line,
  },
  modalTitle: { color: C.text, fontSize: 16, fontWeight: '600' },
  modalClose: { color: C.accent, fontSize: 15, fontWeight: '600' },

  pinWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  pinTitle: { color: C.text, fontSize: 22, fontWeight: '700', textAlign: 'center' },
  pinSub: { color: C.muted, fontSize: 14, marginTop: 6 },
  pinDots: { flexDirection: 'row', gap: 14, marginTop: 28 },
  pinDot: { width: 14, height: 14, borderRadius: 7, borderWidth: 2, borderColor: C.muted },
  pinDotOn: { backgroundColor: C.accent, borderColor: C.accent },
  pinMsg: { color: C.bad, fontSize: 13, marginTop: 16, minHeight: 18, textAlign: 'center' },
  pinGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    width: 276,
    marginTop: 12,
    gap: 12,
  },
  pinKey: {
    width: 84,
    height: 64,
    borderRadius: 14,
    backgroundColor: C.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pinKeyOk: { backgroundColor: C.accent },
  pinKeyText: { color: C.text, fontSize: 24, fontWeight: '600' },
  pinCancel: { color: C.muted, fontSize: 15 },

  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: {
    backgroundColor: C.surface,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 20,
    paddingBottom: 36,
  },
  sheetTitle: { color: C.text, fontSize: 20, fontWeight: '700', marginBottom: 12 },
  detailRow: { paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: C.line },
  detailLabel: { color: C.muted, fontSize: 12 },
  detailValue: { color: C.text, fontSize: 14, marginTop: 2 },
  sheetActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 18 },
});
