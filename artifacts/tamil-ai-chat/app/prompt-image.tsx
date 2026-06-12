import React, { useState, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  Image, ActivityIndicator, ScrollView, Alert, Dimensions,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { generateImageHuggingFace, HF_IMAGE_MODEL, HF_NSFW_MODELS } from '../services/api';

const { width } = Dimensions.get('window');

const STYLE_PRESETS = [
  { label: 'Realistic', prompt: 'photorealistic, ultra detailed, 8k, RAW photo' },
  { label: 'Anime',     prompt: 'anime style, highly detailed, vibrant colors' },
  { label: 'Oil Paint', prompt: 'oil painting, classical art, renaissance style' },
  { label: 'Cinematic', prompt: 'cinematic lighting, film grain, dramatic shadows' },
  { label: 'Fantasy',   prompt: 'fantasy art, magical, ethereal glow, detailed' },
  { label: 'Portrait',  prompt: 'portrait photography, soft bokeh, studio lighting' },
];

// ── Gemini image→prompt via API server (uses GEMINI_API_KEY secret) ─────────
async function analyzeImageWithGemini(b64: string, mime: string): Promise<string> {
  const REPLIT_API = (process.env['EXPO_PUBLIC_API_URL'] ?? '').replace(/\/$/, '');
  const res = await fetch(`${REPLIT_API}/api/image-to-prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ b64, mime }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as any;
    throw new Error(err?.error || `Gemini API error: ${res.status}`);
  }
  const data = await res.json() as any;
  if (!data.prompt) throw new Error('Prompt generate ஆகல');
  return data.prompt as string;
}

// ── Progress Bar ────────────────────────────────────────────────────────────
function ProgressBar({ progress, msg }: { progress: number; msg: string }) {
  const p = Math.min(100, Math.max(0, progress));
  return (
    <View style={pb.wrap}>
      <View style={pb.row}>
        <Text style={pb.msg} numberOfLines={2}>{msg}</Text>
        <Text style={pb.pct}>{Math.round(p)}%</Text>
      </View>
      <View style={pb.track}>
        <View style={[pb.fill, { width: `${p}%` as any }]} />
      </View>
    </View>
  );
}
const pb = StyleSheet.create({
  wrap: { backgroundColor: '#12103a', borderRadius: 12, padding: 12, marginVertical: 8, borderWidth: 1, borderColor: '#E91E8C33' },
  row: { flexDirection: 'row', alignItems: 'center', marginBottom: 8, gap: 8 },
  msg: { color: '#c4b5fd', fontSize: 12, flex: 1, lineHeight: 18 },
  pct: { color: '#fff', fontSize: 20, fontWeight: '900', minWidth: 46, textAlign: 'right' },
  track: { height: 8, borderRadius: 4, backgroundColor: '#1e1b4b', overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 4, backgroundColor: '#E91E8C' },
});

// ── Main screen ──────────────────────────────────────────────────────────────
type Mode = 'text' | 'image';

export default function PromptImageScreen() {
  const router = useRouter();

  // Mode: text prompt OR image upload
  const [mode, setMode] = useState<Mode>('text');

  // Text mode
  const [prompt, setPrompt] = useState('');
  const [negPrompt, setNegPrompt] = useState('blurry, low quality, deformed, ugly, watermark');
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);

  // Image mode
  const [uploadedUri, setUploadedUri] = useState<string | null>(null);
  const [uploadedB64, setUploadedB64] = useState<string | null>(null);
  const [uploadedMime, setUploadedMime] = useState('image/jpeg');
  const [analyzedPrompt, setAnalyzedPrompt] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);

  // Common
  const [hfToken, setHfToken] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState(HF_IMAGE_MODEL);
  const [loading, setLoading] = useState(false);
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [progressMsg, setProgressMsg] = useState('');

  useFocusEffect(
    useCallback(() => {
      const loadToken = async () => {
        try {
          const [raw, legacyToken] = await Promise.all([
            AsyncStorage.getItem('api_keys_store'),
            AsyncStorage.getItem('hf_api_key'),
          ]);
          let token: string | null = null;
          if (raw) {
            const parsed = JSON.parse(raw) as Record<string, string>;
            token = parsed['hf'] || parsed['huggingface'] || null;
          }
          if (!token && legacyToken) token = legacyToken;
          setHfToken(token?.trim() || null);
        } catch {}
      };
      loadToken();
    }, [])
  );

  const applyPreset = (preset: { label: string; prompt: string }) => {
    setSelectedPreset(preset.label);
    setPrompt(prev => {
      const base = prev.replace(/,?\s*(photorealistic.*?8k.*?photo|anime style.*?colors|oil painting.*?style|cinematic.*?shadows|fantasy art.*?detailed|portrait photography.*?lighting)/gi, '').trim();
      return base ? `${base}, ${preset.prompt}` : preset.prompt;
    });
  };

  // Pick image from gallery
  const pickImage = async () => {
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
        b64 = asset.base64;
      } else {
        try {
          const tmp = FileSystem.cacheDirectory + `pi_${Date.now()}.jpg`;
          await FileSystem.copyAsync({ from: asset.uri, to: tmp });
          b64 = await FileSystem.readAsStringAsync(tmp, { encoding: FileSystem.EncodingType.Base64 });
          await FileSystem.deleteAsync(tmp, { idempotent: true });
        } catch { Alert.alert('பிழை', 'Photo read ஆகல.'); return; }
      }
      setUploadedUri(asset.uri);
      setUploadedB64(b64);
      setUploadedMime(mime);
      setAnalyzedPrompt(null);
      setImageUri(null);
      setError(null);
    }
  };

  // Analyze image → prompt using Gemini
  const analyzeImage = async () => {
    if (!uploadedB64) return;
    setAnalyzing(true);
    setAnalyzedPrompt(null);
    setError(null);
    try {
      const result = await analyzeImageWithGemini(uploadedB64, uploadedMime);
      setAnalyzedPrompt(result);
    } catch (e: any) {
      setError(e?.message || 'Image analyze ஆகல. மீண்டும் try பண்ணுங்க.');
    } finally {
      setAnalyzing(false);
    }
  };

  // Generate image from prompt
  const handleGenerate = async () => {
    const activePrompt = mode === 'image' ? analyzedPrompt : prompt.trim();

    if (!activePrompt) {
      if (mode === 'image' && uploadedB64 && !analyzedPrompt) {
        Alert.alert('முதலில் Analyze', '"🔍 Analyze & Get Prompt" button press பண்ணுங்க!');
      } else if (mode === 'image' && !uploadedB64) {
        Alert.alert('Photo இல்லை', 'முதலில் ஒரு photo upload பண்ணுங்க!');
      } else {
        Alert.alert('Prompt வேண்டும்', 'என்ன image வேண்டும் என்று type பண்ணுங்க!');
      }
      return;
    }

    if (!hfToken) {
      Alert.alert(
        'HuggingFace Token இல்லை',
        'Settings → Keys-ல் HuggingFace token add பண்ணுங்க.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: '⚙️ Settings', onPress: () => router.push('/keys') },
        ],
      );
      return;
    }

    setLoading(true);
    setError(null);
    setImageUri(null);
    setProgress(5);
    setProgressMsg('Preparing AI...');

    try {
      const fullPrompt = negPrompt.trim()
        ? `${activePrompt} ### negative: ${negPrompt.trim()}`
        : activePrompt;

      const result = await generateImageHuggingFace(
        fullPrompt, hfToken, selectedModel,
        (msg) => setProgressMsg(msg),
        (pct) => setProgress(pct),
      );
      setProgress(100);
      setProgressMsg('✅ Done!');
      await new Promise(r => setTimeout(r, 300));
      setImageUri(`data:${result.mimeType};base64,${result.b64_json}`);
    } catch (e: any) {
      setError(e?.message || 'Image generate பண்ண முடியலை. மீண்டும் try பண்ணுங்க.');
    } finally {
      setLoading(false);
      setProgress(0);
      setProgressMsg('');
    }
  };

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {/* Header */}
        <View style={s.header}>
          <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
            <Text style={s.backTxt}>← Back</Text>
          </TouchableOpacity>
          <Text style={s.headerTitle}>🎨 Image Studio</Text>
          <View style={{ width: 60 }} />
        </View>

        <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">

          {/* Mode Toggle */}
          <View style={s.modeToggle}>
            <TouchableOpacity
              style={[s.modeBtn, mode === 'text' && s.modeBtnActive]}
              onPress={() => { setMode('text'); setImageUri(null); setError(null); }}
            >
              <Text style={[s.modeTxt, mode === 'text' && s.modeTxtActive]}>✏️ Text Prompt</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.modeBtn, mode === 'image' && s.modeBtnActive]}
              onPress={() => { setMode('image'); setImageUri(null); setError(null); }}
            >
              <Text style={[s.modeTxt, mode === 'image' && s.modeTxtActive]}>📸 Image Upload</Text>
            </TouchableOpacity>
          </View>

          {/* Model badge */}
          <View style={s.modelBadge}>
            <Text style={s.modelBadgeTxt}>🤗 {HF_NSFW_MODELS.find(m => m.id === selectedModel)?.label ?? 'DreamShaper XL'}</Text>
            <View style={[s.dot, { backgroundColor: hfToken ? '#22c55e' : '#ef4444' }]} />
            <Text style={[s.tokenStatus, { color: hfToken ? '#22c55e' : '#ef4444' }]}>
              {hfToken ? 'Token ✅' : 'Token இல்லை ❌'}
            </Text>
          </View>

          {/* ── IMAGE UPLOAD MODE ── */}
          {mode === 'image' && (
            <View>
              <Text style={s.sectionLabel}>STEP 1 — PHOTO UPLOAD</Text>
              <TouchableOpacity style={s.uploadBox} onPress={pickImage}>
                {uploadedUri ? (
                  <View>
                    <Image source={{ uri: uploadedUri }} style={s.uploadedImg} resizeMode="cover" />
                    <View style={s.changeOverlay}>
                      <Text style={s.changeTxt}>📷 Change Photo</Text>
                    </View>
                  </View>
                ) : (
                  <View style={s.uploadPlaceholder}>
                    <Text style={s.uploadIcon}>📸</Text>
                    <Text style={s.uploadHint}>Photo Upload பண்ணுங்க</Text>
                    <Text style={s.uploadSub}>Gallery-ல் இருந்து எந்த photo-வும் OK</Text>
                  </View>
                )}
              </TouchableOpacity>

              {uploadedB64 && !analyzedPrompt && (
                <TouchableOpacity
                  style={[s.analyzeBtn, analyzing && s.analyzeBtnOff]}
                  onPress={analyzeImage}
                  disabled={analyzing}
                >
                  {analyzing ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                      <ActivityIndicator color="#fff" size="small" />
                      <Text style={s.analyzeBtnTxt}>Gemini AI analyzing...</Text>
                    </View>
                  ) : (
                    <Text style={s.analyzeBtnTxt}>🔍 Analyze & Get Prompt</Text>
                  )}
                </TouchableOpacity>
              )}

              {analyzedPrompt && (
                <View style={s.promptResult}>
                  <View style={s.promptResultHeader}>
                    <Text style={s.promptResultTitle}>✅ AI Generated Prompt</Text>
                    <TouchableOpacity onPress={pickImage}>
                      <Text style={s.reAnalyzeTxt}>🔄 New Photo</Text>
                    </TouchableOpacity>
                  </View>
                  <Text style={s.promptResultText}>{analyzedPrompt}</Text>
                  <TouchableOpacity
                    style={s.editPromptBtn}
                    onPress={() => {
                      setMode('text');
                      setPrompt(analyzedPrompt);
                    }}
                  >
                    <Text style={s.editPromptTxt}>✏️ Edit Prompt</Text>
                  </TouchableOpacity>
                </View>
              )}

              {analyzedPrompt && (
                <Text style={s.step2Label}>STEP 2 — IMAGE GENERATE</Text>
              )}
            </View>
          )}

          {/* ── TEXT PROMPT MODE ── */}
          {mode === 'text' && (
            <View>
              <Text style={s.sectionLabel}>STYLE PRESET</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.presetsRow}>
                {STYLE_PRESETS.map(p => (
                  <TouchableOpacity
                    key={p.label}
                    style={[s.presetChip, selectedPreset === p.label && s.presetChipActive]}
                    onPress={() => applyPreset(p)}
                  >
                    <Text style={[s.presetChipTxt, selectedPreset === p.label && s.presetChipTxtActive]}>
                      {p.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>

              <Text style={s.sectionLabel}>PROMPT</Text>
              <TextInput
                style={s.promptInput}
                value={prompt}
                onChangeText={setPrompt}
                placeholder="Example: beautiful Tamil girl, saree, smiling, garden background..."
                placeholderTextColor="#666"
                multiline
                numberOfLines={4}
                textAlignVertical="top"
              />
            </View>
          )}

          {/* Model selector — shown in both modes */}
          <Text style={s.sectionLabel}>MODEL</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 8, paddingBottom: 4 }} style={{ marginBottom: 10 }}>
            {HF_NSFW_MODELS.map(m => (
              <TouchableOpacity key={m.id}
                style={[s.presetChip, selectedModel === m.id && s.presetChipActive]}
                onPress={() => setSelectedModel(m.id)}>
                <Text style={[s.presetChipTxt, selectedModel === m.id && s.presetChipTxtActive]}>
                  {m.label}
                </Text>
                <Text style={{ fontSize: 9, color: selectedModel === m.id ? '#fff' : '#666', marginTop: 1 }}>
                  {m.tag}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          {/* Negative prompt */}
          <Text style={s.sectionLabel}>NEGATIVE PROMPT (வேண்டாதது)</Text>
          <TextInput
            style={[s.promptInput, { height: 60 }]}
            value={negPrompt}
            onChangeText={setNegPrompt}
            placeholder="blurry, low quality, deformed..."
            placeholderTextColor="#666"
            multiline
            textAlignVertical="top"
          />

          {/* Progress bar */}
          {loading && progress > 0 ? (
            <ProgressBar progress={progress} msg={progressMsg} />
          ) : null}

          {/* Generate button */}
          <TouchableOpacity
            style={[s.genBtn, (loading || analyzing) && s.genBtnDisabled]}
            onPress={handleGenerate}
            disabled={loading || analyzing}
            activeOpacity={0.8}
          >
            {loading ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <ActivityIndicator color="#fff" />
                <Text style={s.genBtnTxt}>Generating... ({Math.round(progress)}%)</Text>
              </View>
            ) : (
              <Text style={s.genBtnTxt}>
                {mode === 'image' && analyzedPrompt ? '🎨 இந்த Prompt-ல் Image Generate பண்ணு' : '🎨 Image Generate பண்ணு'}
              </Text>
            )}
          </TouchableOpacity>

          {/* No token warning */}
          {!hfToken && (
            <TouchableOpacity style={s.tokenWarning} onPress={() => router.push('/keys')}>
              <Text style={s.tokenWarningTxt}>
                ⚠️ HuggingFace Token இல்லை — Settings → Keys-ல் add பண்ணுங்க
              </Text>
            </TouchableOpacity>
          )}

          {/* Error */}
          {error && (
            <View style={s.errorBox}>
              <Text style={s.errorTxt}>❌ {error}</Text>
            </View>
          )}

          {/* Generated image */}
          {imageUri && (
            <View style={s.resultBox}>
              <Text style={s.resultLabel}>✅ Generated Image</Text>
              <Image source={{ uri: imageUri }} style={s.resultImg} resizeMode="contain" />
              <View style={s.resultBtns}>
                <TouchableOpacity style={s.regenBtn} onPress={handleGenerate}>
                  <Text style={s.regenBtnTxt}>🔄 மீண்டும் Generate</Text>
                </TouchableOpacity>
                {mode === 'image' && (
                  <TouchableOpacity
                    style={s.newPhotoBtn}
                    onPress={() => { setUploadedUri(null); setUploadedB64(null); setAnalyzedPrompt(null); setImageUri(null); }}
                  >
                    <Text style={s.newPhotoBtnTxt}>📸 New Photo</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
          )}

        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#0a0a0a' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: '#111', paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: '#222',
  },
  backBtn: { width: 60 },
  backTxt: { color: '#E91E8C', fontSize: 14, fontWeight: '600' },
  headerTitle: { color: '#fff', fontSize: 16, fontWeight: '700' },
  scroll: { padding: 16, paddingBottom: 40 },
  modeToggle: {
    flexDirection: 'row', backgroundColor: '#1a1a1a', borderRadius: 12,
    padding: 4, marginBottom: 14, borderWidth: 1, borderColor: '#333',
  },
  modeBtn: { flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: 'center' },
  modeBtnActive: { backgroundColor: '#E91E8C' },
  modeTxt: { color: '#888', fontSize: 13, fontWeight: '700' },
  modeTxtActive: { color: '#fff' },
  modelBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#1a1a2e', borderRadius: 10, padding: 10, marginBottom: 16,
    borderWidth: 1, borderColor: '#E91E8C33',
  },
  modelBadgeTxt: { color: '#ccc', fontSize: 12, flex: 1 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  tokenStatus: { fontSize: 12, fontWeight: '600' },
  sectionLabel: { color: '#888', fontSize: 11, fontWeight: '700', letterSpacing: 1, marginBottom: 8, marginTop: 4 },
  step2Label: { color: '#E91E8C', fontSize: 11, fontWeight: '700', letterSpacing: 1, marginBottom: 8, marginTop: 16 },
  presetsRow: { marginBottom: 16 },
  presetChip: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20,
    backgroundColor: '#1e1e1e', marginRight: 8, borderWidth: 1, borderColor: '#333',
  },
  presetChipActive: { backgroundColor: '#E91E8C', borderColor: '#E91E8C' },
  presetChipTxt: { color: '#aaa', fontSize: 13, fontWeight: '600' },
  presetChipTxtActive: { color: '#fff' },
  promptInput: {
    backgroundColor: '#1a1a1a', borderRadius: 12, borderWidth: 1, borderColor: '#333',
    color: '#fff', fontSize: 14, padding: 12, height: 100, marginBottom: 16,
  },
  uploadBox: {
    height: 200, borderRadius: 14, overflow: 'hidden', marginBottom: 12,
    backgroundColor: '#1a1a1a', borderWidth: 1.5, borderStyle: 'dashed', borderColor: '#444',
  },
  uploadedImg: { width: '100%', height: '100%' },
  changeOverlay: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: 'rgba(0,0,0,0.6)', paddingVertical: 8, alignItems: 'center',
  },
  changeTxt: { color: '#fff', fontSize: 13, fontWeight: '700' },
  uploadPlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  uploadIcon: { fontSize: 48 },
  uploadHint: { color: '#999', fontSize: 15, fontWeight: '700' },
  uploadSub: { color: '#555', fontSize: 12 },
  analyzeBtn: {
    backgroundColor: '#7c3aed', borderRadius: 12, paddingVertical: 14,
    alignItems: 'center', marginBottom: 12,
  },
  analyzeBtnOff: { backgroundColor: '#3a1f7a', opacity: 0.7 },
  analyzeBtnTxt: { color: '#fff', fontSize: 15, fontWeight: '700' },
  promptResult: {
    backgroundColor: '#12103a', borderRadius: 12, padding: 14,
    marginBottom: 12, borderWidth: 1, borderColor: '#7c3aed55',
  },
  promptResultHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  promptResultTitle: { color: '#a78bfa', fontSize: 13, fontWeight: '800' },
  reAnalyzeTxt: { color: '#E91E8C', fontSize: 12, fontWeight: '600' },
  promptResultText: { color: '#ddd', fontSize: 12, lineHeight: 20 },
  editPromptBtn: {
    marginTop: 10, backgroundColor: '#1e1e1e', borderRadius: 8,
    paddingVertical: 8, alignItems: 'center', borderWidth: 1, borderColor: '#555',
  },
  editPromptTxt: { color: '#aaa', fontSize: 12, fontWeight: '600' },
  genBtn: {
    backgroundColor: '#E91E8C', borderRadius: 14, paddingVertical: 16,
    alignItems: 'center', marginVertical: 8,
  },
  genBtnDisabled: { backgroundColor: '#7a0f47', opacity: 0.7 },
  genBtnTxt: { color: '#fff', fontSize: 16, fontWeight: '700' },
  tokenWarning: {
    backgroundColor: '#2a1a00', borderRadius: 10, padding: 12,
    borderWidth: 1, borderColor: '#f59e0b44', marginTop: 8,
  },
  tokenWarningTxt: { color: '#f59e0b', fontSize: 13, textAlign: 'center' },
  errorBox: {
    backgroundColor: '#2a0a0a', borderRadius: 10, padding: 12,
    borderWidth: 1, borderColor: '#ef444444', marginTop: 12,
  },
  errorTxt: { color: '#ef4444', fontSize: 13 },
  resultBox: { marginTop: 20 },
  resultLabel: { color: '#22c55e', fontSize: 14, fontWeight: '700', marginBottom: 10 },
  resultImg: { width: width - 32, height: width - 32, borderRadius: 14, backgroundColor: '#111' },
  resultBtns: { flexDirection: 'row', gap: 10, marginTop: 12 },
  regenBtn: {
    flex: 1, backgroundColor: '#1e1e1e', borderRadius: 12,
    paddingVertical: 12, alignItems: 'center', borderWidth: 1, borderColor: '#333',
  },
  regenBtnTxt: { color: '#E91E8C', fontSize: 14, fontWeight: '600' },
  newPhotoBtn: {
    flex: 1, backgroundColor: '#1a1232', borderRadius: 12,
    paddingVertical: 12, alignItems: 'center', borderWidth: 1, borderColor: '#7c3aed55',
  },
  newPhotoBtnTxt: { color: '#a78bfa', fontSize: 14, fontWeight: '600' },
});
