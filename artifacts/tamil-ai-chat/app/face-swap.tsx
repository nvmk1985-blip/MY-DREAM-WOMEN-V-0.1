import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  Image, Alert, ActivityIndicator, ScrollView, Dimensions, StatusBar, Switch,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import AsyncStorage from '@react-native-async-storage/async-storage';

const { width } = Dimensions.get('window');

// ── HuggingFace Space Gradio helper ──────────────────────────────────────────
async function callGradioSpace(
  host: string,
  endpoint: string,
  data: any[],
  hfToken?: string,
  timeoutMs = 180000,
): Promise<string | null> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (hfToken) headers['Authorization'] = `Bearer ${hfToken}`;

  try {
    // Submit job
    const submitRes = await fetch(
      `https://${host}.hf.space/gradio_api/call/${endpoint}`,
      { method: 'POST', headers, body: JSON.stringify({ data }), signal: AbortSignal.timeout(30000) },
    );
    if (!submitRes.ok) return null;
    const submitJson: any = await submitRes.json();
    const eventId = submitJson?.event_id;
    if (!eventId) return null;

    // Poll SSE result
    const pollRes = await fetch(
      `https://${host}.hf.space/gradio_api/call/${endpoint}/${eventId}`,
      { headers, signal: AbortSignal.timeout(timeoutMs) },
    );
    if (!pollRes.ok) return null;

    const text = await pollRes.text();
    const lines = text.split('\n');
    let resultData: any = null;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('event: complete')) {
        const dl = lines[i + 1] || '';
        if (dl.startsWith('data: ')) {
          try { resultData = JSON.parse(dl.slice(6)); } catch { }
        }
        break;
      }
      if (lines[i].startsWith('event: error')) return null;
    }
    if (!resultData || !Array.isArray(resultData) || resultData.length === 0) return null;

    const first = resultData[0];
    if (!first) return null;
    if (typeof first === 'string' && (first.startsWith('http') || first.startsWith('data:'))) return first;
    if (first?.url) return first.url as string;
    if (first?.path) return `https://${host}.hf.space/gradio_api/file=${first.path}`;
    return null;
  } catch { return null; }
}

function imgObj(dataUri: string) {
  return { url: dataUri, meta: { _type: 'gradio.FileData' } };
}

// ── FACE SWAP ENGINE — InsightFace/InSwapper128 + GFPGAN + Real-ESRGAN ───────
//
// Priority chain:
//   1. Gourieff/ReActor     — InsightFace + InSwapper128 + CodeFormer/GFPGAN (best)
//   2. r3gm/ReActor          — same engine, alternate instance
//   3. Dentro/face-swap      — roop (InsightFace + InSwapper128)
//   4. ALSv/FaceSwapAll      — InsightFace multi-face
//   5. tonyassi/face-swap    — generic fallback
//
// Enhancement pipeline (after swap):
//   A. Xintao/GFPGAN         — face restoration
//   B. sberbank-ai/Real-ESRGAN — 4× upscaling

const SWAP_SPACES = [
  {
    label: 'ReActor (InsightFace + InSwapper128 + CodeFormer)',
    host: 'Gourieff-ReActor',
    endpoint: 'predict',
    // [source_img, target_img, src_face_idx, tgt_face_idx, face_restore, restore_visibility,
    //  codeformer_weight, detect_thresh, reference_img, many_faces, gender_detect_src,
    //  save_to_file, random_seed, face_model, gender_src, gender_tgt]
    buildData: (face: object, target: object) => [
      face, target, '0', '0', 'CodeFormer', 1, 0.5, 100, null,
      false, false, false, -1, 'inswapper_128.onnx', 'No', 'No',
    ],
  },
  {
    label: 'ReActor v2 (InsightFace + InSwapper128)',
    host: 'r3gm-ReActor-Image-Video-Face-Swap',
    endpoint: 'predict',
    buildData: (face: object, target: object) => [
      face, target, '0', '0', 'CodeFormer', 1, 0.5, 100, null,
      false, false, false, -1, 'inswapper_128.onnx', 'No', 'No',
    ],
  },
  {
    label: 'Roop (InsightFace + InSwapper128)',
    host: 'Dentro-face-swap',
    endpoint: 'predict',
    buildData: (face: object, target: object) => [face, target],
  },
  {
    label: 'FaceSwapAll (InsightFace multi-face)',
    host: 'ALSv-FaceSwapAll',
    endpoint: 'predict',
    buildData: (face: object, target: object) => [face, 0, target, 0],
  },
  {
    label: 'FaceSwap (fallback)',
    host: 'tonyassi-face-swap',
    endpoint: 'swap_faces',
    buildData: (face: object, target: object) => [face, target],
  },
];

// GFPGAN face restoration
async function enhanceWithGFPGAN(imgDataUri: string, hfToken?: string): Promise<string | null> {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (hfToken) headers['Authorization'] = `Bearer ${hfToken}`;
    // Try Xintao/GFPGAN space
    const res = await fetch('https://Xintao-GFPGAN.hf.space/gradio_api/call/inference', {
      method: 'POST', headers,
      body: JSON.stringify({ data: [imgObj(imgDataUri), 'v1.4', 2] }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return null;
    const j: any = await res.json();
    const eid = j?.event_id; if (!eid) return null;
    const poll = await fetch(
      `https://Xintao-GFPGAN.hf.space/gradio_api/call/inference/${eid}`,
      { headers, signal: AbortSignal.timeout(90000) },
    );
    if (!poll.ok) return null;
    const txt = await poll.text();
    const lines = txt.split('\n');
    for (let i=0;i<lines.length;i++) {
      if (lines[i].startsWith('event: complete')) {
        const dl = lines[i+1]||''; if (!dl.startsWith('data: ')) break;
        const rd: any = JSON.parse(dl.slice(6));
        const f = Array.isArray(rd)?rd[0]:rd;
        if (!f) break;
        if (typeof f==='string') return f;
        if (f?.url) return f.url;
        if (f?.path) return `https://Xintao-GFPGAN.hf.space/gradio_api/file=${f.path}`;
        break;
      }
    }
  } catch {}
  return null;
}

// Real-ESRGAN 4× upscaling
async function upscaleWithESRGAN(imgDataUri: string, hfToken?: string): Promise<string | null> {
  const ESRGAN_SPACES = [
    'sberbank-ai-Real-ESRGAN',
    'ai-forever-Real-ESRGAN',
  ];
  for (const host of ESRGAN_SPACES) {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (hfToken) headers['Authorization'] = `Bearer ${hfToken}`;
      const res = await fetch(`https://${host}.hf.space/gradio_api/call/predict`, {
        method: 'POST', headers,
        body: JSON.stringify({ data: [imgObj(imgDataUri), 'RealESRGAN_x4plus', 4, null, 0, 0] }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) continue;
      const j: any = await res.json();
      const eid = j?.event_id; if (!eid) continue;
      const poll = await fetch(
        `https://${host}.hf.space/gradio_api/call/predict/${eid}`,
        { headers, signal: AbortSignal.timeout(120000) },
      );
      if (!poll.ok) continue;
      const txt = await poll.text();
      const lines = txt.split('\n');
      for (let i=0;i<lines.length;i++) {
        if (lines[i].startsWith('event: complete')) {
          const dl = lines[i+1]||''; if (!dl.startsWith('data: ')) break;
          const rd: any = JSON.parse(dl.slice(6));
          const f = Array.isArray(rd)?rd[0]:rd;
          if (!f) break;
          if (typeof f==='string') return f;
          if (f?.url) return f.url;
          if (f?.path) return `https://${host}.hf.space/gradio_api/file=${f.path}`;
          break;
        }
      }
    } catch {}
  }
  return null;
}

// ── Fetch URL → base64 dataURI ────────────────────────────────────────────────
async function urlToDataUri(url: string): Promise<string | null> {
  try {
    if (url.startsWith('data:')) return url;
    if (url.startsWith('http')) {
      // Download to temp file, then read as base64
      const tmp = FileSystem.cacheDirectory + `enhance_${Date.now()}.jpg`;
      await FileSystem.downloadAsync(url, tmp);
      const raw = await FileSystem.readAsStringAsync(tmp, { encoding: FileSystem.EncodingType.Base64 });
      await FileSystem.deleteAsync(tmp, { idempotent: true });
      return `data:image/jpeg;base64,${raw}`;
    }
    return null;
  } catch { return null; }
}

// ── Screen ────────────────────────────────────────────────────────────────────
export default function FaceSwapScreen() {
  const [targetUri, setTargetUri] = useState<string | null>(null);
  const [targetB64, setTargetB64] = useState<string | null>(null);
  const [faceUri, setFaceUri] = useState<string | null>(null);
  const [faceB64, setFaceB64] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState('');
  const [usedModel, setUsedModel] = useState('');
  const [enhanceEnabled, setEnhanceEnabled] = useState(true);

  const pickImage = async (slot: 'target' | 'face') => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { Alert.alert('Permission', 'Gallery access வேணும்.'); return; }
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'] as any, quality: 0.85, base64: true,
    });
    if (!picked.canceled && picked.assets[0]) {
      const asset = picked.assets[0];
      const mime = asset.mimeType ?? 'image/jpeg';
      let b64: string;
      if (asset.base64) {
        b64 = `data:${mime};base64,${asset.base64}`;
      } else {
        try {
          const tmp = FileSystem.cacheDirectory + `fs_${Date.now()}.jpg`;
          await FileSystem.copyAsync({ from: asset.uri, to: tmp });
          const raw = await FileSystem.readAsStringAsync(tmp, { encoding: FileSystem.EncodingType.Base64 });
          await FileSystem.deleteAsync(tmp, { idempotent: true });
          b64 = `data:image/jpeg;base64,${raw}`;
        } catch { Alert.alert('பிழை', 'Photo read ஆகல.'); return; }
      }
      if (slot === 'target') { setTargetUri(asset.uri); setTargetB64(b64); setResultUrl(null); setUsedModel(''); }
      else { setFaceUri(asset.uri); setFaceB64(b64); setResultUrl(null); setUsedModel(''); }
    }
  };

  const startSwap = async () => {
    if (!targetB64 || !faceB64) {
      Alert.alert('Images இல்லை', 'இரண்டு photos-ம் select பண்ணுங்க.'); return;
    }
    setLoading(true); setResultUrl(null); setStatusMsg('Starting...'); setUsedModel('');

    try {
      const keysRaw = await AsyncStorage.getItem('api_keys_store').catch(() => null);
      const keysMap = keysRaw ? JSON.parse(keysRaw) as Record<string, string> : {};
      const hfToken = keysMap['hf']?.trim() || undefined;

      const faceData = imgObj(faceB64);
      const targetData = imgObj(targetB64);

      // ── STEP 1: Face Swap (InsightFace + InSwapper128) ──────────────────────
      let swapResult: string | null = null;
      let modelLabel = '';

      for (let i = 0; i < SWAP_SPACES.length; i++) {
        const sp = SWAP_SPACES[i];
        setStatusMsg(`🔍 Face detection... [${i+1}/${SWAP_SPACES.length}] ${sp.label}`);
        try {
          const data = sp.buildData(faceData, targetData);
          swapResult = await callGradioSpace(sp.host, sp.endpoint, data, hfToken);
          if (swapResult) { modelLabel = sp.label; break; }
        } catch { /* try next */ }
      }

      if (!swapResult) {
        Alert.alert(
          'Face Swap பிழை ❌',
          'AI spaces இப்போது busy.\n\n• முகம் clearly தெரியும் front-facing photos use பண்ணுங்க\n• Settings-ல் HuggingFace key set பண்ணுங்க (faster)\n• சில நிமிடம் கழித்து மீண்டும் try பண்ணுங்க',
        );
        setStatusMsg(''); return;
      }

      // ── STEP 2: GFPGAN Face Restoration ────────────────────────────────────
      let enhanced = swapResult;
      if (enhanceEnabled) {
        setStatusMsg('✨ GFPGAN face restoration...');
        try {
          const dataUri = await urlToDataUri(swapResult);
          if (dataUri) {
            const gfpResult = await enhanceWithGFPGAN(dataUri, hfToken);
            if (gfpResult) { enhanced = gfpResult; modelLabel += ' + GFPGAN'; }
          }
        } catch { /* keep swap result */ }

        // ── STEP 3: Real-ESRGAN 4× Upscaling ──────────────────────────────
        setStatusMsg('🔬 Real-ESRGAN 4× upscaling...');
        try {
          const dataUri2 = await urlToDataUri(enhanced);
          if (dataUri2) {
            const esrResult = await upscaleWithESRGAN(dataUri2, hfToken);
            if (esrResult) { enhanced = esrResult; modelLabel += ' + Real-ESRGAN 4×'; }
          }
        } catch { /* keep gfpgan result */ }
      }

      setResultUrl(enhanced);
      setUsedModel(modelLabel);
      setStatusMsg('');
    } catch (e: any) {
      Alert.alert('பிழை ❌', e?.message || 'மீண்டும் try பண்ணுங்க.');
      setStatusMsg('');
    } finally {
      setLoading(false);
    }
  };

  const saveResult = async () => {
    if (!resultUrl) return;
    try {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status !== 'granted') { Alert.alert('Permission', 'Gallery permission வேணும்.'); return; }
      let localUri = resultUrl;
      if (resultUrl.startsWith('http')) {
        const tmp = FileSystem.cacheDirectory + `faceswap_${Date.now()}.jpg`;
        await FileSystem.downloadAsync(resultUrl, tmp);
        localUri = tmp;
      } else if (resultUrl.startsWith('data:')) {
        const m = resultUrl.match(/^data:[^;]+;base64,(.+)$/);
        if (m) {
          const tmp = FileSystem.cacheDirectory + `faceswap_${Date.now()}.jpg`;
          await FileSystem.writeAsStringAsync(tmp, m[1], { encoding: FileSystem.EncodingType.Base64 });
          localUri = tmp;
        }
      }
      await MediaLibrary.saveToLibraryAsync(localUri);
      Alert.alert('✅ Saved!', 'Photo gallery-ல save ஆச்சு!');
    } catch { Alert.alert('பிழை', 'Save ஆகல.'); }
  };

  return (
    <SafeAreaView style={s.root} edges={['top', 'bottom']}>
      <StatusBar backgroundColor="#1a1a2e" barStyle="light-content" />
      <Stack.Screen options={{
        title: '🤳 Face Swap',
        headerStyle: { backgroundColor: '#1a1a2e' },
        headerTintColor: '#fff',
        headerTitleStyle: { fontWeight: 'bold' },
      }} />
      <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>

        <Text style={s.title}>AI Face Swap</Text>
        <Text style={s.sub}>InsightFace · InSwapper128 · GFPGAN · Real-ESRGAN</Text>

        {/* Engine info */}
        <View style={s.engineCard}>
          <Text style={s.engineTitle}>🚀 Engine Stack</Text>
          <Text style={s.engineLine}>🔍 InsightFace — face detection & landmark</Text>
          <Text style={s.engineLine}>🔄 InSwapper_128 — neural face swap</Text>
          <Text style={s.engineLine}>✨ GFPGAN — face restoration & detail</Text>
          <Text style={s.engineLine}>🔬 Real-ESRGAN — 4× resolution upscale</Text>
        </View>

        {/* Tips */}
        <View style={s.tipCard}>
          <Text style={s.tipTitle}>📸 Best results tips:</Text>
          <Text style={s.tipText}>• முகம் clearly தெரியும் front-facing photos</Text>
          <Text style={s.tipText}>• High resolution, bright, blur இல்லாத photos</Text>
          <Text style={s.tipText}>• Glasses, mask இல்லாமல் clear face</Text>
          <Text style={s.tipText}>• Both photos similar face size</Text>
        </View>

        {/* Enhancement toggle */}
        <View style={s.toggleCard}>
          <View style={{ flex: 1 }}>
            <Text style={s.toggleLabel}>✨ GFPGAN + Real-ESRGAN Enhancement</Text>
            <Text style={s.toggleSub}>Face restore + 4× upscale (slower but higher quality)</Text>
          </View>
          <Switch
            value={enhanceEnabled}
            onValueChange={setEnhanceEnabled}
            trackColor={{ false: '#333', true: '#7c3aed' }}
            thumbColor={enhanceEnabled ? '#fff' : '#888'}
          />
        </View>

        {/* Image 1: Target */}
        <View style={s.card}>
          <View style={s.badge}><Text style={s.badgeNum}>1</Text></View>
          <Text style={s.cardLabel}>Target Image — முகம் வைக்க வேண்டிய photo (body/background)</Text>
          <TouchableOpacity style={[s.picker, targetUri ? s.pickerFilled : null]} onPress={() => pickImage('target')}>
            {targetUri
              ? <Image source={{ uri: targetUri }} style={s.pickedImg} />
              : <View style={s.pickerPlaceholder}>
                  <Text style={s.pickerIcon}>🖼️</Text>
                  <Text style={s.pickerHint}>Upload Target Image</Text>
                  <Text style={s.pickerSub}>Body + background இந்த photo-ல் இருக்கும்</Text>
                </View>}
            {targetUri ? <View style={s.changeBadge}><Text style={s.changeTxt}>Change ✏️</Text></View> : null}
          </TouchableOpacity>
        </View>

        {/* Image 2: Face source */}
        <View style={s.card}>
          <View style={s.badge}><Text style={s.badgeNum}>2</Text></View>
          <Text style={s.cardLabel}>Face Source — இந்த முகம் target-ல் swap ஆகும்</Text>
          <TouchableOpacity style={[s.picker, faceUri ? s.pickerFilled : null]} onPress={() => pickImage('face')}>
            {faceUri
              ? <Image source={{ uri: faceUri }} style={s.pickedImg} />
              : <View style={s.pickerPlaceholder}>
                  <Text style={s.pickerIcon}>🤳</Text>
                  <Text style={s.pickerHint}>Upload Face Photo</Text>
                  <Text style={s.pickerSub}>இந்த person-ஓட முகம் target-ல் வரும்</Text>
                </View>}
            {faceUri ? <View style={s.changeBadge}><Text style={s.changeTxt}>Change ✏️</Text></View> : null}
          </TouchableOpacity>
        </View>

        {/* Status */}
        {loading && statusMsg ? (
          <View style={s.statusCard}>
            <ActivityIndicator color="#7c3aed" size="small" style={{ marginRight: 10 }} />
            <Text style={s.statusTxt}>{statusMsg}</Text>
          </View>
        ) : null}

        {/* Swap button */}
        <TouchableOpacity
          style={[s.swapBtn, (!targetB64 || !faceB64 || loading) ? s.swapBtnOff : null]}
          onPress={startSwap}
          disabled={!targetB64 || !faceB64 || loading}
        >
          {loading
            ? <ActivityIndicator color="#fff" size="small" />
            : <Text style={s.swapBtnTxt}>✨ Swap Face ›</Text>}
        </TouchableOpacity>

        {loading ? (
          <Text style={s.waitTxt}>
            {enhanceEnabled ? '60–180 seconds எடுக்கும் (enhancement ON)...' : '30–90 seconds எடுக்கும்...'}
          </Text>
        ) : null}

        {/* Result */}
        {resultUrl ? (
          <View style={s.resultCard}>
            <Text style={s.resultTitle}>✅ Face Swap Complete!</Text>
            {usedModel ? (
              <View style={s.modelBadge}>
                <Text style={s.modelBadgeTxt}>🤖 {usedModel}</Text>
              </View>
            ) : null}
            <Image source={{ uri: resultUrl }} style={s.resultImg} resizeMode="contain" />
            <TouchableOpacity style={s.saveBtn} onPress={saveResult}>
              <Text style={s.saveBtnTxt}>⬇ Gallery-ல Save</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0f0f1a' },
  scroll: { padding: 20 },
  title: { fontSize: 26, fontWeight: '800', color: '#fff', textAlign: 'center', marginBottom: 4 },
  sub: { fontSize: 11, color: '#7c3aed', textAlign: 'center', marginBottom: 16, fontWeight: '700', letterSpacing: 0.5 },
  engineCard: { backgroundColor: '#1a1232', borderRadius: 14, padding: 14, marginBottom: 14, borderWidth: 1, borderColor: '#7c3aed55' },
  engineTitle: { color: '#a78bfa', fontSize: 13, fontWeight: '800', marginBottom: 8 },
  engineLine: { color: '#ccc', fontSize: 12, marginBottom: 3 },
  tipCard: { backgroundColor: '#1a2a1a', borderRadius: 12, padding: 14, marginBottom: 14, borderWidth: 1, borderColor: '#4ade8044' },
  tipTitle: { color: '#4ade80', fontSize: 13, fontWeight: '700', marginBottom: 6 },
  tipText: { color: '#aaa', fontSize: 12, marginBottom: 2 },
  toggleCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1a1a2e', borderRadius: 12, padding: 14, marginBottom: 16, borderWidth: 1, borderColor: '#7c3aed44', gap: 12 },
  toggleLabel: { color: '#e0d4ff', fontSize: 13, fontWeight: '700', marginBottom: 3 },
  toggleSub: { color: '#888', fontSize: 11 },
  card: { backgroundColor: '#1a1a2e', borderRadius: 16, padding: 16, marginBottom: 16, position: 'relative' },
  badge: { position: 'absolute', top: -12, left: 16, backgroundColor: '#7c3aed', borderRadius: 14, width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  badgeNum: { color: '#fff', fontWeight: '900', fontSize: 14 },
  cardLabel: { color: '#aaa', fontSize: 13, marginBottom: 10, marginTop: 4 },
  picker: { height: 200, borderRadius: 12, overflow: 'hidden', backgroundColor: '#0f0f1a', borderWidth: 1.5, borderStyle: 'dashed', borderColor: '#444' },
  pickerFilled: { borderStyle: 'solid', borderColor: '#7c3aed' },
  pickerPlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 6 },
  pickerIcon: { fontSize: 44 },
  pickerHint: { color: '#999', fontSize: 15, fontWeight: '700' },
  pickerSub: { color: '#555', fontSize: 11 },
  pickedImg: { width: '100%', height: '100%', resizeMode: 'cover' },
  changeBadge: { position: 'absolute', bottom: 8, right: 8, backgroundColor: 'rgba(124,58,237,0.9)', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 4 },
  changeTxt: { color: '#fff', fontSize: 11, fontWeight: '700' },
  statusCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1a1a2e', borderRadius: 12, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: '#7c3aed55' },
  statusTxt: { color: '#a78bfa', fontSize: 12, flex: 1 },
  swapBtn: { backgroundColor: '#7c3aed', borderRadius: 16, paddingVertical: 18, alignItems: 'center', marginTop: 4, elevation: 6, shadowColor: '#7c3aed', shadowOpacity: 0.5, shadowRadius: 12, shadowOffset: { width: 0, height: 4 } },
  swapBtnOff: { backgroundColor: '#2a2a3a', elevation: 0, shadowOpacity: 0 },
  swapBtnTxt: { color: '#fff', fontSize: 17, fontWeight: '800' },
  waitTxt: { color: '#666', fontSize: 12, textAlign: 'center', marginTop: 10 },
  resultCard: { backgroundColor: '#1a1a2e', borderRadius: 16, padding: 16, marginTop: 20 },
  resultTitle: { color: '#4ade80', fontSize: 16, fontWeight: '800', textAlign: 'center', marginBottom: 8 },
  modelBadge: { backgroundColor: '#1a1232', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, alignSelf: 'center', marginBottom: 10, borderWidth: 1, borderColor: '#7c3aed55' },
  modelBadgeTxt: { color: '#a78bfa', fontSize: 10, fontWeight: '700' },
  resultImg: { width: '100%', height: width - 40, borderRadius: 12, backgroundColor: '#0f0f1a' },
  saveBtn: { backgroundColor: '#1d4ed8', borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 12 },
  saveBtnTxt: { color: '#fff', fontSize: 14, fontWeight: '700' },
});
