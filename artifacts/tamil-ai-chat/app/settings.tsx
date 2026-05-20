import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  ScrollView, Linking, ActivityIndicator, Alert, Image, TextInput, Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { uploadUriToCloudinary } from '../services/api';

const APP_VERSION = '1.2.0 (Build 61)';
const LATEST_APK_URL = 'https://expo.dev/artifacts/eas/kSXWfdv4e7iY3GTwRvBCPY.apk';
const API_BASE = '';
const GITHUB_REPO = 'nnvvmm663-sketch/my-dream-girle';
const WORKFLOW_FILE = 'build-apk.yml';
const KEYS_STORAGE = 'api_keys_store';

const CUSTOM_SERVER_KEY = 'custom_server_url';
const DEFAULT_SERVER = 'https://my-girls-1-5.onrender.com';

type BuildStatus = 'idle' | 'triggering' | 'queued' | 'in_progress' | 'success' | 'failure';

export default function SettingsScreen() {
  const router = useRouter();
  const [checking, setChecking] = useState(false);
  const [customServerUrl, setCustomServerUrl] = useState('');
  const [savingServer, setSavingServer] = useState(false);
  const [checkMsg, setCheckMsg] = useState('');
  const [appIconUri, setAppIconUri] = useState<string | null>(null);
  const [uploadingAppIcon, setUploadingAppIcon] = useState(false);
  const [buildStatus, setBuildStatus] = useState<BuildStatus>('idle');
  const [buildRunId, setBuildRunId] = useState<number | null>(null);
  const [buildMsg, setBuildMsg] = useState('');
  const [apkUrl, setApkUrl] = useState<string | null>(null);
  const [latestApkUrl, setLatestApkUrl] = useState<string | null>(null);
  const [wakingServer, setWakingServer] = useState(false);
  const [serverStatus, setServerStatus] = useState<'unknown'|'ok'|'sleeping'>('unknown');
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [keyInputVal, setKeyInputVal] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    // Load saved custom server URL
    AsyncStorage.getItem(CUSTOM_SERVER_KEY).then(v => { if (v && v !== DEFAULT_SERVER) setCustomServerUrl(v); }).catch(() => {});
    // Auto-fetch latest APK URL (no auth needed — public repo)
    fetchLatestApkPublic();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  // GitHub Token-ஐ Keys screen-ல் இருந்து படிக்கிறோம்
  const getGithubToken = async (): Promise<string | null> => {
    try {
      const saved = await AsyncStorage.getItem(KEYS_STORAGE);
      if (!saved) return null;
      const parsed: Record<string, string> = JSON.parse(saved);
      return parsed['github'] || null;
    } catch { return null; }
  };

  // Latest APK URL — no auth needed (public repo releases)
  const fetchLatestApkPublic = async () => {
    try {
      const cached = await AsyncStorage.getItem('cached_apk_url');
      if (cached) setLatestApkUrl(cached);
      const res = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
        { headers: { Accept: 'application/vnd.github.v3+json' } }
      );
      const data = await res.json();
      const apk = data.assets?.find((a: any) => a.name?.endsWith('.apk'));
      if (apk?.browser_download_url) {
        setLatestApkUrl(apk.browser_download_url);
        await AsyncStorage.setItem('cached_apk_url', apk.browser_download_url);
      }
    } catch {}
  };

  // Render server-ஐ wake up பண்றோம்
  const wakeRenderServer = async () => {
    setWakingServer(true);
    setServerStatus('unknown');
    const serverUrl = (await AsyncStorage.getItem(CUSTOM_SERVER_KEY).catch(() => null)) || DEFAULT_SERVER;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 35000);
      const res = await fetch(`${serverUrl}/api/healthz`, { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) {
        setServerStatus('ok');
        Alert.alert('✅ Server Online!', 'Render server wake ஆச்சு! இப்போ messages அனுப்பலாம்.');
      } else {
        setServerStatus('sleeping');
        Alert.alert('⚠️ Server பிரச்னை', `Server respond பண்றது ஆனா error: ${res.status}`);
      }
    } catch {
      setServerStatus('sleeping');
      Alert.alert('⏳ Server Wake ஆகுது', '30-60 seconds-ல் ready ஆகும். மீண்டும் try பண்ணுங்க.');
    } finally {
      setWakingServer(false);
    }
  };

  // GitHub key-ஐ save பண்ணி build start பண்றோம்
  const saveKeyAndBuild = async () => {
    const key = keyInputVal.trim();
    if (!key) { Alert.alert('பிழை', 'GitHub Token உள்ளிடுங்க'); return; }
    setSavingKey(true);
    try {
      const saved = await AsyncStorage.getItem(KEYS_STORAGE).catch(() => null);
      const parsed: Record<string, string> = saved ? JSON.parse(saved) : {};
      parsed['github'] = key;
      await AsyncStorage.setItem(KEYS_STORAGE, JSON.stringify(parsed));
      setShowKeyModal(false);
      setKeyInputVal('');
      // Now trigger build with the saved key
      await triggerGithubBuildWithToken(key);
    } catch (e: any) {
      Alert.alert('Save பிழை', e?.message || 'மீண்டும் try பண்ணுங்க');
    } finally {
      setSavingKey(false);
    }
  };

  // GitHub Actions Build trigger செய்கிறோம்
  const triggerGithubBuild = async () => {
    const token = await getGithubToken();
    if (!token) {
      setShowKeyModal(true);
      return;
    }
    await triggerGithubBuildWithToken(token);
  };

  const triggerGithubBuildWithToken = async (token: string) => {

    setBuildStatus('triggering');
    setBuildMsg('GitHub-ல் build trigger பண்றோம்...');
    setApkUrl(null);

    try {
      const res = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
        {
          method: 'POST',
          headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ref: 'main' }),
        }
      );

      if (res.status === 204) {
        setBuildStatus('queued');
        setBuildMsg('✅ Build queue-ல் சேர்ந்தது! Status check பண்றோம்...');
        // 5 seconds wait பிறகு run ID கண்டுபிடிக்கிறோம்
        setTimeout(() => pollBuildStatus(token), 5000);
      } else {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || `Status: ${res.status}`);
      }
    } catch (e: any) {
      setBuildStatus('idle');
      setBuildMsg('');
      Alert.alert('Build Trigger பிழை', e?.message || 'மீண்டும் try பண்ணுங்க');
    }
  };

  // Build status poll செய்கிறோம்
  const pollBuildStatus = async (token: string) => {
    if (pollRef.current) clearInterval(pollRef.current);

    const checkStatus = async () => {
      try {
        const res = await fetch(
          `https://api.github.com/repos/${GITHUB_REPO}/actions/runs?per_page=5`,
          {
            headers: {
              Authorization: `token ${token}`,
              Accept: 'application/vnd.github.v3+json',
            },
          }
        );
        const data = await res.json();
        const runs = data.workflow_runs || [];
        // Latest run கண்டுபிடிக்கிறோம்
        const latest = runs.find((r: any) => r.name === 'Build APK' || r.path?.includes(WORKFLOW_FILE));
        if (!latest) {
          setBuildMsg('🔍 Build run தேடுகிறோம்...');
          return;
        }

        setBuildRunId(latest.id);
        const status = latest.status;
        const conclusion = latest.conclusion;

        if (status === 'queued') {
          setBuildStatus('queued');
          setBuildMsg('⏳ Build queue-ல் காத்திருக்கிறது...');
        } else if (status === 'in_progress') {
          setBuildStatus('in_progress');
          setBuildMsg('🔨 Build நடக்கிறது... (சுமார் 10-15 நிமிடம்)');
        } else if (status === 'completed') {
          if (pollRef.current) clearInterval(pollRef.current);
          if (conclusion === 'success') {
            setBuildStatus('success');
            setBuildMsg('✅ Build success! APK ready ஆச்சு!');
            // Latest release APK link கண்டுபிடிக்கிறோம்
            fetchLatestApk(token);
          } else {
            setBuildStatus('failure');
            setBuildMsg(`❌ Build fail ஆச்சு (${conclusion}). Logs பார்க்க GitHub-க்கு போங்க.`);
          }
        }
      } catch {}
    };

    await checkStatus();
    pollRef.current = setInterval(checkStatus, 30000); // 30 seconds-க்கு ஒரு முறை check
  };

  // Latest APK release link கண்டுபிடிக்கிறோம்
  const fetchLatestApk = async (token: string) => {
    try {
      const res = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
        {
          headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github.v3+json',
          },
        }
      );
      const data = await res.json();
      const apk = data.assets?.find((a: any) => a.name?.endsWith('.apk'));
      if (apk) setApkUrl(apk.browser_download_url);
    } catch {}
  };

  // Icon upload + auto trigger
  const pickAndUploadAppIcon = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Permission வேணும்', 'Gallery access allow பண்ணுங்க');
      return;
    }
    await new Promise(r => setTimeout(r, 350));
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.9,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    setAppIconUri(asset.uri);
    setUploadingAppIcon(true);
    try {
      await uploadUriToCloudinary(asset.uri, 'image/jpeg', 'my-girls/app-icon');
      setUploadingAppIcon(false);
      // Auto trigger செய்கிறோம்
      Alert.alert(
        '✅ Icon Upload ஆச்சு!',
        'Cloudinary-ல் save ஆனது.\n\nGitHub Build இப்போது automatically trigger ஆகுமா?',
        [
          { text: 'பிறகு பார்க்கலாம்', style: 'cancel' },
          { text: '🚀 Build Trigger பண்ணு', onPress: triggerGithubBuild },
        ]
      );
    } catch (e: any) {
      setUploadingAppIcon(false);
      setAppIconUri(null);
      Alert.alert('Upload பிழை', e?.message || 'மீண்டும் try பண்ணுங்க');
    }
  };

  const saveCustomServer = async () => {
    setSavingServer(true);
    try {
      const url = customServerUrl.trim();
      if (url && !url.startsWith('http')) {
        Alert.alert('பிழை', 'URL http:// அல்லது https:// இல் தொடங்கணும்');
        return;
      }
      await AsyncStorage.setItem(CUSTOM_SERVER_KEY, url || DEFAULT_SERVER);
      Alert.alert('✅ Saved', url ? `Custom server URL saved!\nNext message-ல் இருந்து use ஆகும்.` : 'Default server reset ஆச்சு!');
    } catch {
      Alert.alert('Error', 'Save பண்ண முடியல');
    } finally {
      setSavingServer(false);
    }
  };

  const checkUpdate = async () => {
    setChecking(true);
    setCheckMsg('சரிபார்க்கிறோம்...');
    try {
      const res = await fetch(`${API_BASE}/api/healthz`);
      if (res.ok) {
        setCheckMsg(`✅ v${APP_VERSION} — Latest version தான்! APK link கீழே இருக்கு.`);
      } else {
        setCheckMsg(`v${APP_VERSION} — APK link கீழே இருக்கு`);
      }
    } catch {
      setCheckMsg(`v${APP_VERSION} — APK link கீழே download பண்ணலாம்`);
    } finally {
      setChecking(false);
    }
  };

  const getBuildStatusColor = () => {
    switch (buildStatus) {
      case 'triggering': return '#f59e0b';
      case 'queued': return '#3b82f6';
      case 'in_progress': return '#8b5cf6';
      case 'success': return '#10b981';
      case 'failure': return '#ef4444';
      default: return '#6b7280';
    }
  };

  const getBuildStatusIcon = () => {
    switch (buildStatus) {
      case 'triggering': return '⚡';
      case 'queued': return '⏳';
      case 'in_progress': return '🔨';
      case 'success': return '✅';
      case 'failure': return '❌';
      default: return '🚀';
    }
  };

  return (
    <SafeAreaView style={s.safe}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* GitHub Key Input Modal */}
      <Modal visible={showKeyModal} transparent animationType="slide" onRequestClose={() => setShowKeyModal(false)}>
        <View style={s.keyModalOverlay}>
          <View style={s.keyModalBox}>
            <Text style={s.keyModalTitle}>🔑 GitHub Token தேவை</Text>
            <Text style={s.keyModalDesc}>
              Build trigger பண்ண GitHub Personal Access Token வேணும்.{'\n'}
              github.com → Settings → Developer settings → Personal access tokens → repo scope
            </Text>
            <TextInput
              style={s.keyModalInput}
              placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
              placeholderTextColor="#555"
              value={keyInputVal}
              onChangeText={setKeyInputVal}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry={true}
              autoFocus
            />
            <View style={s.keyModalBtns}>
              <TouchableOpacity style={s.keyModalCancel} onPress={() => { setShowKeyModal(false); setKeyInputVal(''); }}>
                <Text style={s.keyModalCancelTxt}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.keyModalSave, savingKey && { opacity: 0.6 }]}
                onPress={saveKeyAndBuild}
                disabled={savingKey}
              >
                {savingKey
                  ? <ActivityIndicator color="#fff" size="small" />
                  : <Text style={s.keyModalSaveTxt}>💾 Save & Build</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={s.headerBack}>←</Text>
        </TouchableOpacity>
        <Text style={s.headerTitle}>⚙️ Settings</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView contentContainerStyle={s.scroll}>
        <Text style={s.version}>Version {APP_VERSION}</Text>

        <View style={s.card}>
          <View style={s.cardHeader}>
            <Text style={s.cardIcon}>🔄</Text>
            <Text style={s.cardTitle}>App Update</Text>
          </View>
          <Text style={s.cardDesc}>
            புதிய version வந்திருக்கா check பண்ணி latest features download பண்ணும்.
          </Text>
          <TouchableOpacity
            style={[s.updateBtn, checking && { opacity: 0.7 }]}
            onPress={checkUpdate}
            disabled={checking}
          >
            {checking
              ? <ActivityIndicator color="#fff" size="small" />
              : <Text style={s.updateBtnTxt}>🔍 Update Check பண்ணு</Text>
            }
          </TouchableOpacity>
          {checkMsg ? <Text style={s.checkMsg}>{checkMsg}</Text> : null}
          {!checking && (
            <TouchableOpacity style={s.downloadLink} onPress={() => Linking.openURL(LATEST_APK_URL)}>
              <Text style={s.downloadLinkTxt}>⬇️ Latest APK Download</Text>
            </TouchableOpacity>
          )}
        </View>

        <View style={s.card}>
          <View style={s.cardHeader}>
            <Text style={s.cardIcon}>ℹ️</Text>
            <Text style={s.cardTitle}>App Info</Text>
          </View>
          {[
            ['App', 'My Girls'],
            ['Version', APP_VERSION],
            ['Package', 'com.smk1.tamilaichat'],
            ['Storage', 'Cloudinary'],
            ['AI Model', 'Gemini 2.5 Flash'],
            ['Characters', '10 Tamil AI'],
          ].map(([label, val]) => (
            <View key={label} style={s.infoRow}>
              <Text style={s.infoLabel}>{label}</Text>
              <Text style={s.infoVal}>{val}</Text>
            </View>
          ))}
        </View>

        {/* App Icon மாத்து + Auto Build Trigger */}
        <View style={s.card}>
          <View style={s.cardHeader}>
            <Text style={s.cardIcon}>🎯</Text>
            <Text style={s.cardTitle}>App Icon மாத்து</Text>
          </View>
          <Text style={s.cardDesc}>
            உங்கள் photo-வை icon-ஆக upload பண்ணுங்க. Build automatically trigger ஆகும்! GitHub-க்கு போக வேண்டாம்.
          </Text>

          {appIconUri ? (
            <View style={s.iconPreviewRow}>
              <Image source={{ uri: appIconUri }} style={s.iconPreview} />
              <View style={s.iconPreviewInfo}>
                <Text style={s.iconPreviewTitle}>✅ Upload ஆச்சு!</Text>
                <Text style={s.iconPreviewHint}>Build trigger ஆகுது...</Text>
              </View>
            </View>
          ) : null}

          <TouchableOpacity
            style={[s.iconBtn, uploadingAppIcon && { opacity: 0.6 }]}
            onPress={pickAndUploadAppIcon}
            disabled={uploadingAppIcon || buildStatus === 'in_progress'}
          >
            {uploadingAppIcon
              ? <><ActivityIndicator color="#fff" size="small" /><Text style={s.iconBtnTxt}> Uploading...</Text></>
              : <Text style={s.iconBtnTxt}>🖼️ {appIconUri ? 'வேற Icon Upload பண்ணு' : 'Gallery-ல் இருந்து Icon Select பண்ணு'}</Text>
            }
          </TouchableOpacity>

          {/* Latest APK Download — always visible */}
          {(latestApkUrl || (buildStatus === 'success' && apkUrl)) && (
            <TouchableOpacity
              style={s.latestApkBanner}
              onPress={() => Linking.openURL((latestApkUrl || apkUrl)!)}
            >
              <Text style={s.latestApkBannerTitle}>⬇️ Latest APK Ready!</Text>
              <Text style={s.latestApkBannerSub} numberOfLines={1}>{latestApkUrl || apkUrl}</Text>
              <Text style={s.latestApkBannerBtn}>Download Now</Text>
            </TouchableOpacity>
          )}

          {/* Build Status Box */}
          {buildStatus !== 'idle' && (
            <View style={[s.buildStatusBox, { borderColor: getBuildStatusColor() }]}>
              <View style={s.buildStatusHeader}>
                <Text style={s.buildStatusIcon}>{getBuildStatusIcon()}</Text>
                <Text style={[s.buildStatusTitle, { color: getBuildStatusColor() }]}>
                  Build Status
                </Text>
                {(buildStatus === 'triggering' || buildStatus === 'queued' || buildStatus === 'in_progress') && (
                  <ActivityIndicator color={getBuildStatusColor()} size="small" />
                )}
              </View>
              <Text style={s.buildStatusMsg}>{buildMsg}</Text>

              {buildStatus === 'in_progress' && buildRunId && (
                <TouchableOpacity
                  style={s.viewLogsBtn}
                  onPress={() => Linking.openURL(`https://github.com/${GITHUB_REPO}/actions/runs/${buildRunId}`)}
                >
                  <Text style={s.viewLogsTxt}>📋 Live Logs பார்க்க</Text>
                </TouchableOpacity>
              )}

              {buildStatus === 'success' && apkUrl && (
                <TouchableOpacity
                  style={s.downloadApkBtn}
                  onPress={() => Linking.openURL(apkUrl)}
                >
                  <Text style={s.downloadApkTxt}>⬇️ புது APK Download பண்ணு</Text>
                </TouchableOpacity>
              )}

              {buildStatus === 'failure' && (
                <TouchableOpacity
                  style={s.retryBtn}
                  onPress={triggerGithubBuild}
                >
                  <Text style={s.retryTxt}>🔄 மீண்டும் try பண்ணு</Text>
                </TouchableOpacity>
              )}
            </View>
          )}

          {/* Manual trigger button - build idle ஆனாலும் use பண்ணலாம் */}
          {buildStatus === 'idle' && (
            <TouchableOpacity style={s.manualTriggerBtn} onPress={triggerGithubBuild}>
              <Text style={s.manualTriggerTxt}>🚀 Build Trigger பண்ணு (icon upload இல்லாமல்)</Text>
            </TouchableOpacity>
          )}

          <View style={s.iconSteps}>
            <Text style={s.iconStep}>1️⃣ Gallery open → photo select → 1:1 crop</Text>
            <Text style={s.iconStep}>2️⃣ Cloudinary-ல் auto save ஆகும்</Text>
            <Text style={s.iconStep}>3️⃣ App-லேயே Build automatically trigger ஆகும் 🆕</Text>
            <Text style={s.iconStep}>4️⃣ Build ready ஆனதும் Download link கிடைக்கும் 🆕</Text>
          </View>
        </View>

        <TouchableOpacity style={s.keysBtn} onPress={() => router.push('/keys')}>
          <Text style={s.keysBtnTxt}>🔑 Keys & Accounts</Text>
        </TouchableOpacity>

        <View style={s.card}>
          <View style={s.cardHeader}>
            <Text style={s.cardIcon}>🌐</Text>
            <Text style={s.cardTitle}>Custom Server URL</Text>
          </View>
          <Text style={s.cardDesc}>Render server sleep ஆனா இந்த option-ல் வேற server URL set பண்ணலாம். Empty விட்டா default Render server use ஆகும்.</Text>
          <Text style={{ color: '#8b949e', fontSize: 11, marginBottom: 10 }}>
            இந்த APK-ல் built-in URL: <Text style={{ color: '#58a6ff' }}>{DEFAULT_SERVER}</Text>
          </Text>
          <TouchableOpacity
            style={[s.wakeBtn, wakingServer && { opacity: 0.6 }]}
            onPress={wakeRenderServer}
            disabled={wakingServer}
          >
            {wakingServer
              ? <><ActivityIndicator color="#fff" size="small" /><Text style={s.wakeBtnTxt}>  Waking up server...</Text></>
              : <Text style={s.wakeBtnTxt}>
                  {serverStatus === 'ok' ? '✅ Server Online — Ping Again' : '🔄 Render Server Wake பண்ணு'}
                </Text>
            }
          </TouchableOpacity>
          {serverStatus === 'sleeping' && (
            <View style={s.serverOfflineBadge}>
              <Text style={s.serverOfflineTxt}>⚠️ Server connect ஆகல — 30-60s wait பண்ணி retry பண்ணுங்க</Text>
            </View>
          )}
          {serverStatus === 'ok' && (
            <View style={[s.serverOfflineBadge, { backgroundColor: '#0d2818', borderColor: '#238636' }]}>
              <Text style={[s.serverOfflineTxt, { color: '#3fb950' }]}>✅ Render server online — messages அனுப்பலாம்!</Text>
            </View>
          )}
          <TextInput
            style={{ backgroundColor: '#0d1117', color: '#e6edf3', borderRadius: 8, borderWidth: 1, borderColor: '#30363d', padding: 10, fontSize: 13, marginBottom: 10 }}
            value={customServerUrl}
            onChangeText={setCustomServerUrl}
            placeholder='https://your-server.onrender.com'
            placeholderTextColor='#555'
            autoCapitalize='none'
            autoCorrect={false}
          />
          <TouchableOpacity
            style={{ backgroundColor: savingServer ? '#555' : '#238636', borderRadius: 8, paddingVertical: 11, alignItems: 'center' }}
            onPress={saveCustomServer}
            disabled={savingServer}
          >
            <Text style={{ color: '#fff', fontWeight: '700', fontSize: 14 }}>{savingServer ? 'Saving...' : '💾 Save Server URL'}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={{ marginTop: 8, alignItems: 'center', paddingVertical: 8 }}
            onPress={() => { setCustomServerUrl(''); saveCustomServer(); }}
          >
            <Text style={{ color: '#8b949e', fontSize: 12 }}>↩️ Default-க்கு reset பண்ணு</Text>
          </TouchableOpacity>
        </View>

        <View style={s.tipsCard}>
          <Text style={s.tipsTitle}>💡 Tips</Text>
          <Text style={s.tip}>• GitHub Token Keys screen-ல் save பண்ணினா auto build trigger ஆகும்</Text>
          <Text style={s.tip}>• Build சுமார் 10-15 நிமிடம் ஆகும், app open வச்சிருங்க</Text>
          <Text style={s.tip}>• முதல் message slow-ஆ வந்தா — server wake up ஆக நேரம் ஆகும்</Text>
          <Text style={s.tip}>• Cloud-ல் images save ஆக Cloudinary configured ஆகிட்டது</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#0d1117' },
  header: {
    backgroundColor: '#161b22', flexDirection: 'row',
    alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 16,
    borderBottomWidth: 1, borderBottomColor: '#30363d',
  },
  headerBack: { color: '#fff', fontSize: 22, fontWeight: 'bold', width: 40 },
  headerTitle: { color: '#fff', fontSize: 20, fontWeight: 'bold', flex: 1, textAlign: 'center' },
  scroll: { padding: 16, paddingBottom: 90 },
  version: { color: '#8b949e', fontSize: 13, marginBottom: 18, textAlign: 'center' },
  card: {
    backgroundColor: '#161b22', borderRadius: 14, padding: 16,
    marginBottom: 16, borderWidth: 1, borderColor: '#30363d',
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
  cardIcon: { fontSize: 22 },
  cardTitle: { color: '#e6edf3', fontSize: 16, fontWeight: '700' },
  cardDesc: { color: '#8b949e', fontSize: 13, lineHeight: 20, marginBottom: 14 },
  updateBtn: {
    backgroundColor: '#238636', borderRadius: 10,
    paddingVertical: 12, alignItems: 'center', marginBottom: 10,
  },
  updateBtnTxt: { color: '#fff', fontWeight: '700', fontSize: 14 },
  checkMsg: { color: '#8b949e', fontSize: 13, marginBottom: 8 },
  downloadLink: {
    backgroundColor: '#1f6feb', borderRadius: 10,
    paddingVertical: 11, alignItems: 'center',
  },
  downloadLinkTxt: { color: '#fff', fontWeight: '700', fontSize: 14 },
  infoRow: {
    flexDirection: 'row', justifyContent: 'space-between',
    paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#21262d',
  },
  infoLabel: { color: '#8b949e', fontSize: 13 },
  infoVal: { color: '#e6edf3', fontSize: 13, fontWeight: '600' },
  iconPreviewRow: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 14 },
  iconPreview: { width: 60, height: 60, borderRadius: 14, borderWidth: 2, borderColor: '#388bfd' },
  iconPreviewInfo: { flex: 1 },
  iconPreviewTitle: { color: '#3fb950', fontSize: 14, fontWeight: '700' },
  iconPreviewHint: { color: '#8b949e', fontSize: 12, marginTop: 2 },
  iconBtn: {
    backgroundColor: '#6e40c9', borderRadius: 10,
    paddingVertical: 13, alignItems: 'center',
    flexDirection: 'row', justifyContent: 'center', gap: 8, marginBottom: 12,
  },
  iconBtnTxt: { color: '#fff', fontWeight: '700', fontSize: 14 },
  buildStatusBox: {
    borderRadius: 12, borderWidth: 1.5,
    padding: 14, marginBottom: 12, backgroundColor: '#0d1117',
  },
  buildStatusHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  buildStatusIcon: { fontSize: 18 },
  buildStatusTitle: { flex: 1, fontSize: 14, fontWeight: '700' },
  buildStatusMsg: { color: '#c9d1d9', fontSize: 13, lineHeight: 20 },
  viewLogsBtn: {
    backgroundColor: '#21262d', borderRadius: 8,
    paddingVertical: 9, alignItems: 'center', marginTop: 10,
    borderWidth: 1, borderColor: '#30363d',
  },
  viewLogsTxt: { color: '#8b949e', fontSize: 13, fontWeight: '600' },
  downloadApkBtn: {
    backgroundColor: '#238636', borderRadius: 8,
    paddingVertical: 12, alignItems: 'center', marginTop: 10,
  },
  downloadApkTxt: { color: '#fff', fontWeight: '800', fontSize: 14 },
  retryBtn: {
    backgroundColor: '#21262d', borderRadius: 8,
    paddingVertical: 9, alignItems: 'center', marginTop: 10,
    borderWidth: 1, borderColor: '#f85149',
  },
  retryTxt: { color: '#f85149', fontSize: 13, fontWeight: '600' },
  manualTriggerBtn: {
    backgroundColor: '#161b22', borderRadius: 10,
    paddingVertical: 11, alignItems: 'center', marginBottom: 12,
    borderWidth: 1, borderColor: '#388bfd', borderStyle: 'dashed',
  },
  manualTriggerTxt: { color: '#388bfd', fontWeight: '600', fontSize: 13 },
  iconSteps: { backgroundColor: '#0d1117', borderRadius: 10, padding: 12, gap: 6 },
  iconStep: { color: '#8b949e', fontSize: 12, lineHeight: 18 },
  keysBtn: {
    backgroundColor: '#b08800', borderRadius: 12,
    paddingVertical: 14, alignItems: 'center', marginBottom: 16,
  },
  keysBtnTxt: { color: '#fff', fontWeight: '700', fontSize: 15 },
  tipsCard: {
    backgroundColor: '#161b22', borderRadius: 14, padding: 16,
    borderWidth: 1, borderColor: '#30363d',
  },
  tipsTitle: { color: '#e6edf3', fontSize: 14, fontWeight: '700', marginBottom: 10 },
  tip: { color: '#8b949e', fontSize: 12, lineHeight: 20, marginBottom: 4 },
  latestApkBanner: {
    backgroundColor: '#0d2818', borderRadius: 12, borderWidth: 1.5, borderColor: '#238636',
    padding: 14, marginBottom: 12, alignItems: 'center',
  },
  latestApkBannerTitle: { color: '#3fb950', fontSize: 15, fontWeight: '800', marginBottom: 4 },
  latestApkBannerSub: { color: '#8b949e', fontSize: 11, marginBottom: 10 },
  latestApkBannerBtn: { color: '#fff', fontWeight: '700', fontSize: 13, backgroundColor: '#238636', paddingHorizontal: 20, paddingVertical: 8, borderRadius: 20 },
  keyModalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  keyModalBox: {
    backgroundColor: '#161b22', borderTopLeftRadius: 22, borderTopRightRadius: 22,
    padding: 24, paddingBottom: 36, borderTopWidth: 1, borderColor: '#30363d',
  },
  keyModalTitle: { color: '#e6edf3', fontSize: 18, fontWeight: '800', marginBottom: 8 },
  keyModalDesc: { color: '#8b949e', fontSize: 12, lineHeight: 18, marginBottom: 16 },
  keyModalInput: {
    backgroundColor: '#0d1117', color: '#e6edf3', borderRadius: 10,
    borderWidth: 1, borderColor: '#388bfd', padding: 14, fontSize: 14,
    marginBottom: 16, letterSpacing: 1,
  },
  keyModalBtns: { flexDirection: 'row', gap: 12 },
  keyModalCancel: {
    flex: 1, backgroundColor: '#21262d', borderRadius: 10,
    paddingVertical: 13, alignItems: 'center',
  },
  keyModalCancelTxt: { color: '#8b949e', fontWeight: '700', fontSize: 14 },
  keyModalSave: {
    flex: 2, backgroundColor: '#238636', borderRadius: 10,
    paddingVertical: 13, alignItems: 'center',
  },
  keyModalSaveTxt: { color: '#fff', fontWeight: '800', fontSize: 14 },
  wakeBtn: {
    backgroundColor: '#1565C0', borderRadius: 10,
    paddingVertical: 12, alignItems: 'center', marginBottom: 10,
    flexDirection: 'row', justifyContent: 'center',
  },
  wakeBtnTxt: { color: '#fff', fontWeight: '700', fontSize: 14 },
  serverOfflineBadge: {
    backgroundColor: '#1a0000', borderRadius: 8, borderWidth: 1, borderColor: '#f85149',
    padding: 10, marginBottom: 8,
  },
  serverOfflineTxt: { color: '#f85149', fontSize: 12, textAlign: 'center' },
});
