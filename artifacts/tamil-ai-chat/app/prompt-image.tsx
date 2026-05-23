import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  Image, ActivityIndicator, ScrollView, Alert, Dimensions, KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { generateImageHuggingFace, HF_IMAGE_MODEL } from '../services/api';

const { width } = Dimensions.get('window');

const STYLE_PRESETS = [
  { label: 'Realistic', prompt: 'photorealistic, ultra detailed, 8k, RAW photo' },
  { label: 'Anime',     prompt: 'anime style, highly detailed, vibrant colors' },
  { label: 'Oil Paint', prompt: 'oil painting, classical art, renaissance style' },
  { label: 'Cinematic', prompt: 'cinematic lighting, film grain, dramatic shadows' },
  { label: 'Fantasy',   prompt: 'fantasy art, magical, ethereal glow, detailed' },
  { label: 'Portrait',  prompt: 'portrait photography, soft bokeh, studio lighting' },
];

export default function PromptImageScreen() {
  const router = useRouter();
  const [prompt, setPrompt] = useState('');
  const [negPrompt, setNegPrompt] = useState('blurry, low quality, deformed, ugly, watermark');
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
  const [hfToken, setHfToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const handleGenerate = async () => {
    if (!prompt.trim()) {
      Alert.alert('Prompt வேண்டும்', 'என்ன image வேண்டும் என்று type பண்ணுங்க!');
      return;
    }
    if (!hfToken) {
      Alert.alert(
        'HuggingFace Token இல்லை',
        'Settings → Keys-ல் HuggingFace token add பண்ணுங்க. huggingface.co-ல் free account → Access Tokens → read role.',
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

    try {
      const fullPrompt = negPrompt.trim()
        ? `${prompt.trim()} ### negative: ${negPrompt.trim()}`
        : prompt.trim();

      const result = await generateImageHuggingFace(fullPrompt, hfToken, HF_IMAGE_MODEL);
      setImageUri(`data:${result.mimeType};base64,${result.b64_json}`);
    } catch (e: any) {
      setError(e?.message || 'Image generate பண்ண முடியலை. மீண்டும் try பண்ணுங்க.');
    } finally {
      setLoading(false);
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
          <Text style={s.headerTitle}>🎨 Prompt → Image</Text>
          <View style={{ width: 60 }} />
        </View>

        <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
          {/* Model badge */}
          <View style={s.modelBadge}>
            <Text style={s.modelBadgeTxt}>🤗 Model: PornMaster-pro-V7</Text>
            <View style={[s.dot, { backgroundColor: hfToken ? '#22c55e' : '#ef4444' }]} />
            <Text style={[s.tokenStatus, { color: hfToken ? '#22c55e' : '#ef4444' }]}>
              {hfToken ? 'Token ✅' : 'Token இல்லை ❌'}
            </Text>
          </View>

          {/* Style Presets */}
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

          {/* Prompt input */}
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

          {/* Generate button */}
          <TouchableOpacity
            style={[s.genBtn, loading && s.genBtnDisabled]}
            onPress={handleGenerate}
            disabled={loading}
            activeOpacity={0.8}
          >
            {loading ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <ActivityIndicator color="#fff" />
                <Text style={s.genBtnTxt}>Generating... (20–60 sec)</Text>
              </View>
            ) : (
              <Text style={s.genBtnTxt}>🎨 Image Generate பண்ணு</Text>
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
              <Image
                source={{ uri: imageUri }}
                style={s.resultImg}
                resizeMode="contain"
              />
              <TouchableOpacity
                style={s.regenBtn}
                onPress={handleGenerate}
              >
                <Text style={s.regenBtnTxt}>🔄 மீண்டும் Generate பண்ணு</Text>
              </TouchableOpacity>
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
  modelBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#1a1a2e', borderRadius: 10, padding: 10, marginBottom: 16,
    borderWidth: 1, borderColor: '#E91E8C33',
  },
  modelBadgeTxt: { color: '#ccc', fontSize: 12, flex: 1 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  tokenStatus: { fontSize: 12, fontWeight: '600' },
  sectionLabel: {
    color: '#888', fontSize: 11, fontWeight: '700', letterSpacing: 1,
    marginBottom: 8, marginTop: 4,
  },
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
  resultImg: {
    width: width - 32, height: width - 32,
    borderRadius: 14, backgroundColor: '#111',
  },
  regenBtn: {
    marginTop: 12, backgroundColor: '#1e1e1e', borderRadius: 12,
    paddingVertical: 12, alignItems: 'center', borderWidth: 1, borderColor: '#333',
  },
  regenBtnTxt: { color: '#E91E8C', fontSize: 14, fontWeight: '600' },
});
