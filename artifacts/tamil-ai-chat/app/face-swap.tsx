import React, { useState, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  ScrollView, Image, Alert, ActivityIndicator,
  Dimensions, StatusBar, FlatList,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';

const API_BASE = (process.env['EXPO_PUBLIC_API_URL'] ?? '').replace(/\/$/, '');
const { width } = Dimensions.get('window');
const CELL = (width - 48) / 2;

// 10 preset target images — different styles & poses
const PRESET_TARGETS = [
  { id: '1', label: 'Traditional Saree', url: 'https://image.pollinations.ai/prompt/beautiful%20indian%20woman%20wearing%20silk%20saree%2C%20traditional%20jewelry%2C%20temple%20background%2C%20photorealistic%2C%208k?width=512&height=768&seed=1001&nologo=true&nofeed=true' },
  { id: '2', label: 'Modern Office',     url: 'https://image.pollinations.ai/prompt/professional%20indian%20woman%20in%20formal%20office%20attire%2C%20corporate%20background%2C%20photorealistic%2C%208k?width=512&height=768&seed=1002&nologo=true&nofeed=true' },
  { id: '3', label: 'Beach Vacation',    url: 'https://image.pollinations.ai/prompt/beautiful%20indian%20woman%20at%20tropical%20beach%2C%20casual%20summer%20dress%2C%20golden%20sunset%2C%20photorealistic%2C%208k?width=512&height=768&seed=1003&nologo=true&nofeed=true' },
  { id: '4', label: 'Bollywood Glam',    url: 'https://image.pollinations.ai/prompt/glamorous%20indian%20actress%20bollywood%20style%2C%20designer%20outfit%2C%20studio%20lighting%2C%20photorealistic%2C%208k?width=512&height=768&seed=1004&nologo=true&nofeed=true' },
  { id: '5', label: 'Casual Jeans',      url: 'https://image.pollinations.ai/prompt/beautiful%20indian%20woman%20casual%20jeans%20tshirt%2C%20park%20background%2C%20natural%20light%2C%20photorealistic%2C%208k?width=512&height=768&seed=1005&nologo=true&nofeed=true' },
  { id: '6', label: 'Bridal Look',       url: 'https://image.pollinations.ai/prompt/indian%20bride%20bridal%20lehenga%20heavy%20jewelry%20mehendi%20wedding%20mandap%2C%20photorealistic%2C%208k?width=512&height=768&seed=1006&nologo=true&nofeed=true' },
  { id: '7', label: 'Night Party',       url: 'https://image.pollinations.ai/prompt/beautiful%20indian%20woman%20evening%20party%20dress%2C%20rooftop%20city%20lights%2C%20night%20photography%2C%20photorealistic%2C%208k?width=512&height=768&seed=1007&nologo=true&nofeed=true' },
  { id: '8', label: 'Ethnic Kurti',      url: 'https://image.pollinations.ai/prompt/beautiful%20indian%20woman%20colorful%20kurti%2C%20dupatta%2C%20garden%20background%2C%20photorealistic%2C%208k?width=512&height=768&seed=1008&nologo=true&nofeed=true' },
  { id: '9', label: 'Gym Fitness',       url: 'https://image.pollinations.ai/prompt/fit%20indian%20woman%20gym%20workout%20clothes%2C%20modern%20gym%20background%2C%20photorealistic%2C%208k?width=512&height=768&seed=1009&nologo=true&nofeed=true' },
  { id: '10', label: 'Royal Portrait',   url: 'https://image.pollinations.ai/prompt/royal%20indian%20woman%20palace%20background%2C%20regal%20pose%2C%20silk%20gown%2C%20dramatic%20lighting%2C%20photorealistic%2C%208k?width=512&height=768&seed=1010&nologo=true&nofeed=true' },
];

interface SwapResult {
  id: string;
  label: string;
  targetUrl: string;
  status: 'idle' | 'loading' | 'done' | 'error';
  resultUrl?: string;
  jobId?: string;
  error?: string;
}

export default function FaceSwapScreen() {
  const [selfieUri, setSelfieUri] = useState<string | null>(null);
  const [selfieB64, setSelfieB64] = useState<string | null>(null);
  const [results, setResults] = useState<SwapResult[]>(
    PRESET_TARGETS.map(t => ({ ...t, status: 'idle' }))
  );
  const [swapping, setSwapping] = useState(false);
  const pollTimers = useRef<Record<string, NodeJS.Timeout>>({});

  const upd = (id: string, data: Partial<SwapResult>) =>
    setResults(prev => prev.map(r => r.id === id ? { ...r, ...data } : r));

  const pickSelfie = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { Alert.alert('Permission', 'Gallery access வேணும்.'); return; }
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'] as any,
      quality: 0.7,
      base64: true,
    });
    if (!picked.canceled && picked.assets[0]) {
      const asset = picked.assets[0];
      if (asset.base64) {
        setSelfieUri(asset.uri);
        setSelfieB64(`data:${asset.mimeType ?? 'image/jpeg'};base64,${asset.base64}`);
      } else {
        try {
          const tmp = FileSystem.cacheDirectory + `selfie_${Date.now()}.jpg`;
          await FileSystem.copyAsync({ from: asset.uri, to: tmp });
          const b64 = await FileSystem.readAsStringAsync(tmp, { encoding: FileSystem.EncodingType.Base64 });
          await FileSystem.deleteAsync(tmp, { idempotent: true });
          setSelfieUri(asset.uri);
          setSelfieB64(`data:image/jpeg;base64,${b64}`);
        } catch { Alert.alert('பிழை', 'Photo read ஆகல.'); }
      }
    }
  };

  const pollJob = async (jobId: string, targetId: string) => {
    const check = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/face-swap/result/${jobId}`);
        const data = await res.json() as any;
        if (data.status === 'done' && data.result_url) {
          upd(targetId, { status: 'done', resultUrl: data.result_url });
        } else if (data.status === 'error') {
          upd(targetId, { status: 'error', error: data.error || 'Failed' });
        } else {
          pollTimers.current[targetId] = setTimeout(check, 3000);
        }
      } catch {
        pollTimers.current[targetId] = setTimeout(check, 5000);
      }
    };
    pollTimers.current[targetId] = setTimeout(check, 4000);
  };

  const startSwapOne = async (target: SwapResult, faceB64: string) => {
    upd(target.id, { status: 'loading', resultUrl: undefined, error: undefined });
    try {
      const res = await fetch(`${API_BASE}/api/face-swap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_url: target.targetUrl, target_url: faceB64 }),
      });
      const data = await res.json() as any;
      if (!res.ok || !data.jobId) throw new Error(data.error || 'Failed');
      upd(target.id, { jobId: data.jobId });
      pollJob(data.jobId, target.id);
    } catch (e: any) {
      upd(target.id, { status: 'error', error: e?.message || 'Error' });
    }
  };

  const startAllSwaps = async () => {
    if (!selfieB64) { Alert.alert('Selfie இல்லை', 'முதல்ல உன் photo select பண்ணு!'); return; }
    setSwapping(true);
    // Reset all
    setResults(PRESET_TARGETS.map(t => ({ ...t, status: 'idle' })));
    // Clear old timers
    Object.values(pollTimers.current).forEach(t => clearTimeout(t));
    pollTimers.current = {};
    // Start all 10 simultaneously
    await Promise.all(results.map(t => startSwapOne(t, selfieB64)));
    setSwapping(false);
  };

  const saveImage = async (url: string) => {
    try {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status !== 'granted') { Alert.alert('Permission', 'Gallery save permission வேணும்.'); return; }
      const tmp = FileSystem.cacheDirectory + `faceswap_${Date.now()}.jpg`;
      await FileSystem.downloadAsync(url, tmp);
      await MediaLibrary.saveToLibraryAsync(tmp);
      await FileSystem.deleteAsync(tmp, { idempotent: true });
      Alert.alert('✅ Saved!', 'Photo gallery-ல save ஆச்சு!');
    } catch { Alert.alert('பிழை', 'Save ஆகல. மீண்டும் try பண்ணு.'); }
  };

  const doneCount = results.filter(r => r.status === 'done').length;
  const loadingCount = results.filter(r => r.status === 'loading').length;

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

        {/* Header */}
        <View style={s.header}>
          <Text style={s.title}>AI Face Swap</Text>
          <Text style={s.sub}>1 selfie → 10 photos-ல உன் முகம்!</Text>
        </View>

        {/* Selfie Picker */}
        <TouchableOpacity style={[s.selfieBox, selfieUri && s.selfieBoxActive]} onPress={pickSelfie}>
          {selfieUri ? (
            <Image source={{ uri: selfieUri }} style={s.selfieImg} />
          ) : (
            <View style={s.selfiePlaceholder}>
              <Text style={s.selfieIcon}>🤳</Text>
              <Text style={s.selfieHint}>உன் selfie select பண்ணு</Text>
              <Text style={s.selfieHintSub}>Tap to pick from gallery</Text>
            </View>
          )}
          {selfieUri && (
            <View style={s.selfieEditBadge}>
              <Text style={s.selfieEditTxt}>✏️ Change</Text>
            </View>
          )}
        </TouchableOpacity>

        {/* Swap Button */}
        <TouchableOpacity
          style={[s.swapBtn, (!selfieUri || swapping) && s.swapBtnDisabled]}
          onPress={startAllSwaps}
          disabled={!selfieUri || swapping}
        >
          {swapping || loadingCount > 0 ? (
            <View style={s.swapBtnRow}>
              <ActivityIndicator color="#fff" size="small" />
              <Text style={s.swapBtnTxt}>  Swapping... ({loadingCount} processing)</Text>
            </View>
          ) : (
            <Text style={s.swapBtnTxt}>
              {doneCount > 0 ? `✨ Swap Again (${doneCount}/10 done)` : '✨ Swap Face in 10 Photos'}
            </Text>
          )}
        </TouchableOpacity>

        {/* Progress */}
        {(swapping || doneCount > 0) && (
          <View style={s.progress}>
            <View style={[s.progressBar, { width: `${(doneCount / 10) * 100}%` }]} />
            <Text style={s.progressTxt}>{doneCount}/10 complete</Text>
          </View>
        )}

        {/* Results Grid */}
        <View style={s.grid}>
          {results.map(item => (
            <View key={item.id} style={s.cell}>
              {/* Target preview / result */}
              <View style={s.imgBox}>
                {item.status === 'done' && item.resultUrl ? (
                  <Image source={{ uri: item.resultUrl }} style={s.resultImg} />
                ) : (
                  <Image
                    source={{ uri: item.targetUrl }}
                    style={[s.resultImg, item.status === 'loading' && s.dimmed]}
                  />
                )}
                {item.status === 'loading' && (
                  <View style={s.loadingOverlay}>
                    <ActivityIndicator color="#fff" size="large" />
                    <Text style={s.loadingTxt}>Swapping...</Text>
                  </View>
                )}
                {item.status === 'error' && (
                  <View style={s.errorOverlay}>
                    <Text style={s.errorIcon}>❌</Text>
                    <Text style={s.errorTxt}>Failed</Text>
                  </View>
                )}
                {item.status === 'done' && (
                  <View style={s.doneBadge}>
                    <Text style={s.doneTxt}>✅</Text>
                  </View>
                )}
              </View>
              <Text style={s.cellLabel}>{item.label}</Text>
              {item.status === 'done' && item.resultUrl && (
                <TouchableOpacity style={s.saveBtn} onPress={() => saveImage(item.resultUrl!)}>
                  <Text style={s.saveBtnTxt}>⬇ Save</Text>
                </TouchableOpacity>
              )}
            </View>
          ))}
        </View>

        <View style={{ height: 30 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0f0f1a' },
  scroll: { padding: 16 },

  header: { alignItems: 'center', marginBottom: 20, paddingTop: 8 },
  title: { fontSize: 26, fontWeight: '800', color: '#fff', letterSpacing: 0.5 },
  sub: { fontSize: 13, color: '#aaa', marginTop: 4 },

  selfieBox: {
    width: '100%', height: 180, borderRadius: 20,
    borderWidth: 2, borderStyle: 'dashed', borderColor: '#444',
    backgroundColor: '#1a1a2e', marginBottom: 16,
    overflow: 'hidden', alignItems: 'center', justifyContent: 'center',
  },
  selfieBoxActive: { borderStyle: 'solid', borderColor: '#7c3aed' },
  selfieImg: { width: '100%', height: '100%', resizeMode: 'cover' },
  selfiePlaceholder: { alignItems: 'center', gap: 8 },
  selfieIcon: { fontSize: 48 },
  selfieHint: { fontSize: 16, fontWeight: '700', color: '#fff' },
  selfieHintSub: { fontSize: 12, color: '#888' },
  selfieEditBadge: {
    position: 'absolute', bottom: 10, right: 10,
    backgroundColor: 'rgba(124,58,237,0.9)', borderRadius: 12,
    paddingHorizontal: 12, paddingVertical: 4,
  },
  selfieEditTxt: { color: '#fff', fontSize: 12, fontWeight: '700' },

  swapBtn: {
    backgroundColor: '#7c3aed', borderRadius: 18,
    paddingVertical: 18, alignItems: 'center', marginBottom: 16,
    elevation: 6, shadowColor: '#7c3aed', shadowOpacity: 0.5,
    shadowRadius: 12, shadowOffset: { width: 0, height: 4 },
  },
  swapBtnDisabled: { backgroundColor: '#333', elevation: 0, shadowOpacity: 0 },
  swapBtnRow: { flexDirection: 'row', alignItems: 'center' },
  swapBtnTxt: { color: '#fff', fontSize: 17, fontWeight: '800' },

  progress: {
    height: 36, backgroundColor: '#1a1a2e', borderRadius: 18,
    overflow: 'hidden', marginBottom: 16, justifyContent: 'center',
  },
  progressBar: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: '#7c3aed', borderRadius: 18 },
  progressTxt: { textAlign: 'center', color: '#fff', fontWeight: '700', fontSize: 13 },

  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, justifyContent: 'space-between' },
  cell: { width: CELL, marginBottom: 4 },
  imgBox: { width: CELL, height: CELL * 1.3, borderRadius: 14, overflow: 'hidden', backgroundColor: '#1a1a2e', marginBottom: 6 },
  resultImg: { width: '100%', height: '100%', resizeMode: 'cover' },
  dimmed: { opacity: 0.4 },
  loadingOverlay: {
    position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  loadingTxt: { color: '#fff', fontSize: 12, fontWeight: '700' },
  errorOverlay: {
    position: 'absolute', inset: 0, backgroundColor: 'rgba(220,38,38,0.7)',
    alignItems: 'center', justifyContent: 'center',
  },
  errorIcon: { fontSize: 28 },
  errorTxt: { color: '#fff', fontSize: 12, fontWeight: '700' },
  doneBadge: {
    position: 'absolute', top: 6, right: 6,
    backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 10,
    paddingHorizontal: 6, paddingVertical: 2,
  },
  doneTxt: { fontSize: 14 },

  cellLabel: { color: '#ccc', fontSize: 11, fontWeight: '600', textAlign: 'center', marginBottom: 4 },
  saveBtn: {
    backgroundColor: '#1d4ed8', borderRadius: 10,
    paddingVertical: 8, alignItems: 'center',
  },
  saveBtnTxt: { color: '#fff', fontSize: 12, fontWeight: '700' },
});
