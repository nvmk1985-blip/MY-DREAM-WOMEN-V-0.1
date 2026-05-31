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

const API_BASE = (process.env['EXPO_PUBLIC_API_URL'] ?? '').replace(/\/$/, '');
const { width } = Dimensions.get('window');

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

  const poll = async (jid: string): Promise<string> => {
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 4000));
      setStatusMsg(`Processing... ${(i + 1) * 4}s`);
      try {
        const res = await fetch(`${API_BASE}/api/face-swap/result/${jid}`);
        const data = await res.json() as any;
        if (data.status === 'done' && data.result_url) return data.result_url;
        if (data.status === 'error') throw new Error(data.error || 'Swap failed');
      } catch (e: any) { if (!e?.message?.includes('result')) throw e; }
    }
    throw new Error('Timeout — மீண்டும் try பண்ணுங்க.');
  };

  const startSwap = async () => {
    if (!targetB64 || !faceB64) {
      Alert.alert('Images இல்லை', 'இரண்டு photos-ம் select பண்ணுங்க.'); return;
    }
    setLoading(true); setResultUrl(null); setStatusMsg('Starting...');
    try {
      const keysRaw = await AsyncStorage.getItem('api_keys_store').catch(() => null);
      const keysMap = keysRaw ? JSON.parse(keysRaw) as Record<string, string> : {};
      const hfToken = keysMap['hf']?.trim() || '';
      const hdrs: Record<string, string> = { 'Content-Type': 'application/json' };
      if (hfToken) hdrs['x-hf-token'] = hfToken;

      const res = await fetch(`${API_BASE}/api/face-swap`, {
        method: 'POST', headers: hdrs,
        body: JSON.stringify({ target_url: targetB64, face_url: faceB64 }),
      });
      const data = await res.json() as any;
      if (!res.ok || !data.jobId) throw new Error(data.error || 'Start failed');
      setStatusMsg('Queued — AI processing...');
      const url = await poll(data.jobId);
      setResultUrl(url); setStatusMsg('');
    } catch (e: any) {
      Alert.alert('Face Swap பிழை ❌', e?.message || 'மீண்டும் try பண்ணுங்க.');
      setStatusMsg('');
    } finally { setLoading(false); }
  };

  const saveResult = async () => {
    if (!resultUrl) return;
    try {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status !== 'granted') { Alert.alert('Permission', 'Gallery permission வேணும்.'); return; }
      const tmp = FileSystem.cacheDirectory + `faceswap_${Date.now()}.jpg`;
      await FileSystem.downloadAsync(resultUrl, tmp);
      await MediaLibrary.saveToLibraryAsync(tmp);
      await FileSystem.deleteAsync(tmp, { idempotent: true });
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
        <Text style={s.sub}>HuggingFace free AI · 2 photos மட்டும்!</Text>

        {/* Image 1: Target */}
        <View style={s.card}>
          <View style={s.badge}><Text style={s.badgeNum}>1</Text></View>
          <Text style={s.cardLabel}>Original Image — முகம் வைக்க வேண்டிய photo</Text>
          <TouchableOpacity style={[s.picker, targetUri && s.pickerFilled]} onPress={() => pickImage('target')}>
            {targetUri
              ? <Image source={{ uri: targetUri }} style={s.pickedImg} />
              : <View style={s.pickerPlaceholder}>
                  <Text style={s.pickerIcon}>🖼️</Text>
                  <Text style={s.pickerHint}>Upload Image ↑</Text>
                </View>}
            {targetUri && <View style={s.changeBadge}><Text style={s.changeTxt}>Change ✏️</Text></View>}
          </TouchableOpacity>
        </View>

        {/* Image 2: Face */}
        <View style={s.card}>
          <View style={s.badge}><Text style={s.badgeNum}>2</Text></View>
          <Text style={s.cardLabel}>Face Photo — இந்த முகம் swap ஆகும்</Text>
          <TouchableOpacity style={[s.picker, faceUri && s.pickerFilled]} onPress={() => pickImage('face')}>
            {faceUri
              ? <Image source={{ uri: faceUri }} style={s.pickedImg} />
              : <View style={s.pickerPlaceholder}>
                  <Text style={s.pickerIcon}>🤳</Text>
                  <Text style={s.pickerHint}>Upload Image ↑</Text>
                </View>}
            {faceUri && <View style={s.changeBadge}><Text style={s.changeTxt}>Change ✏️</Text></View>}
          </TouchableOpacity>
        </View>

        {/* Swap Button */}
        <TouchableOpacity
          style={[s.swapBtn, (!targetB64 || !faceB64 || loading) && s.swapBtnOff]}
          onPress={startSwap}
          disabled={!targetB64 || !faceB64 || loading}
        >
          {loading
            ? <ActivityIndicator color="#fff" size="small" />
            : <Text style={s.swapBtnTxt}>✨ Swap Face ›</Text>}
        </TouchableOpacity>
        {loading && statusMsg ? (
          <Text style={s.statusTxt}>{statusMsg} — இது 30–90 seconds எடுக்கும்</Text>
        ) : null}

        {/* Result */}
        {resultUrl && (
          <View style={s.resultCard}>
            <Text style={s.resultTitle}>✅ Face Swap Complete!</Text>
            <Image source={{ uri: resultUrl }} style={s.resultImg} resizeMode="contain" />
            <TouchableOpacity style={s.saveBtn} onPress={saveResult}>
              <Text style={s.saveBtnTxt}>⬇ Gallery-ல Save</Text>
            </TouchableOpacity>
          </View>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0f0f1a' },
  scroll: { padding: 20 },
  title: { fontSize: 26, fontWeight: '800', color: '#fff', textAlign: 'center', marginBottom: 4 },
  sub: { fontSize: 12, color: '#888', textAlign: 'center', marginBottom: 24 },
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
  swapBtn: { backgroundColor: '#7c3aed', borderRadius: 16, paddingVertical: 18, alignItems: 'center', marginTop: 4, elevation: 6, shadowColor: '#7c3aed', shadowOpacity: 0.5, shadowRadius: 12, shadowOffset: { width: 0, height: 4 } },
  swapBtnOff: { backgroundColor: '#2a2a3a', elevation: 0, shadowOpacity: 0 },
  swapBtnTxt: { color: '#fff', fontSize: 17, fontWeight: '800' },
  statusTxt: { color: '#888', fontSize: 12, textAlign: 'center', marginTop: 8 },
  resultCard: { backgroundColor: '#1a1a2e', borderRadius: 16, padding: 16, marginTop: 20 },
  resultTitle: { color: '#4ade80', fontSize: 16, fontWeight: '800', textAlign: 'center', marginBottom: 12 },
  resultImg: { width: '100%', height: width - 40, borderRadius: 12, backgroundColor: '#0f0f1a' },
  saveBtn: { backgroundColor: '#1d4ed8', borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 12 },
  saveBtnTxt: { color: '#fff', fontSize: 14, fontWeight: '700' },
});
