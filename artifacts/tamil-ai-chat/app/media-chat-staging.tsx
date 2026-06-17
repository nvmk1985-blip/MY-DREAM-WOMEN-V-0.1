/**
 * MediaChatStaging — Phase 1 + 2 + 3 feature screen
 *
 * Flow:
 *  1. User picks photo / video from gallery or camera
 *  2. Staging UI: preview + caption input
 *  3. Send → POST /api/media-chat (multipart/form-data)
 *  4. Backend: Multer → Cloudinary → Gemini Tamil romantic reply
 *  5. Chat bubbles: user side (media + caption) + AI side (reply)
 *
 * Add this screen to your expo-router navigation:
 *   <Stack.Screen name="media-chat-staging" options={{ title: 'Photo Chat' }} />
 */

import React, { useState, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  FlatList, Image, ActivityIndicator, Platform, KeyboardAvoidingView,
  ScrollView, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// ── Config ───────────────────────────────────────────────────────────────────
// The Replit shared proxy routes /api → your Express server automatically.
// For APK builds set EXPO_PUBLIC_API_URL=https://your-render-url.onrender.com
const API_BASE = (process.env['EXPO_PUBLIC_API_URL'] ?? '').replace(/\/$/, '');

// ── Types ────────────────────────────────────────────────────────────────────
interface MediaAsset {
  uri: string;
  type: 'image' | 'video';
  mimeType: string;
  fileName: string;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'ai';
  caption?: string;
  mediaUrl?: string;      // Cloudinary URL (after server responds)
  localUri?: string;      // local URI shown while uploading
  mediaType?: 'image' | 'video';
  text?: string;          // AI reply text
  loading?: boolean;
}

// ── Helper: unique id ────────────────────────────────────────────────────────
const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// ── Component ─────────────────────────────────────────────────────────────────
export default function MediaChatStaging() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  // Staging state
  const [staged, setStaged] = useState<MediaAsset | null>(null);
  const [caption, setCaption] = useState('');
  const [sending, setSending] = useState(false);

  // Chat history
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  const flatListRef = useRef<FlatList>(null);

  // ── Request media permissions ────────────────────────────────────────────
  const requestPermissions = async (): Promise<boolean> => {
    if (Platform.OS === 'web') return true;
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Gallery access வேணும் — Settings-ல் allow பண்ணுங்க.');
      return false;
    }
    return true;
  };

  // ── Pick image/video from gallery ────────────────────────────────────────
  const pickMedia = async () => {
    const ok = await requestPermissions();
    if (!ok) return;

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      quality: 0.85,
      videoMaxDuration: 60,
      allowsEditing: false,
    });

    if (result.canceled || !result.assets?.length) return;

    const asset = result.assets[0];
    const isVideo = asset.type === 'video';

    setStaged({
      uri: asset.uri,
      type: isVideo ? 'video' : 'image',
      mimeType: isVideo ? 'video/mp4' : (asset.mimeType || 'image/jpeg'),
      fileName: asset.fileName || (isVideo ? 'upload.mp4' : 'upload.jpg'),
    });
  };

  // ── Pick from camera ─────────────────────────────────────────────────────
  const openCamera = async () => {
    if (Platform.OS === 'web') { Alert.alert('Camera', 'Gallery use பண்ணுங்க (web-ல் camera இல்லை)'); return; }
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Camera access வேணும்.');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'],
      quality: 0.85,
      allowsEditing: false,
    });
    if (result.canceled || !result.assets?.length) return;
    const asset = result.assets[0];
    setStaged({
      uri: asset.uri,
      type: 'image',
      mimeType: asset.mimeType || 'image/jpeg',
      fileName: asset.fileName || 'photo.jpg',
    });
  };

  // ── Send staged media + caption to backend ───────────────────────────────
  const sendMessage = async () => {
    if (!staged || sending) return;

    const msgCaption = caption.trim();
    const localUri = staged.uri;
    const msgId = uid();
    const aiId = uid();

    // Optimistically add user bubble + loading AI bubble
    setMessages(prev => [
      ...prev,
      {
        id: msgId,
        role: 'user',
        caption: msgCaption || undefined,
        localUri,
        mediaType: staged.type,
      },
      { id: aiId, role: 'ai', loading: true },
    ]);

    // Clear staging area
    setStaged(null);
    setCaption('');
    setSending(true);

    setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);

    try {
      // Build FormData
      const form = new FormData();
      form.append('file', {
        uri: localUri,
        type: staged.mimeType,
        name: staged.fileName,
      } as any);
      if (msgCaption) form.append('caption', msgCaption);
      form.append('persona', 'Kaviya'); // Change to dynamic character name if needed

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120_000); // 2 min timeout for video

      const res = await fetch(`${API_BASE}/api/media-chat`, {
        method: 'POST',
        body: form,
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as any;
        throw new Error(err?.error || `Server error: ${res.status}`);
      }

      const data = await res.json() as { mediaUrl: string; aiResponse: string };

      // Update user bubble with Cloudinary URL, replace AI loading with reply
      setMessages(prev => prev.map(m => {
        if (m.id === msgId) return { ...m, mediaUrl: data.mediaUrl, localUri: undefined };
        if (m.id === aiId)  return { id: aiId, role: 'ai', text: data.aiResponse, loading: false };
        return m;
      }));

    } catch (err: any) {
      const errText = err?.name === 'AbortError'
        ? '⏱ Timeout — மீண்டும் try பண்ணுங்க.'
        : `❌ ${err?.message || 'Something went wrong'}`;

      setMessages(prev => prev.map(m =>
        m.id === aiId ? { id: aiId, role: 'ai', text: errText, loading: false } : m,
      ));
    } finally {
      setSending(false);
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 150);
    }
  };

  // ── Render a single chat bubble ──────────────────────────────────────────
  const renderBubble = ({ item }: { item: ChatMessage }) => {
    const isUser = item.role === 'user';
    const displayUri = item.mediaUrl || item.localUri;

    return (
      <View style={[styles.bubbleRow, isUser ? styles.bubbleRowRight : styles.bubbleRowLeft]}>
        {!isUser && (
          <View style={styles.aiAvatar}>
            <Text style={styles.aiAvatarText}>K</Text>
          </View>
        )}
        <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAI]}>
          {/* Media preview */}
          {isUser && displayUri ? (
            <Image
              source={{ uri: displayUri }}
              style={styles.bubbleImage}
              resizeMode="cover"
            />
          ) : null}

          {/* Caption or AI text */}
          {item.loading ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator size="small" color="#E91E8C" />
              <Text style={styles.loadingText}>Kaviya பதில் சொல்றா...</Text>
            </View>
          ) : item.text ? (
            <Text style={[styles.bubbleText, isUser ? styles.bubbleTextUser : styles.bubbleTextAI]}>
              {item.text}
            </Text>
          ) : null}

          {isUser && item.caption ? (
            <Text style={[styles.bubbleText, styles.bubbleTextUser, { marginTop: displayUri ? 6 : 0 }]}>
              {item.caption}
            </Text>
          ) : null}
        </View>
      </View>
    );
  };

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="arrow-back" size={24} color="#fff" />
        </TouchableOpacity>
        <View style={styles.headerInfo}>
          <View style={styles.headerAvatar}>
            <Text style={styles.headerAvatarText}>K</Text>
          </View>
          <View>
            <Text style={styles.headerName}>Kaviya</Text>
            <Text style={styles.headerSub}>Online ❤️</Text>
          </View>
        </View>
      </View>

      {/* Chat list */}
      <FlatList
        ref={flatListRef}
        data={messages}
        keyExtractor={m => m.id}
        renderItem={renderBubble}
        contentContainerStyle={[styles.chatList, { paddingBottom: insets.bottom + 8 }]}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Ionicons name="image-outline" size={48} color="#ddd" />
            <Text style={styles.emptyText}>Photo அல்லது Video அனுப்பு</Text>
            <Text style={styles.emptySubText}>Kaviya பாத்து தமிழில் reply பண்றா ❤️</Text>
          </View>
        }
      />

      {/* Staging preview */}
      {staged && (
        <View style={styles.stagingContainer}>
          <View style={styles.stagingPreview}>
            <Image source={{ uri: staged.uri }} style={styles.stagingImage} resizeMode="cover" />
            <TouchableOpacity style={styles.stagingRemove} onPress={() => { setStaged(null); setCaption(''); }}>
              <Ionicons name="close-circle" size={22} color="#fff" />
            </TouchableOpacity>
            {staged.type === 'video' && (
              <View style={styles.videoBadge}>
                <Ionicons name="videocam" size={14} color="#fff" />
                <Text style={styles.videoBadgeText}>Video</Text>
              </View>
            )}
          </View>
          <TextInput
            style={styles.captionInput}
            value={caption}
            onChangeText={setCaption}
            placeholder="Caption type பண்ணு... (e.g. How do we look together?)"
            placeholderTextColor="#aaa"
            multiline
            maxLength={300}
          />
        </View>
      )}

      {/* Bottom toolbar */}
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={0}>
        <View style={[styles.toolbar, { paddingBottom: insets.bottom || 12 }]}>
          <TouchableOpacity style={styles.mediaBtn} onPress={pickMedia}>
            <Ionicons name="image-outline" size={26} color="#E91E8C" />
          </TouchableOpacity>
          <TouchableOpacity style={styles.mediaBtn} onPress={openCamera}>
            <Ionicons name="camera-outline" size={26} color="#E91E8C" />
          </TouchableOpacity>

          {staged ? (
            <TouchableOpacity
              style={[styles.sendBtn, sending && styles.sendBtnDisabled]}
              onPress={sendMessage}
              disabled={sending}
            >
              {sending ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Ionicons name="send" size={20} color="#fff" />
              )}
            </TouchableOpacity>
          ) : (
            <View style={styles.hintContainer}>
              <Text style={styles.hintText}>Photo / Video தேர்வு பண்ணு</Text>
            </View>
          )}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const PINK = '#E91E8C';
const DARK = '#1a1a2e';
const BUBBLE_AI_BG = '#f0f0f8';
const BUBBLE_USER_BG = PINK;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fafafa' },

  // Header
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: DARK, paddingHorizontal: 14, paddingVertical: 12,
  },
  backBtn: { padding: 4 },
  headerInfo: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 },
  headerAvatar: { width: 38, height: 38, borderRadius: 19, backgroundColor: PINK, justifyContent: 'center', alignItems: 'center' },
  headerAvatarText: { color: '#fff', fontWeight: '800', fontSize: 16 },
  headerName: { color: '#fff', fontWeight: '700', fontSize: 16 },
  headerSub: { color: '#aaa', fontSize: 12 },

  // Chat list
  chatList: { flexGrow: 1, padding: 12, gap: 10 },
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80, gap: 10 },
  emptyText: { fontSize: 16, color: '#888', fontWeight: '600' },
  emptySubText: { fontSize: 13, color: '#bbb' },

  // Bubbles
  bubbleRow: { flexDirection: 'row', alignItems: 'flex-end', marginBottom: 8, gap: 6 },
  bubbleRowRight: { justifyContent: 'flex-end' },
  bubbleRowLeft: { justifyContent: 'flex-start' },
  aiAvatar: { width: 30, height: 30, borderRadius: 15, backgroundColor: PINK, justifyContent: 'center', alignItems: 'center', marginBottom: 2 },
  aiAvatarText: { color: '#fff', fontWeight: '800', fontSize: 12 },
  bubble: { maxWidth: '78%', borderRadius: 18, overflow: 'hidden' },
  bubbleUser: { backgroundColor: BUBBLE_USER_BG, borderBottomRightRadius: 4, padding: 10 },
  bubbleAI: { backgroundColor: BUBBLE_AI_BG, borderBottomLeftRadius: 4, padding: 12 },
  bubbleImage: { width: 200, height: 200, borderRadius: 12, marginBottom: 2 },
  bubbleText: { fontSize: 15, lineHeight: 22 },
  bubbleTextUser: { color: '#fff' },
  bubbleTextAI: { color: '#111' },
  loadingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  loadingText: { color: '#888', fontSize: 13 },

  // Staging preview
  stagingContainer: { backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: '#eee', padding: 12, gap: 8 },
  stagingPreview: { position: 'relative', alignSelf: 'flex-start' },
  stagingImage: { width: 100, height: 100, borderRadius: 12 },
  stagingRemove: { position: 'absolute', top: -6, right: -6, backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 11 },
  videoBadge: { position: 'absolute', bottom: 6, left: 6, flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 6, paddingVertical: 3, borderRadius: 8 },
  videoBadgeText: { color: '#fff', fontSize: 11, fontWeight: '600' },
  captionInput: { borderWidth: 1, borderColor: '#e0e0e0', borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10, fontSize: 14, color: '#111', backgroundColor: '#f9f9f9', maxHeight: 80 },

  // Toolbar
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#fff', paddingHorizontal: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: '#eee' },
  mediaBtn: { padding: 8 },
  sendBtn: { marginLeft: 'auto' as any, backgroundColor: PINK, width: 44, height: 44, borderRadius: 22, justifyContent: 'center', alignItems: 'center' },
  sendBtnDisabled: { opacity: 0.5 },
  hintContainer: { flex: 1, alignItems: 'center' },
  hintText: { color: '#bbb', fontSize: 13 },
});
