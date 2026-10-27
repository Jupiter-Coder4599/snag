import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  ActivityIndicator,
  StatusBar,
  BackHandler,
  FlatList,
  Pressable,
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
const historyFile = new File(Paths.document, 'history.json');

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
    case 'clearFinished':
      return state.filter((j) => j.status !== 'saved');
    default:
      return state;
  }
}

function statusLine(job, loggedIn) {
  switch (job.status) {
    case 'queued':
      return loggedIn ? 'Queued' : 'Waiting for you to log in to Instagram';
    case 'finding':
      return 'Finding the video…';
    case 'saving':
      return job.total > 1 ? `Saving ${job.done + 1} of ${job.total}…` : 'Saving…';
    case 'saved':
      return job.total > 1 ? `Saved ${job.total} videos to your gallery` : 'Saved to your gallery';
    case 'failed':
      return job.error || 'Failed';
    default:
      return '';
  }
}

function Snag() {
  const [jobs, dispatch] = useReducer(jobsReducer, []);
  const [input, setInput] = useState('');
  const [notice, setNotice] = useState(null);
  const [loggedIn, setLoggedIn] = useState(false);
  const [pageReady, setPageReady] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [tick, setTick] = useState(0);

  const webRef = useRef(null);
  const pending = useRef(new Map());
  const busy = useRef(false);
  const loaded = useRef(false);

  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext();

  // ---------- history ----------
  useEffect(() => {
    try {
      if (historyFile.exists) {
        const saved = JSON.parse(historyFile.textSync());
        if (Array.isArray(saved)) dispatch({ type: 'load', jobs: saved });
      }
    } catch {}
    loaded.current = true;
  }, []);

  useEffect(() => {
    if (!loaded.current) return;
    try {
      // Unfinished jobs are saved as queued so they resume next launch.
      const toSave = jobs.slice(0, 200).map((j) =>
        ACTIVE.includes(j.status) ? { ...j, status: 'queued' } : j
      );
      if (!historyFile.exists) historyFile.create();
      historyFile.write(JSON.stringify(toSave));
    } catch {}
  }, [jobs]);

  // ---------- adding links ----------
  const addLink = useCallback(
    (text) => {
      const link = parseInstagramLink(text);
      if (!link) {
        setNotice("That isn't an Instagram post or reel link.");
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
      return true;
    },
    [jobs]
  );

  // Links shared from Instagram land here.
  useEffect(() => {
    if (!hasShareIntent) return;
    addLink(shareIntent?.webUrl || shareIntent?.text || '');
    resetShareIntent();
  }, [hasShareIntent, shareIntent, resetShareIntent, addLink]);

  // ---------- WebView bridge ----------
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
    let msg;
    try {
      msg = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }
    if (msg.type === 'session') {
      setLoggedIn(!!msg.loggedIn);
      if (msg.loggedIn && loginOpen) setLoginOpen(false);
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

  // ---------- the download queue (one at a time) ----------
  useEffect(() => {
    if (busy.current || !loggedIn || !pageReady || loginOpen) return;
    const job = [...jobs].reverse().find((j) => j.status === 'queued'); // oldest first
    if (!job) return;

    const update = (patch) => dispatch({ type: 'update', id: job.id, patch });
    busy.current = true;

    (async () => {
      try {
        update({ status: 'finding', error: null });
        const found = await extract(job.code);

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
          await MediaLibrary.createAssetAsync(file.uri);
          file.delete(); // gallery has its own copy now
          update({ done: i + 1 });
        }
        update({ status: 'saved', finishedAt: Date.now() });
      } catch (e) {
        update({ status: 'failed', error: e?.message || String(e) });
      } finally {
        busy.current = false;
        setTick((t) => t + 1);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs, loggedIn, pageReady, loginOpen, tick]);

  // Back button closes the login screen instead of the app.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (loginOpen) {
        setLoginOpen(false);
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [loginOpen]);

  const submit = () => {
    if (addLink(input)) setInput('');
  };

  const hasFinished = jobs.some((j) => j.status === 'saved');

  return (
    <SafeAreaView style={s.root} edges={['top', 'bottom']}>
      <StatusBar barStyle="light-content" />
      <View style={s.body}>

      <View style={s.header}>
        <Text style={s.title}>Snag</Text>
        <Text style={s.sub}>Share a reel from Instagram to Snag and it saves to your gallery.</Text>
      </View>

      <View style={s.session}>
        <View style={[s.dot, { backgroundColor: loggedIn ? C.ok : C.bad }]} />
        <Text style={s.sessionText}>
          {loggedIn ? 'Logged in to Instagram' : 'Log in to Instagram so Snag can find videos'}
        </Text>
        {!loggedIn && (
          <Pressable style={s.smallBtn} onPress={() => setLoginOpen(true)}>
            <Text style={s.smallBtnText}>Log in</Text>
          </Pressable>
        )}
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

      <FlatList
        data={jobs}
        keyExtractor={(j) => j.id}
        contentContainerStyle={jobs.length ? s.list : s.emptyWrap}
        ListEmptyComponent={
          <Text style={s.empty}>
            Nothing saved yet. In Instagram, tap Share on a reel, then pick Snag.
          </Text>
        }
        renderItem={({ item }) => {
          const active = ACTIVE.includes(item.status);
          const color =
            item.status === 'saved' ? C.ok : item.status === 'failed' ? C.bad : C.muted;
          return (
            <Pressable
              style={[s.row, active && s.rowActive]}
              onLongPress={() => !active && dispatch({ type: 'remove', id: item.id })}
            >
              <View style={{ flex: 1 }}>
                <Text style={s.rowTitle} numberOfLines={1}>
                  {item.username ? `@${item.username}` : item.code}
                </Text>
                <Text style={[s.rowStatus, { color }]}>{statusLine(item, loggedIn)}</Text>
              </View>
              {active && <ActivityIndicator color={C.accent} />}
              {item.status === 'failed' && (
                <Pressable
                  style={s.smallBtn}
                  onPress={() =>
                    dispatch({ type: 'update', id: item.id, patch: { status: 'queued', error: null } })
                  }
                >
                  <Text style={s.smallBtnText}>Retry</Text>
                </Pressable>
              )}
            </Pressable>
          );
        }}
      />

      {hasFinished && (
        <Pressable onPress={() => dispatch({ type: 'clearFinished' })} style={s.clear}>
          <Text style={s.clearText}>Clear saved from list</Text>
        </Pressable>
      )}

      {/* One WebView: hidden while working, full screen while you log in. */}
      <View
        style={loginOpen ? s.loginWrap : s.hiddenWeb}
        pointerEvents={loginOpen ? 'auto' : 'none'}
      >
        {loginOpen && (
          <View style={s.loginBar}>
            <Text style={s.loginTitle}>Log in to Instagram</Text>
            <Pressable onPress={() => setLoginOpen(false)}>
              <Text style={s.loginClose}>Close</Text>
            </Pressable>
          </View>
        )}
        <WebView
          ref={webRef}
          source={{ uri: loginOpen ? LOGIN_URL : BRIDGE_URL }}
          userAgent={MOBILE_UA}
          injectedJavaScript={SESSION_SCRIPT}
          onMessage={onMessage}
          onLoadStart={() => setPageReady(false)}
          onLoadEnd={() => setPageReady(true)}
          javaScriptEnabled
          domStorageEnabled
          thirdPartyCookiesEnabled
          sharedCookiesEnabled
          mediaPlaybackRequiresUserAction
          setSupportMultipleWindows={false}
          style={{ flex: 1, backgroundColor: C.bg }}
        />
      </View>
      </View>
    </SafeAreaView>
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
  session: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 20,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: C.line,
  },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 10 },
  sessionText: { color: C.text, fontSize: 14, flex: 1 },
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
  goBtn: {
    backgroundColor: C.accent,
    borderRadius: 10,
    paddingHorizontal: 16,
    justifyContent: 'center',
  },
  goBtnText: { color: '#1B2025', fontWeight: '700', fontSize: 15 },
  notice: { color: C.bad, marginHorizontal: 20, marginTop: 8, fontSize: 13 },
  list: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 24 },
  emptyWrap: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 40 },
  empty: { color: C.muted, fontSize: 15, textAlign: 'center', lineHeight: 22 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: C.line,
  },
  rowActive: { borderLeftWidth: 3, borderLeftColor: C.accent, paddingLeft: 10 },
  rowTitle: { color: C.text, fontSize: 16, fontWeight: '600' },
  rowStatus: { fontSize: 13, marginTop: 3 },
  smallBtn: {
    borderWidth: 1,
    borderColor: C.accent,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  smallBtnText: { color: C.accent, fontWeight: '600', fontSize: 13 },
  clear: { alignItems: 'center', paddingVertical: 12 },
  clearText: { color: C.muted, fontSize: 13 },
  hiddenWeb: { position: 'absolute', left: 0, top: 0, width: 1, height: 1, opacity: 0 },
  loginWrap: { ...StyleSheet.absoluteFillObject, backgroundColor: C.bg },
  loginBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: C.line,
  },
  loginTitle: { color: C.text, fontSize: 16, fontWeight: '600' },
  loginClose: { color: C.accent, fontSize: 15, fontWeight: '600' },
});
