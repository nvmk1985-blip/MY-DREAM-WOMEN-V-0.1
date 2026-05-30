import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  ScrollView, StatusBar, Dimensions, Image, Modal, FlatList, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ImagePicker from 'expo-image-picker';

const { width } = Dimensions.get('window');
const COLS = 4;
const TILE = (width - 32 - (COLS - 1) * 12) / COLS;
const COVER_H = 150;

const DEFAULT_COVER = require('../assets/images/icon.png');
const COVER_KEY = 'home_cover_image';
const CUSTOM_SERVER_KEY = 'custom_server_url';
const DEFAULT_RENDER_URL = 'https://my-girls-1-5.onrender.com';

const CATEGORIES = [
  { key: 'pictures',    label: 'Pictures',    emoji: '🖼️',  bg: '#4A90D9', route: '/gallery?album=pictures' },
  { key: 'camera',      label: 'Camera',      emoji: '📷',  bg: '#E8821A', route: '/gallery?album=camera' },
  { key: 'movies',      label: 'Movies',      emoji: '🎬',  bg: '#C0392B', route: '/gallery?album=movies' },
  { key: 'screenshots', label: 'Screenshots', emoji: '📱',  bg: '#27AE60', route: '/gallery?album=screenshots' },
  { key: 'downloads',   label: 'Downloads',   emoji: '⬇️',  bg: '#8E6BBE', route: '/gallery?album=downloads' },
  { key: 'documents',   label: 'Documents',   emoji: '📄',  bg: '#3498DB', route: '/gallery?album=documents' },
  { key: 'music',       label: 'Music',       emoji: '🎵',  bg: '#9B59B6', route: '/gallery?album=music' },
  { key: 'icons',       label: 'Icons',       emoji: '🎨',  bg: '#FF6B35', route: '/gallery?album=icons' },
  { key: 'ai-girls',    label: 'My AI Girls', emoji: '💕',  bg: '#E91E8C', route: '/ai-girls-cloud' },
  { key: 'projects',    label: 'Projects',    emoji: '💼',  bg: '#8E44AD', route: '/gallery?album=projects' },
  { key: 'notes',       label: 'Notes',       emoji: '📝',  bg: '#E67E22', route: '/notes' },
  { key: 'keys',        label: 'Keys',        emoji: '🔑',  bg: '#F0C040', route: '/keys' },
  { key: 'cloud',       label: 'Cloud',       emoji: '☁️',  bg: '#1ABC9C', route: '/cloud-storage' },
  { key: 'videos',      label: 'Videos',      emoji: '🎬',  bg: '#1565C0', route: '/videos' },
];

type CloudPhoto = { uri: string };

export default function HomeScreen() {
  const router = useRouter();
  const [coverUri, setCoverUri] = useState<string | null>(null);
  const [showPickModal, setShowPickModal] = useState(false);
  const [cloudPhotos, setCloudPhotos] = useState<CloudPhoto[]>([]);
  const [showCloudPicker, setShowCloudPicker] = useState(false);
  const [serverStatus, setServerStatus] = useState<'unknown'|'ok'|'sleeping'>('unknown');
  const [wakingServer, setWakingServer] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(COVER_KEY).then(v => { if (v) setCoverUri(v); }).catch(() => {});
    // Check Render server status on home load
    checkRenderServer();
  }, []);

  const checkRenderServer = async () => {
    try {
      const savedUrl = await AsyncStorage.getItem(CUSTOM_SERVER_KEY).catch(() => null);
      const serverUrl = savedUrl || DEFAULT_RENDER_URL;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(`${serverUrl}/api/healthz`, { signal: controller.signal });
      clearTimeout(timer);
      setServerStatus(res.ok ? 'ok' : 'sleeping');
    } catch {
      setServerStatus('sleeping');
    }
  };

  const wakeRenderServer = async () => {
    setWakingServer(true);
    setServerStatus('unknown');
    try {
      const savedUrl = await AsyncStorage.getItem(CUSTOM_SERVER_KEY).catch(() => null);
      const serverUrl = savedUrl || DEFAULT_RENDER_URL;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 35000);
      const res = await fetch(`${serverUrl}/api/healthz`, { signal: controller.signal });
      clearTimeout(timer);
      setServerStatus(res.ok ? 'ok' : 'sleeping');
    } catch {
      setServerStatus('sleeping');
    } finally {
      setWakingServer(false);
    }
  };

  const saveCover = useCallback(async (uri: string) => {
    setCoverUri(uri);
    try { await AsyncStorage.setItem(COVER_KEY, uri); } catch {}
  }, []);

  const pickFromGallery = async () => {
    setShowPickModal(false);
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) return;
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.85,
      });
      if (!res.canceled && res.assets[0]) {
        await saveCover(res.assets[0].uri);
      }
    } catch {}
  };

  const openCloudPicker = async () => {
    setShowPickModal(false);
    const photos: CloudPhoto[] = [];
    try {
      const keys = await AsyncStorage.getAllKeys();
      const cloudKeys = keys.filter(k => k.startsWith('cloud_photos_'));
      const pairs = await AsyncStorage.multiGet(cloudKeys);
      for (const [, val] of pairs) {
        if (!val) continue;
        try {
          const arr: { uri: string }[] = JSON.parse(val);
          for (const p of arr) { if (p?.uri) photos.push({ uri: p.uri }); }
        } catch {}
      }
    } catch {}
    setCloudPhotos(photos);
    setShowCloudPicker(true);
  };

  const resetToDefault = () => {
    setShowPickModal(false);
    setCoverUri(null);
    AsyncStorage.removeItem(COVER_KEY).catch(() => {});
  };

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <StatusBar backgroundColor="#075E54" barStyle="light-content" />

      {/* Cover image — only show if custom image set, else compact header bar */}
      {coverUri ? (
        <View style={s.coverWrap}>
          <Image
            source={{ uri: coverUri }}
            style={s.coverImg}
            resizeMode="cover"
            onError={() => {
              setCoverUri(null);
              AsyncStorage.removeItem(COVER_KEY).catch(() => {});
            }}
          />
          <View style={s.coverOverlay} />
          <View style={s.coverBar}>
            <View style={s.headerLeft}>
              <Text style={s.headerCloud}>☁️</Text>
              <Text style={s.headerTitle}>My Girls</Text>
            </View>
            <View style={s.coverActions}>
              <TouchableOpacity style={s.editBtn} onPress={() => setShowPickModal(true)}>
                <Text style={s.editBtnTxt}>✏️</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => router.push('/settings')}>
                <Text style={s.headerGear}>⚙️</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      ) : (
        <View style={s.compactBar}>
          <View style={s.headerLeft}>
            <Text style={s.headerCloud}>☁️</Text>
            <Text style={s.headerTitle}>My Girls</Text>
          </View>
          <View style={s.coverActions}>
            <TouchableOpacity style={s.editBtn} onPress={() => setShowPickModal(true)}>
              <Text style={s.editBtnTxt}>✏️</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => router.push('/settings')}>
              <Text style={s.headerGear}>⚙️</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>
        {/* Render Server Banner */}
        {serverStatus === 'sleeping' && (
          <View style={s.serverBanner}>
            <Text style={s.serverBannerTitle}>⚠️ Server-ஐ connect ஆகல</Text>
            <Text style={s.serverBannerSub}>Render சரியா run ஆகுதான்னு check பண்ணு. AI Girls chat slow ஆ இருக்கலாம்.</Text>
            <TouchableOpacity style={s.serverRetryBtn} onPress={wakeRenderServer} disabled={wakingServer}>
              {wakingServer
                ? <><ActivityIndicator size="small" color="#fff" /><Text style={s.serverRetryTxt}>  Connecting...</Text></>
                : <Text style={s.serverRetryTxt}>🔄 Retry</Text>
              }
            </TouchableOpacity>
          </View>
        )}

        <Text style={s.sectionLabel}>STORAGE</Text>

        <View style={s.grid}>
          {CATEGORIES.map(cat => (
            <TouchableOpacity
              key={cat.key}
              style={s.tile}
              onPress={() => { if (cat.route) router.push(cat.route as any); }}
              activeOpacity={0.7}
            >
              <View style={[s.tileIcon, { backgroundColor: cat.bg }]}>
                <Text style={s.tileEmoji}>{cat.emoji}</Text>
              </View>
              <Text style={s.tileLabel} numberOfLines={1}>{cat.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>

      {/* Pick source modal */}
      <Modal visible={showPickModal} transparent animationType="fade" onRequestClose={() => setShowPickModal(false)}>
        <TouchableOpacity style={s.pickOverlay} activeOpacity={1} onPress={() => setShowPickModal(false)}>
          <TouchableOpacity activeOpacity={1} style={s.pickBox}>
            <Text style={s.pickTitle}>🖼️ Cover Image மாத்து</Text>
            <Text style={s.pickSub}>எங்கிருந்து select பண்ணுவீர்கள்?</Text>

            <TouchableOpacity style={s.pickOption} onPress={pickFromGallery}>
              <Text style={s.pickOptionIcon}>📱</Text>
              <View>
                <Text style={s.pickOptionTitle}>Phone Gallery</Text>
                <Text style={s.pickOptionSub}>நேரடியா மொபைல் gallery-லிருந்து</Text>
              </View>
            </TouchableOpacity>

            <TouchableOpacity style={s.pickOption} onPress={openCloudPicker}>
              <Text style={s.pickOptionIcon}>☁️</Text>
              <View>
                <Text style={s.pickOptionTitle}>AI Girls Cloud</Text>
                <Text style={s.pickOptionSub}>உங்க cloud photos-லிருந்து</Text>
              </View>
            </TouchableOpacity>

            {coverUri && (
              <TouchableOpacity style={[s.pickOption, { borderColor: '#eee' }]} onPress={resetToDefault}>
                <Text style={s.pickOptionIcon}>🔄</Text>
                <View>
                  <Text style={s.pickOptionTitle}>Default-க்கு திரும்பு</Text>
                  <Text style={s.pickOptionSub}>Original Tamil Girls AI image</Text>
                </View>
              </TouchableOpacity>
            )}

            <TouchableOpacity style={s.pickCancel} onPress={() => setShowPickModal(false)}>
              <Text style={s.pickCancelTxt}>Cancel</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* Cloud photo picker */}
      <Modal visible={showCloudPicker} transparent animationType="slide" onRequestClose={() => setShowCloudPicker(false)}>
        <View style={s.cloudPickerWrap}>
          <View style={s.cloudPickerHeader}>
            <Text style={s.cloudPickerTitle}>☁️ Cloud Photo தேர்வு</Text>
            <TouchableOpacity onPress={() => setShowCloudPicker(false)}>
              <Text style={s.cloudPickerClose}>✕</Text>
            </TouchableOpacity>
          </View>
          {cloudPhotos.length === 0 ? (
            <View style={s.cloudEmpty}>
              <Text style={s.cloudEmptyTxt}>Cloud-ல் photos இல்லை.{'\n'}AI Girls Cloud-ல் photos upload பண்ணுங்க!</Text>
            </View>
          ) : (
            <FlatList
              data={cloudPhotos}
              numColumns={3}
              keyExtractor={(_, i) => String(i)}
              contentContainerStyle={{ padding: 8 }}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={s.cloudThumb}
                  onPress={async () => {
                    setShowCloudPicker(false);
                    await saveCover(item.uri);
                  }}
                >
                  <Image source={{ uri: item.uri }} style={s.cloudThumbImg} resizeMode="cover" />
                </TouchableOpacity>
              )}
            />
          )}
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const THUMB = (width - 16 - 4) / 3;

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#fff' },

  compactBar: {
    backgroundColor: '#075E54',
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18, paddingVertical: 12,
  },

  coverWrap: { width: '100%', height: COVER_H, position: 'relative' },
  coverImg: { width: '100%', height: COVER_H, position: 'absolute', top: 0, left: 0 },
  coverOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.15)',
  },
  coverBar: {
    position: 'absolute', top: 0, left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18, paddingTop: 14, paddingBottom: 10,
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  headerCloud: { fontSize: 26 },
  headerTitle: { color: '#fff', fontSize: 22, fontWeight: 'bold', textShadowColor: '#000', textShadowRadius: 6, textShadowOffset: { width: 0, height: 1 } },
  coverActions: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  editBtn: {
    backgroundColor: 'rgba(255,255,255,0.22)', borderRadius: 20,
    paddingHorizontal: 10, paddingVertical: 5,
  },
  editBtnTxt: { fontSize: 18 },
  headerGear: { fontSize: 24, color: '#fff' },

  scroll: { padding: 16, paddingBottom: 80 },
  sectionLabel: {
    fontSize: 12, fontWeight: '800', color: '#555',
    letterSpacing: 1.5, marginBottom: 16, marginLeft: 2,
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  tile: { width: TILE, alignItems: 'center' },
  tileIcon: {
    width: TILE - 8, height: TILE - 8,
    borderRadius: (TILE - 8) / 2,
    justifyContent: 'center', alignItems: 'center',
    marginBottom: 6, elevation: 2,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12, shadowRadius: 4,
  },
  tileEmoji: { fontSize: 28 },
  tileLabel: { fontSize: 11, color: '#333', fontWeight: '600', textAlign: 'center' },

  pickOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'flex-end',
  },
  pickBox: {
    backgroundColor: '#fff', borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: 24, paddingBottom: 36,
  },
  pickTitle: { fontSize: 18, fontWeight: 'bold', color: '#111', marginBottom: 4 },
  pickSub: { fontSize: 13, color: '#777', marginBottom: 20 },
  pickOption: {
    flexDirection: 'row', alignItems: 'center', gap: 16,
    borderWidth: 1.5, borderColor: '#e8e8e8',
    borderRadius: 14, padding: 16, marginBottom: 12,
  },
  pickOptionIcon: { fontSize: 32 },
  pickOptionTitle: { fontSize: 15, fontWeight: '700', color: '#111' },
  pickOptionSub: { fontSize: 12, color: '#777', marginTop: 2 },
  pickCancel: {
    marginTop: 4, backgroundColor: '#f5f5f5',
    borderRadius: 14, paddingVertical: 14, alignItems: 'center',
  },
  pickCancelTxt: { color: '#555', fontWeight: '700', fontSize: 15 },

  cloudPickerWrap: {
    flex: 1, marginTop: 60, backgroundColor: '#fff',
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
  },
  cloudPickerHeader: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between',
    padding: 20, borderBottomWidth: 1, borderBottomColor: '#eee',
  },
  cloudPickerTitle: { fontSize: 17, fontWeight: 'bold', color: '#111' },
  cloudPickerClose: { fontSize: 22, color: '#555', paddingHorizontal: 8 },
  cloudEmpty: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 40 },
  cloudEmptyTxt: { fontSize: 15, color: '#888', textAlign: 'center', lineHeight: 24 },
  cloudThumb: {
    width: THUMB, height: THUMB, margin: 2, borderRadius: 8, overflow: 'hidden',
  },
  cloudThumbImg: { width: '100%', height: '100%' },
  renderRefreshBtn: {
    backgroundColor: 'rgba(255,255,255,0.18)', borderRadius: 16,
    width: 34, height: 34, justifyContent: 'center', alignItems: 'center',
  },
  renderRefreshIcon: { fontSize: 18, color: '#fff' },
  serverBanner: {
    backgroundColor: '#1a0a00', borderRadius: 12, borderWidth: 1, borderColor: '#ff5252',
    padding: 14, marginBottom: 16, alignItems: 'center',
  },
  serverBannerTitle: { color: '#ff5252', fontSize: 14, fontWeight: '800', marginBottom: 4 },
  serverBannerSub: { color: '#ffb3b3', fontSize: 12, textAlign: 'center', lineHeight: 18, marginBottom: 10 },
  serverRetryBtn: {
    backgroundColor: '#1565C0', borderRadius: 20,
    paddingHorizontal: 28, paddingVertical: 9,
    flexDirection: 'row', alignItems: 'center',
  },
  serverRetryTxt: { color: '#fff', fontWeight: '700', fontSize: 14 },
});
