import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  Image, Alert, ActivityIndicator, ScrollView, Dimensions, StatusBar,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import AsyncStorage from '@react-native-async-storage/async-storage';

const { width } = Dimensions.get('window');

// Working HuggingFace Gradio spaces (new /gradio_api/call/ format)
const HF_SPACES = [
  {
    host: 'tonyassi-face-swap',
    endpoint: 'swap_faces',
    // data: [src_img (face to copy), dest_img (target)]
    buildData: (face: object, target: object) => [face, target],
  },
  {
    host: 'ALSv-FaceSwapAll',
    endpoint: 'predict',
    // data: [src_img, src_face_index, dest_img, dest_face_index]
    buildData: (face: object, target: object) => [face, 0, target, 0],
  },
  {
    host: 'WeShopAI-WeShopAI-Swap-Face-And-BG',
    endpoint: 'simple_generate',
    // data: [target_img, source_img]
    buildData: (face: object, target: object) => [target, face],
  },
];

function makeImageData(dataUri: string) {
  return {
    url: dataUri,
    meta: { _type: 'gradio.FileData' },
  };
}

async function callGradioSpace(
  host: string,
  endpoint: string,
  data: any[],
  hfToken?: string,
): Promise<string | null> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (hfToken) headers['Authorization'] = `Bearer ${hfToken}`;

  // Step 1: Submit job
  const submitRes = await fetch(
    `https://${host}.hf.space/gradio_api/call/${endpoint}`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ data }),
      signal: AbortSignal.timeout(30000),
    },
  );
  if (!submitRes.ok) return null;
  const submitJson: any = await submitRes.json();
  const eventId = submitJson?.event_id;
  if (!eventId) return null;

  // Step 2: Poll result (SSE stream)
  const pollRes = await fetch(
    `https://${host}.hf.space/gradio_api/call/${endpoint}/${eventId}`,
    { headers, signal: AbortSignal.timeout(120000) },
  );
  if (!pollRes.ok) return null;

  const text = await pollRes.text();
  const lines = text.split('\n');

  let resultData: any = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('event: complete')) {
      const dataLine = lines[i + 1] || '';
      if (dataLine.startsWith('data: ')) {
        try {
          resultData = JSON.parse(dataLine.slice(6));
        } catch { /* ignore */ }
      }
      break;
    }
    if (lines[i].startsWith('event: error')) return null;
  }

  if (!resultData || !Array.isArray(resultData) || resultData.length === 0) return null;

  // Extract image URL from result
  const first = resultData[0];
  if (!first) return null;
  if (typeof first === 'string') {
    if (first.startsWith('http') || first.startsWith('data:')) return first;
  }
  if (first?.url) return first.url as string;
  if (first?.path) return `https://${host}.hf.space/gradio_api/file=${first.path}`;

  return null;
}

export default function FaceSwapScreen() {
  const [targetUri, setTargetUri] = useState<string | null>(null);
  const [targetB64, setTargetB64] = useState<string | null>(null);
  const [faceUri, setFaceUri] = useState<string | null>(null);
  const [faceB64, setFaceB64] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState('');

  const pickImage = async (slot: 'target' | 'face') => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { Alert.alert('Permission', 'Gallery access வேணும்.'); return; }
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'] as any, quality: 0.7, base64: true,
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
      if (slot === 'target') { setTargetUri(asset.uri); setTargetB64(b64); setResultUrl(null); }
      else { setFaceUri(asset.uri); setFaceB64(b64); setResultUrl(null); }
    }
  };

  const startSwap = async () => {
    if (!targetB64 || !faceB64) {
      Alert.alert('Images இல்லை', 'இரண்டு photos-ம் select பண்ணுங்க.'); return;
    }
    setLoading(true); setResultUrl(null); setStatusMsg('Starting...');

    try {
      const keysRaw = await AsyncStorage.getItem('api_keys_store').catch(() => null);
      const keysMap = keysRaw ? JSON.parse(keysRaw) as Record<string, string> : {};
      const hfToken = keysMap['hf']?.trim() || undefined;

      const faceData = makeImageData(faceB64);
      const targetData = makeImageData(targetB64);

      let swapResult: string | null = null;

      for (let i = 0; i < HF_SPACES.length; i++) {
        const space = HF_SPACES[i];
        setStatusMsg(`AI space ${i + 1}/${HF_SPACES.length} try பண்றேன்...`);
        try {
          const data = space.buildData(faceData, targetData);
          swapResult = await callGradioSpace(space.host, space.endpoint, data, hfToken);
          if (swapResult) break;
        } catch {
          // try next
        }
      }

      if (swapResult) {
        setResultUrl(swapResult);
        setStatusMsg('');
      } else {
        Alert.alert(
          'Face Swap பிழை ❌',
          'AI spaces இப்போது busy அல்லது முகம் detect ஆகல.\n\n• முகம் clearly தெரியும் photo use பண்ணுங்க\n• சில நிமிடம் கழித்து மீண்டும் try பண்ணுங்க\n\nSettings-ல் HuggingFace key இருந்தால் faster ஆகும்.',
        );
        setStatusMsg('');
      }
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
        <Text style={s.sub}>✅ HuggingFace free AI · No API key needed!</Text>

        <View style={s.tipCard}>
          <Text style={s.tipTitle}>📸 Tips for best results:</Text>
          <Text style={s.tipText}>• முகம் clearly தெரியும் photos use பண்ணுங்க</Text>
          <Text style={s.tipText}>• Face நேரே (front-facing) இருக்கணும்</Text>
          <Text style={s.tipText}>• Clear, bright photos best ஆக work ஆகும்</Text>
        </View>

        {/* Image 1: Target */}
        <View style={s.card}>
          <View style={s.badge}><Text style={s.badgeNum}>1</Text></View>
          <Text style={s.cardLabel}>Original Image — முகம் வைக்க வேண்டிய photo</Text>
          <TouchableOpacity style={[s.picker, targetUri ? s.pickerFilled : null]} onPress={() => pickImage('target')}>
            {targetUri
              ? <Image source={{ uri: targetUri }} style={s.pickedImg} />
              : <View style={s.pickerPlaceholder}>
                  <Text style={s.pickerIcon}>🖼️</Text>
                  <Text style={s.pickerHint}>Upload Image ↑</Text>
                </View>}
            {targetUri ? <View style={s.changeBadge}><Text style={s.changeTxt}>Change ✏️</Text></View> : null}
          </TouchableOpacity>
        </View>

        {/* Image 2: Face */}
        <View style={s.card}>
          <View style={s.badge}><Text style={s.badgeNum}>2</Text></View>
          <Text style={s.cardLabel}>Face Photo — இந்த முகம் swap ஆகும்</Text>
          <TouchableOpacity style={[s.picker, faceUri ? s.pickerFilled : null]} onPress={() => pickImage('face')}>
            {faceUri
              ? <Image source={{ uri: faceUri }} style={s.pickedImg} />
              : <View style={s.pickerPlaceholder}>
                  <Text style={s.pickerIcon}>🤳</Text>
                  <Text style={s.pickerHint}>Upload Image ↑</Text>
                </View>}
            {faceUri ? <View style={s.changeBadge}><Text style={s.changeTxt}>Change ✏️</Text></View> : null}
          </TouchableOpacity>
        </View>

        {/* Status indicator */}
        {loading && statusMsg ? (
          <View style={s.statusCard}>
            <ActivityIndicator color="#7c3aed" size="small" style={{ marginRight: 10 }} />
            <Text style={s.statusTxt}>{statusMsg}</Text>
          </View>
        ) : null}

        {/* Swap Button */}
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
          <Text style={s.waitTxt}>இது 30–120 seconds எடுக்கும், காத்திரு...</Text>
        ) : null}

        {/* Result */}
        {resultUrl ? (
          <View style={s.resultCard}>
            <Text style={s.resultTitle}>✅ Face Swap Complete!</Text>
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
  sub: { fontSize: 12, color: '#4ade80', textAlign: 'center', marginBottom: 16, fontWeight: '600' },
  tipCard: { backgroundColor: '#1a2a1a', borderRadius: 12, padding: 14, marginBottom: 20, borderWidth: 1, borderColor: '#4ade8044' },
  tipTitle: { color: '#4ade80', fontSize: 13, fontWeight: '700', marginBottom: 6 },
  tipText: { color: '#aaa', fontSize: 12, marginBottom: 2 },
  card: { backgroundColor: '#1a1a2e', borderRadius: 16, padding: 16, marginBottom: 16, position: 'relative' },
  badge: { position: 'absolute', top: -12, left: 16, backgroundColor: '#7c3aed', borderRadius: 14, width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  badgeNum: { color: '#fff', fontWeight: '900', fontSize: 14 },
  cardLabel: { color: '#aaa', fontSize: 13, marginBottom: 10, marginTop: 4 },
  picker: { height: 180, borderRadius: 12, overflow: 'hidden', backgroundColor: '#0f0f1a', borderWidth: 1.5, borderStyle: 'dashed', borderColor: '#444' },
  pickerFilled: { borderStyle: 'solid', borderColor: '#7c3aed' },
  pickerPlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  pickerIcon: { fontSize: 44 },
  pickerHint: { color: '#999', fontSize: 15, fontWeight: '700' },
  pickedImg: { width: '100%', height: '100%', resizeMode: 'cover' },
  changeBadge: { position: 'absolute', bottom: 8, right: 8, backgroundColor: 'rgba(124,58,237,0.9)', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 4 },
  changeTxt: { color: '#fff', fontSize: 11, fontWeight: '700' },
  statusCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1a1a2e', borderRadius: 12, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: '#7c3aed55' },
  statusTxt: { color: '#a78bfa', fontSize: 13, flex: 1 },
  swapBtn: { backgroundColor: '#7c3aed', borderRadius: 16, paddingVertical: 18, alignItems: 'center', marginTop: 4, elevation: 6, shadowColor: '#7c3aed', shadowOpacity: 0.5, shadowRadius: 12, shadowOffset: { width: 0, height: 4 } },
  swapBtnOff: { backgroundColor: '#2a2a3a', elevation: 0, shadowOpacity: 0 },
  swapBtnTxt: { color: '#fff', fontSize: 17, fontWeight: '800' },
  waitTxt: { color: '#666', fontSize: 12, textAlign: 'center', marginTop: 10 },
  resultCard: { backgroundColor: '#1a1a2e', borderRadius: 16, padding: 16, marginTop: 20 },
  resultTitle: { color: '#4ade80', fontSize: 16, fontWeight: '800', textAlign: 'center', marginBottom: 12 },
  resultImg: { width: '100%', height: width - 40, borderRadius: 12, backgroundColor: '#0f0f1a' },
  saveBtn: { backgroundColor: '#1d4ed8', borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 12 },
  saveBtnTxt: { color: '#fff', fontSize: 14, fontWeight: '700' },
});
