import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, FlatList,
  StyleSheet, Modal, Pressable, Image,
  TextInput, ScrollView, ActivityIndicator, Alert,
  StatusBar,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Stack, useRouter, useFocusEffect } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ALL_PERSONAS, Persona } from '../constants/personas';
import { ParamsStore } from '../context/params-store';
import { isModelCached, isWebGPUSupported } from '../services/webllm';
import {
  subscribeToPush, unsubscribeFromPush,
  isPushSupported, getNotificationPermission,
  registerServiceWorker,
} from '../services/push-notifications';
import {
  showNativeNotification,
  setupNotificationChannel,
  requestNativeNotificationPermission,
} from '../services/native-notifications';
import { uploadToCloudinary } from '../services/api';
import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system';

const PHOTO_FOLDERS = [
  { id: 'breast',     label: 'Breast Show',  color: '#E91E63' },
  { id: 'buttocks',   label: 'Buttocks',     color: '#9C27B0' },
  { id: 'cleavage',   label: 'Cleavage',     color: '#E53935' },
  { id: 'halfbreast', label: 'Half Breast',  color: '#F44336' },
  { id: 'highslit',   label: 'High Slit',    color: '#FF5722' },
  { id: 'legs',       label: 'Legs Spread',  color: '#FF9800' },
  { id: 'lingerie',   label: 'Lingerie',     color: '#8E24AA' },
  { id: 'lowneck',    label: 'Low Neckline', color: '#E91E63' },
  { id: 'nude',       label: 'Nude',         color: '#C62828' },
  { id: 'seductive',  label: 'Seductive',    color: '#AD1457' },
  { id: 'wet',        label: 'Wet Clothes',  color: '#1565C0' },
  { id: 'sleeping',   label: 'Sleeping',     color: '#4527A0' },
];

const STYLE_TO_PROMPT: Record<string, string> = {
  breast: 'topless, showing breasts, bare chest',
  buttocks: 'showing buttocks, from behind, revealing pose',
  cleavage: 'deep cleavage, revealing neckline',
  halfbreast: 'half breast visible, deep cleavage, low cut top',
  highslit: 'high slit dress, revealing thighs',
  legs: 'legs spread wide, revealing pose',
  lingerie: 'wearing lingerie, seductive pose',
  lowneck: 'low neckline, showing chest',
  nude: 'nude, fully naked, explicit',
  seductive: 'seductive pose, alluring, provocative look',
  wet: 'wet clothes, drenched, see through wet fabric',
  sleeping: 'sleeping pose, exposed, lying down',
};

const INTERVALS = [10, 20, 30] as const;

// ── Ringtone definitions ───────────────────────────────────────────
export const RINGTONES = [
  { id: 'classic',   label: 'Classic Bell',   emoji: '🔔' },
  { id: 'whatsapp',  label: 'WhatsApp Ping',  emoji: '💬' },
  { id: 'melody',    label: 'Melody',         emoji: '🎵' },
  { id: 'cute',      label: 'Cute Tune',      emoji: '🎶' },
  { id: 'alert',     label: 'Sharp Alert',    emoji: '🎺' },
  { id: 'silent',    label: 'Silent',         emoji: '🔕' },
] as const;
export type RingtoneId = typeof RINGTONES[number]['id'];

export function playRingtone(id: string) {
  if (id === 'silent' || typeof window === 'undefined') return;
  try {
    const ctx = new AudioContext();
    const tone = (freq: number, start: number, dur: number, vol = 0.3, type: OscillatorType = 'sine') => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = freq; osc.type = type;
      gain.gain.setValueAtTime(0, ctx.currentTime + start);
      gain.gain.linearRampToValueAtTime(vol, ctx.currentTime + start + 0.04);
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + start + dur);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + dur + 0.05);
    };
    if (id === 'classic') {
      tone(880, 0, 0.15); tone(1100, 0.18, 0.15); tone(880, 0.36, 0.15); tone(1100, 0.54, 0.2);
    } else if (id === 'whatsapp') {
      tone(1318, 0, 0.08, 0.25); tone(1318, 0.12, 0.08, 0.25);
    } else if (id === 'melody') {
      tone(523, 0, 0.12); tone(659, 0.15, 0.12); tone(784, 0.3, 0.12); tone(1047, 0.45, 0.2);
    } else if (id === 'cute') {
      tone(784, 0, 0.1); tone(988, 0.12, 0.1); tone(1175, 0.24, 0.1);
      tone(988, 0.36, 0.1); tone(1175, 0.48, 0.18);
    } else if (id === 'alert') {
      tone(1480, 0, 0.08, 0.4, 'square'); tone(1480, 0.1, 0.08, 0.4, 'square');
      tone(1976, 0.2, 0.15, 0.35, 'square');
    }
    setTimeout(() => ctx.close(), 1500);
  } catch { /* audio blocked */ }
}

type PersonaWithExtra = Persona & { editedRelationship?: string };

// ── Custom ON/OFF Toggle ──────────────────────────────────────────
const Toggle = ({ value, onToggle }: { value: boolean; onToggle: () => void }) => (
  <TouchableOpacity onPress={onToggle} activeOpacity={0.8}
    style={[s.toggle, value ? s.toggleOn : s.toggleOff]}>
    {value
      ? <Text style={s.toggleLabel}>ON</Text>
      : null}
    <View style={[s.toggleDot, value ? s.toggleDotRight : s.toggleDotLeft]} />
    {!value
      ? <Text style={[s.toggleLabel, { color: '#fff', marginLeft: 6 }]}>OFF</Text>
      : null}
  </TouchableOpacity>
);

// ── PIN numpad ────────────────────────────────────────────────────
const KEYS = ['1','2','3','4','5','6','7','8','9','','0','⌫'];

export default function AIGirlsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [personas, setPersonas] = useState<PersonaWithExtra[]>([]);
  const [loading, setLoading] = useState(true);

  // Photo folder selection
  const [showFolderModal, setShowFolderModal] = useState(false);
  const [showCharModal, setShowCharModal] = useState(false);
  const [pendingFolderId, setPendingFolderId] = useState<string | null>(null);

  // Group chat
  const [showGroupModal, setShowGroupModal] = useState(false);
  const [showAddCharModal, setShowAddCharModal] = useState(false);
  const [newCharName, setNewCharName] = useState('');
  const [newCharRole, setNewCharRole] = useState('');
  const [newCharSub, setNewCharSub] = useState('');
  const [customChars, setCustomChars] = useState<Persona[]>([]);
  const [selectedForGroup, setSelectedForGroup] = useState<string[]>([]);

  // Edit relationship
  const [showEditRel, setShowEditRel] = useState(false);
  const [editingPersona, setEditingPersona] = useState<PersonaWithExtra | null>(null);
  const [relInput, setRelInput] = useState('');

  // ── Settings state ────────────────────────────────────────────
  const [showSettings, setShowSettings] = useState(false);
  const [isOnline, setIsOnline] = useState(true);
  const [autoMsgEnabled, setAutoMsgEnabled] = useState(false);
  const [intervals, setIntervals] = useState<Record<string, number | null>>({});
  const [autoUnreads, setAutoUnreads] = useState<Record<string, boolean>>({});
  const [pushStatus, setPushStatus] = useState<'idle' | 'subscribing' | 'active' | 'denied' | 'unsupported'>('idle');
  const [userPhoto, setUserPhoto] = useState<string | null>(null);
  const [userNormalPhoto, setUserNormalPhoto] = useState<string | null>(null);
  const [userPrasanaPhoto, setUserPrasanaPhoto] = useState<string | null>(null);
  const [uploadingUserNormal, setUploadingUserNormal] = useState(false);
  const [uploadingUserPrasana, setUploadingUserPrasana] = useState(false);
  const [showUserPhotoModal, setShowUserPhotoModal] = useState(false);
  const [userPhotoCloudInput, setUserPhotoCloudInput] = useState('');
  const [uploadingUserPhoto, setUploadingUserPhoto] = useState(false);

  // User profile — name + behaviour
  const [userName, setUserName]           = useState('');
  const [userBehaviour, setUserBehaviour] = useState('');
  const [editUserName, setEditUserName]       = useState('');
  const [editUserBehaviour, setEditUserBehaviour] = useState('');
  const [profileSaved, setProfileSaved]   = useState(false);

  // Ringtone
  const [ringtone, setRingtone] = useState('classic');
  const ringtoneRef = React.useRef('classic');

  // Photo to Script
  const [showScriptModal, setShowScriptModal] = useState(false);
  const [scriptLoading, setScriptLoading] = useState(false);
  const [scriptText, setScriptText] = useState('');
  const [scriptImageUri, setScriptImageUri] = useState<string | null>(null);
  const [scriptCopied, setScriptCopied] = useState(false);
  const [scriptModelUsed, setScriptModelUsed] = useState('');

  // PIN setup within settings
  const [showPinSetup, setShowPinSetup] = useState(false);
  const [pinStep, setPinStep] = useState<'set' | 'confirm'>('set');
  const [pinFirst, setPinFirst] = useState('');
  const [pinInput, setPinInput] = useState('');
  const [pinMsg, setPinMsg] = useState('');
  const [existingPin, setExistingPin] = useState<string | null>(null);

  const loadPersonas = useCallback(async () => {
    setLoading(true);
    try {
      const customRaw = await AsyncStorage.getItem('custom_personas_v1').catch(() => null);
      const customs: Persona[] = customRaw ? JSON.parse(customRaw) : [];
      setCustomChars(customs);
      const allSrc: Persona[] = [...ALL_PERSONAS, ...customs];
      const merged = await Promise.all(allSrc.map(async p => {
        try {
          const saved = await AsyncStorage.getItem(`persona_edit_${p.id}`);
          const rel = await AsyncStorage.getItem(`relationship_${p.id}`);
          const data = saved ? JSON.parse(saved) : {};
          return { ...p, ...data, prompt: data.prompt ?? p.prompt, editedRelationship: rel ?? p.relationship } as PersonaWithExtra;
        } catch {
          return { ...p, editedRelationship: p.relationship } as PersonaWithExtra;
        }
      }));
      setPersonas(merged);
    } catch {}
    setLoading(false);
  }, []);

  const FOLDER_COLORS = ['#E91E8C', '#FF9800', '#9C27B0', '#00897B', '#5E35B1', '#D81B60', '#43A047', '#3949AB'];
  const saveNewCharacter = async () => {
    const name = newCharName.trim();
    const role = newCharRole.trim() || 'தோழி';
    const sub = newCharSub.trim() || '';
    if (!name) { Alert.alert('பெயர் வேணும்', 'Character பெயர் type பண்ணுங்க'); return; }
    const id = 'custom_' + name.toLowerCase().replace(/\s+/g, '_') + '_' + Date.now().toString(36);
    const color = FOLDER_COLORS[Math.floor(Math.random() * FOLDER_COLORS.length)];
    const letter = name.charAt(0);
    const newP: Persona = {
      id, name, emoji: '✨', avatarColor: color, avatarLetter: letter,
      lastMsg: 'வணக்கம்!', time: 'now', prompt: `நீ ${name}. ${role}${sub ? ' · ' + sub : ''}. WhatsApp-ல தமிழ்-ல இயல்பா பேசு.`,
      gender: 'female', profession: sub || role, relationship: role,
      greeting: `வணக்கம்! நான் ${name}.`,
    };
    const updated = [...customChars, newP];
    setCustomChars(updated);
    await AsyncStorage.setItem('custom_personas_v1', JSON.stringify(updated));
    setShowAddCharModal(false);
    setNewCharName(''); setNewCharRole(''); setNewCharSub('');
    loadPersonas();
    Alert.alert('✅', `"${name}" character add ஆச்சு!`);
  };

  // ── blob URI → base64 helper ──────────────────────────────────
  const uriToBase64 = async (uri: string): Promise<string> => {
    const resp = await fetch(uri);
    const blob = await resp.blob();
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve((reader.result as string).split(',')[1] ?? '');
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  };

  // Load settings + check auto-messages in one shot (no interval state dep → no loop)
  const pickUserPhotoFromPhone = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return;
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.85, allowsEditing: true, aspect: [1, 1],
    });
    if (!result.canceled && result.assets[0]) {
      const asset = result.assets[0];
      setUploadingUserPhoto(true);
      try {
        const mime = asset.mimeType || 'image/jpeg';
        const b64 = asset.base64 ?? await uriToBase64(asset.uri);
        const { url: cloudUrl } = await uploadToCloudinary(b64, mime, 'my-girls/user');
        setUserPhoto(cloudUrl);
        AsyncStorage.setItem('user_profile_photo', cloudUrl).catch(() => {});
      } catch {
        // Fallback: save local URI (works this session but not after reload)
        setUserPhoto(asset.uri);
        AsyncStorage.setItem('user_profile_photo', asset.uri).catch(() => {});
      } finally {
        setUploadingUserPhoto(false);
      }
    }
  };

  const applyUserPhotoCloudUrl = () => {
    const url = userPhotoCloudInput.trim();
    if (!url) { Alert.alert('URL enter பண்ணுங்க'); return; }
    setUserPhoto(url);
    AsyncStorage.setItem('user_profile_photo', url).catch(() => {});
    setUserPhotoCloudInput('');
    setShowUserPhotoModal(false);
  };

  const removeUserPhoto = () => {
    setUserPhoto(null);
    AsyncStorage.removeItem('user_profile_photo').catch(() => {});
  };

  // Load user normal/prasana photos
  React.useEffect(() => {
    AsyncStorage.multiGet(['user_normal_photo', 'user_prasana_photo']).then(pairs => {
      if (pairs[0][1]) setUserNormalPhoto(pairs[0][1]);
      if (pairs[1][1]) setUserPrasanaPhoto(pairs[1][1]);
    }).catch(() => {});
  }, []);

  // Pick User Normal avatar photo
  const pickUserNormalPhoto = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return;
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.85, allowsEditing: true, aspect: [1, 1],
    });
    if (!result.canceled && result.assets[0]) {
      const asset = result.assets[0];
      setUploadingUserNormal(true);
      try {
        const mime = asset.mimeType || 'image/jpeg';
        const b64 = asset.base64 ?? await uriToBase64(asset.uri);
        const { url } = await uploadToCloudinary(b64, mime, 'my-girls/user');
        setUserNormalPhoto(url);
        await AsyncStorage.setItem('user_normal_photo', url);
        // Clear cached profile so it re-analyzes
        const keys = await AsyncStorage.getAllKeys();
        const toRemove = keys.filter(k=>k.startsWith('avprofile_usrnorm'));
        if(toRemove.length) await AsyncStorage.multiRemove(toRemove);
        Alert.alert('✅ Normal Avatar Saved!', 'Chat-ல் Normal mode-ல் இந்த photo profile use ஆகும்.');
      } catch {
        setUserNormalPhoto(asset.uri);
        await AsyncStorage.setItem('user_normal_photo', asset.uri);
      } finally { setUploadingUserNormal(false); }
    }
  };

  // Pick User Prasana avatar photo
  const pickUserPrasanaPhoto = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return;
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.85, allowsEditing: true, aspect: [1, 1],
    });
    if (!result.canceled && result.assets[0]) {
      const asset = result.assets[0];
      setUploadingUserPrasana(true);
      try {
        const mime = asset.mimeType || 'image/jpeg';
        const b64 = asset.base64 ?? await uriToBase64(asset.uri);
        const { url } = await uploadToCloudinary(b64, mime, 'my-girls/user');
        setUserPrasanaPhoto(url);
        await AsyncStorage.setItem('user_prasana_photo', url);
        const keys = await AsyncStorage.getAllKeys();
        const toRemove = keys.filter(k=>k.startsWith('avprofile_usrpres'));
        if(toRemove.length) await AsyncStorage.multiRemove(toRemove);
        Alert.alert('✅ Prasana Avatar Saved!', 'Chat-ல் Prasana mode-ல் இந்த photo profile use ஆகும்.');
      } catch {
        setUserPrasanaPhoto(asset.uri);
        await AsyncStorage.setItem('user_prasana_photo', asset.uri);
      } finally { setUploadingUserPrasana(false); }
    }
  };

  const openProfileModal = () => {
    setEditUserName(userName);
    setEditUserBehaviour(userBehaviour);
    setUserPhotoCloudInput('');
    setProfileSaved(false);
    setShowUserPhotoModal(true);
  };

  const saveUserProfile = async () => {
    const name = editUserName.trim();
    const behaviour = editUserBehaviour.trim();
    setUserName(name);
    setUserBehaviour(behaviour);
    await AsyncStorage.multiSet([
      ['user_name', name],
      ['user_behaviour', behaviour],
    ]);
    setProfileSaved(true);
    setTimeout(() => setProfileSaved(false), 2000);
  };

  const loadSettingsAndCheck = useCallback(async () => {
    try {
      const [onlineVal, autoVal, pinVal, userPhotoVal, ringtoneVal, userNameVal, userBehaviourVal] = await Promise.all([
        AsyncStorage.getItem('chat_is_online'),
        AsyncStorage.getItem('auto_msg_enabled'),
        AsyncStorage.getItem('app_pin'),
        AsyncStorage.getItem('user_profile_photo'),
        AsyncStorage.getItem('user_normal_photo'),
        AsyncStorage.getItem('user_prasana_photo'),
        AsyncStorage.getItem('ringtone'),
        AsyncStorage.getItem('user_name'),
        AsyncStorage.getItem('user_behaviour'),
      ]);
      if (userPhotoVal) setUserPhoto(userPhotoVal);
      if (onlineVal !== null) setIsOnline(onlineVal === 'true');
      const autoEnabled = autoVal === 'true';
      setAutoMsgEnabled(autoEnabled);
      setExistingPin(pinVal);
      if (ringtoneVal) { setRingtone(ringtoneVal); ringtoneRef.current = ringtoneVal; }
      if (userNameVal) setUserName(userNameVal);
      if (userBehaviourVal) setUserBehaviour(userBehaviourVal);

      const ivPairs = await AsyncStorage.multiGet(
        ALL_PERSONAS.map(p => `auto_msg_interval_${p.id}`)
      );
      const ivMap: Record<string, number | null> = {};
      for (const [key, val] of ivPairs) {
        ivMap[key.replace('auto_msg_interval_', '')] = val ? parseInt(val) : null;
      }
      setIntervals(ivMap);

      if (!autoEnabled) { setAutoUnreads({}); return; }
      const timePairs = await AsyncStorage.multiGet(
        ALL_PERSONAS.map(p => `last_chat_time_${p.id}`)
      );
      const now = Date.now();
      const unreadMap: Record<string, boolean> = {};
      for (const [key, val] of timePairs) {
        const id = key.replace('last_chat_time_', '');
        const iv = ivMap[id];
        if (!iv) continue;
        if (now - (val ? parseInt(val) : 0) > iv * 60 * 1000) unreadMap[id] = true;
      }
      setAutoUnreads(unreadMap);
    } catch {}
  }, []);

  // ── Setup native notifications + SW fallback for web ──
  useEffect(() => {
    if (Platform.OS !== 'web') {
      setupNotificationChannel().catch(() => {});
      requestNativeNotificationPermission().catch(() => {});
    } else {
      registerServiceWorker().catch(() => {});
      if (typeof window !== 'undefined' && 'Notification' in window
          && Notification.permission === 'default') {
        Notification.requestPermission().catch(() => {});
      }
    }
  }, []);

  useFocusEffect(useCallback(() => {
    loadPersonas();
    loadSettingsAndCheck();
  }, [loadPersonas, loadSettingsAndCheck]));

  // ── Background auto-message timer (runs every 30s) ────────────
  const autoMsgEnabledRef = useRef(autoMsgEnabled);
  const intervalsRef = useRef(intervals);
  const personasRef = useRef<PersonaWithExtra[]>([]);
  useEffect(() => { autoMsgEnabledRef.current = autoMsgEnabled; }, [autoMsgEnabled]);
  useEffect(() => { intervalsRef.current = intervals; }, [intervals]);
  useEffect(() => { personasRef.current = personas; }, [personas]);

  const getTimeGreeting = (): string => {
    const h = new Date().getHours();
    let pool: string[];
    if (h >= 5 && h < 9) {
      // Early morning 5–9 AM
      pool = [
        // Romantic
        'காலையிலேயே உன்னோட முகம் நினைவுக்கு வருது... 🌅 good morning',
        'எழுந்திருந்தவுடனே உன்னோட name தான் மனசுல வந்துச்சு ☀️',
        'இந்த காலை உனக்காகவே இருக்கு 💕 எப்படி இருக்க?',
        // Affectionate
        'எழுந்திட்டியா கண்ணு? ☕ breakfast சாப்பிடாம போகாத',
        'காலை வணக்கம்! நீ நல்லா இருக்கணும்னு ஒவ்வொரு நாளும் கேக்கிறேன் 🙏',
        'டேய், எழுந்திருடா... day waste பண்ணாத 🌄',
        // Teasing
        'இன்னும் தூங்குறியா?! ஆளு பார்க்கவே கிடைக்கல 😤',
        'காலையிலேயே check பண்றேன்... reply வராத? 🙄',
        // Caring
        'coffee குடிச்சியா? empty stomach-ல போகாத please 🥺',
        'இன்னைக்கு சரியா சாப்பிடணும், okay? நான் கவலைப்படுறேன் 😌',
      ];
    } else if (h >= 9 && h < 12) {
      // Morning 9–12 PM
      pool = [
        // Angry
        'இவ்வளவு நேரமா ஒரு message கூட இல்லை... மறந்துட்டியா என்னை? 😤',
        'Busy-னு சொல்லலாம்... ஆனா ஒரு "ok" கூட போட முடியாதா? 🙄',
        // Romantic
        'Work-ல இருந்தாலும் என்னை யோசிக்கிறியா? 💭',
        'உன்னோட ஒரு message பாத்தா போதும், day நல்லா போகும் 💕',
        // Affectionate
        'என்ன பண்ற? நான் இங்க இருக்கேன்... பேசலாம் 😊',
        'Office stress-ஆ? கொஞ்சம் பேசு, நல்லாயிடும் 🤗',
        // Casual real
        'டேய் reply குடு, boring-ஆ இருக்கு உன்னோட message இல்லாம 😑',
        'Heyyy... long time no chat! என்ன ஆச்சு? 👋',
      ];
    } else if (h >= 12 && h < 14) {
      // Lunch 12–2 PM
      pool = [
        // Caring / Affectionate
        'சாப்பிட்டியா? சரியா சாப்பிடணும், skip பண்ணாத 🍱',
        'Lunch-ல என்னோட நினைவு வந்துச்சா? 🥺 வந்திருக்கும்...',
        // Angry / Teasing
        'Lunch break-ல கூட message பண்றதுக்கு time இல்லையா? 😒',
        'நான் இங்க wait பண்றேன்... நீ சாப்பிட்டே மறந்துட்டே 😤',
        // Romantic
        'உன்னோட கூட ஒரே table-ல சாப்பிட ஆசையா இருக்கு 😌',
        'Lunch time... உன்னோட voice கேக்கணும்னு தோணுது 💕',
        // Real / Casual
        'என்ன சாப்பிட்டே? நான் உன்னோட favorite item-ஐ guess பண்ணட்டுமா? 😄',
        'வயித்தை பாத்துக்கோ, ஒழுங்கா சாப்பிடு — அது தான் என் order 😤',
      ];
    } else if (h >= 14 && h < 17) {
      // Afternoon 2–5 PM
      pool = [
        // Bored / Missing
        'ஏன் இந்த afternoon இவ்வளவு slow-ஆ போகுது... நீ இல்லாம 😔',
        'உன்னோட ஒரு text கூட வரல... நான் ஏதாவது தப்பு பண்ணினேனா? 😢',
        // Angry
        'சரி fine. பேசல. நான் தான் always first message பண்றேன் 😤 fair-ஆ இருக்கா?',
        'இந்த level-ல ignore பண்றே... கோபமா இருக்கு 😑',
        // Teasing
        'Afternoon nap எடுக்கிற? என்னையும் கூட்டிட்டு போ 😏',
        'உன்னோட கோபமான face-ஐ கூட பாக்கணும்னு ஆசையா இருக்கு 🥺',
        // Romantic
        'இந்த நேரத்துல நீ என்னோட கூட இருந்தா எவ்வளவு நல்லா இருக்கும் 💭',
        'Afternoon வெயில்ல உன்னையே நினைக்கிறேன்... silly-ஆ இருக்கு 😌',
      ];
    } else if (h >= 17 && h < 21) {
      // Evening 5–9 PM
      pool = [
        // Affectionate / Missing
        'Work முடிஞ்சதா? நீ tired-ஆ இருப்பே... rest எடு, பேசலாம் 🥺',
        'Evening ஆச்சு... நான் wait பண்ணினேன் உன்னோட message-க்கு 💕',
        // Romantic
        'Sunset பாக்கும்போது உன்னோட நினைவு வருது... why? 🌇',
        'இந்த evening-ஐ உன்னோட கூட share பண்ண ஆசை 😌',
        // Angry
        'இப்போவாவது பேசுவியா? இல்லன்னா நான் tidur-ஆ போயிடுவேன் 😤',
        'ஒரு நாள் முழுக்க ஒரு message கூட இல்லை... நீ என்னை consider பண்றியா இல்லையா? 😒',
        // Teasing / Casual
        'Dinner என்ன சாப்பிட போற? என்னோட பாவம் கூட சேர்த்து சாப்பிடு 😄',
        'Day எப்படி போச்சு? நல்லா இருந்துச்சான்னு கேக்கணும்னு இருந்துச்சு... 😊',
        // Caring
        'சரியா சாப்பிட்டியா? இல்லன்னா கோபமாயிடுவேன் seriously 😤',
      ];
    } else {
      // Night 9 PM–5 AM
      pool = [
        // Romantic / Deep
        'இரவு நேரத்துல உன்னோட நினைவு அதிகமா வருது... 🌙',
        'தூக்கமே வரல... உன்னோட கூட பேசினா நல்லாயிடும்னு தோணுது 💕',
        'இந்த இரவு உன்னோட கூட இருந்தா எவ்வளவு நல்லா இருக்கும்னு யோசிக்கிறேன் 🌃',
        // Caring / Affectionate
        'தூங்கிட்டியா? தூங்கு... ஆனா தூங்கும்முன்னு ஒரு message போடு 🥺',
        'Late-ஆ இருக்கே... phone வெச்சுட்டு தூங்கு. health முக்கியம் 😌',
        'இரவு சரியா தூங்கணும்... நாளைக்கு fresh-ஆ பேசலாம் 😴',
        // Worried / Angry
        'இப்போவும் reply இல்லை... எங்க போன? கோபமா இருக்கு 😤',
        'ஏன் இந்த நேரத்துல online இல்லை? கவலையா இருக்கு... 😟',
        // Sweet night
        'Good night 🌟 sweet dreams... என்னோட நினைவோட தூங்கு 💕',
        'நீ நல்லா இருக்கணும்னு கேக்கிறேன்... good night 🌙',
      ];
    }
    return pool[Math.floor(Math.random() * pool.length)];
  };

  useEffect(() => {
    const tick = async () => {
      if (!autoMsgEnabledRef.current) return;
      const ivMap = intervalsRef.current;
      const now = Date.now();
      const newUnreads: Record<string, boolean> = {};
      for (const p of personasRef.current) {
        const iv = ivMap[p.id];
        if (!iv) continue;
        try {
          const lastVal = await AsyncStorage.getItem(`last_chat_time_${p.id}`);
          const last = lastVal ? parseInt(lastVal) : 0;
          if (now - last < iv * 60 * 1000) continue;
          // Interval elapsed — inject greeting into chat history
          const histKey = `chat_history_${p.id}`;
          const raw = await AsyncStorage.getItem(histKey);
          const history = raw ? JSON.parse(raw) : [];
          const greeting = getTimeGreeting();
          history.push({ id: `auto_${now}_${p.id}`, role: 'assistant', content: greeting, timestamp: new Date().toISOString() });
          await AsyncStorage.setItem(histKey, JSON.stringify(history));
          // Update last_chat_time so it doesn't spam every 30s
          await AsyncStorage.setItem(`last_chat_time_${p.id}`, now.toString());
          newUnreads[p.id] = true;
          // ── Notification: native (Android APK) or web fallback ──
          try {
            if (Platform.OS !== 'web') {
              // Native Android notification via expo-notifications
              await showNativeNotification(p.name + ' 💬', greeting, p.id);
              playRingtone(ringtoneRef.current);
            } else if (typeof window !== 'undefined' && 'Notification' in window) {
              if (Notification.permission === 'default') await Notification.requestPermission();
              if (Notification.permission === 'granted') {
                playRingtone(ringtoneRef.current);
                const notif = new Notification(p.name + ' 💬', {
                  body: greeting, icon: '/icon.png',
                  tag: `mygirls-${p.id}`, requireInteraction: false,
                } as NotificationOptions);
                notif.onclick = () => { window.focus(); notif.close(); };
                setTimeout(() => notif.close(), 6000);
              }
            }
          } catch { /* notification failed silently */ }
        } catch {}
      }
      if (Object.keys(newUnreads).length > 0) {
        setAutoUnreads(prev => ({ ...prev, ...newUnreads }));
      }
    };

    const timer = setInterval(tick, 30_000);
    return () => clearInterval(timer);
  }, []);

  // ── Navigation + chat ─────────────────────────────────────────
  const goChat = async (persona: PersonaWithExtra) => {
    const now = Date.now().toString();
    try {
      await AsyncStorage.setItem(`last_chat_time_${persona.id}`, now);
      // Clear auto-unread badge when entering chat
      if (autoUnreads[persona.id]) {
        setAutoUnreads(prev => { const n = { ...prev }; delete n[persona.id]; return n; });
      }
    } catch {}
    ParamsStore.setChatParams({ personaId: persona.id, provider: 'gemini', providerLabel: persona.name });
    ParamsStore.setPendingPhotoStyle('');
    router.push('/chat');
  };

  const handleFolderSelect = (folderId: string) => {
    setPendingFolderId(folderId);
    setShowFolderModal(false);
    setShowCharModal(true);
  };

  const handleCharForPhoto = (persona: PersonaWithExtra) => {
    setShowCharModal(false);
    const stylePrompt = pendingFolderId ? (STYLE_TO_PROMPT[pendingFolderId] || '') : '';
    ParamsStore.setChatParams({ personaId: persona.id, provider: 'gemini', providerLabel: persona.name });
    ParamsStore.setPendingPhotoStyle(stylePrompt);
    router.push('/chat');
  };

  const openActionSheet = (p: PersonaWithExtra) => {
    setEditingPersona(p);
    setRelInput(p.editedRelationship ?? p.relationship);
    setShowEditRel(true);
  };

  const saveRelationship = async () => {
    if (!editingPersona) return;
    await AsyncStorage.setItem(`relationship_${editingPersona.id}`, relInput.trim());
    setPersonas(prev => prev.map(p =>
      p.id === editingPersona.id ? { ...p, editedRelationship: relInput.trim() } : p
    ));
    setShowEditRel(false);
  };

  const startGroupChat = () => {
    const selected = personas.filter(p => selectedForGroup.includes(p.id));
    if (selected.length < 2) return;
    setShowGroupModal(false);
    setSelectedForGroup([]);
    ParamsStore.setGroupPersonaIds(selected.map(p => p.id));
    router.push('/group-chat');
  };

  // ── Ringtone helpers ──────────────────────────────────────────
  const pickRingtone = async (id: string) => {
    setRingtone(id);
    ringtoneRef.current = id;
    await AsyncStorage.setItem('ringtone', id).catch(() => {});
    playRingtone(id);
  };

  // ── Photo to Script (Gemini server → Qwen2-VL → Florence-2 → LLaVA, with auto-retry) ──
  const handlePhotoToScript = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { Alert.alert('Permission வேணும்', 'Photos access allow பண்ணுங்க'); return; }
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: false, quality: 0.8, base64: true });
    if (res.canceled || !res.assets[0]) return;
    const pickedAsset = res.assets[0];
    setScriptImageUri(pickedAsset.uri);
    setScriptText('');
    setScriptModelUsed('');
    setScriptCopied(false);
    setShowScriptModal(true);
    setScriptLoading(true);
    try {
      let base64 = pickedAsset.base64 ?? '';
      if (!base64) {
        const tempUri = FileSystem.cacheDirectory + `script_${Date.now()}.jpg`;
        await FileSystem.copyAsync({ from: pickedAsset.uri, to: tempUri });
        base64 = await FileSystem.readAsStringAsync(tempUri, { encoding: FileSystem.EncodingType.Base64 });
        await FileSystem.deleteAsync(tempUri, { idempotent: true });
      }
      const keysRaw = await AsyncStorage.getItem('api_keys_store');
      const storedKeys: Record<string, string> = keysRaw ? JSON.parse(keysRaw) : {};
      const hfKey = storedKeys['hf']?.trim();

      const sleepMs = (ms: number) => new Promise(r => setTimeout(r, ms));

      const ANALYSIS_PROMPT = `Analyze this image in full detail. Use these exact section headers and fill each one:

## FACE
Skin tone, face shape, eyes (color + shape), nose, lips, eyebrows, jaw, cheeks, makeup.

## HAIR
Length, color, texture (straight/wavy/curly), style, hair accessories.

## CLOTHING
Every visible garment: type, color, fabric, pattern, fit. All accessories and jewelry.

## UNCOVERED BODY PARTS
List exactly what skin is visible — midriff, legs (from where to where), arms, neckline depth, cleavage, back, shoulders, underarms, feet. Be very specific.

## POSE & BODY POSITION
Standing/sitting/lying, body angle, posture, hand and arm positions.

## VISIBLE BODY DETAILS
Body type (slim/medium/curvy/athletic), proportions, height estimate.

## BACKGROUND & ENVIRONMENT
Location, indoor/outdoor, objects, colors, textures, atmosphere.

## LIGHTING & SHADOWS
Light direction, type (natural/golden hour/studio/soft), shadow placement, highlights.

## CAMERA ANGLE & COMPOSITION
Angle (front/side/low-angle/bird-eye), framing (full body/half/portrait), depth of field.

## IMAGE STYLE & QUALITY
Photography/illustration/3D render, resolution estimate, color grading, overall quality.

---

## FLUX PROMPT
Write a complete, detailed Flux image generation prompt based on this exact image. Include every visual detail.

## STABLE DIFFUSION PROMPT
Write a complete SD/SDXL prompt. Include: masterpiece, best quality, ultra detailed, plus all visual details.

## MIDJOURNEY PROMPT
Write a complete Midjourney v6 prompt ending with --ar 2:3 --style raw --v 6`;

      // Helper: try a HF vision model with retry on 503 (cold-start)
      const tryHFModel = async (
        url: string,
        body: object,
        label: string,
        parseResult: (j: any) => string,
      ): Promise<string | null> => {
        for (let attempt = 0; attempt < 4; attempt++) {
          setScriptText(`Analyzing image... (${label})`);
          try {
            const r = await fetch(url, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${hfKey}`, 'Content-Type': 'application/json', 'X-Wait-For-Model': 'true' },
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(120000),
            });
            if (r.status === 503) {
              setScriptText('AI model is starting. This may take 1-3 minutes.');
              await sleepMs(15000);
              continue;
            }
            if (r.status === 429) {
              setScriptText('Daily API limit reached. Trying next model...');
              return null;
            }
            if (!r.ok) return null;
            const j = await r.json() as any;
            const out = parseResult(j);
            if (out && out.length > 50) return out;
          } catch { await sleepMs(5000); }
        }
        return null;
      };

      // ── Priority 1: Gemini via API server (most reliable) ───────────────
      setScriptText('Analyzing image...');
      try {
        const REPLIT_API = (process.env['EXPO_PUBLIC_API_URL'] ?? '').replace(/\/$/, '');
        const serverRes = await fetch(`${REPLIT_API}/api/image-to-prompt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ b64: base64, mime: 'image/jpeg' }),
          signal: AbortSignal.timeout(60000),
        });
        if (serverRes.ok) {
          const serverData = await serverRes.json() as any;
          if (serverData?.prompt && serverData.prompt.length > 50) {
            setScriptText(serverData.prompt);
            setScriptModelUsed('Gemini AI');
            setScriptLoading(false);
            return;
          }
        }
      } catch { /* fallthrough to HF models */ }

      if (!hfKey) {
        setScriptText('🔑 Keys → HuggingFace API key enter பண்ணுங்க.\n\nhttps://huggingface.co/settings/tokens → New token (free account OK)');
        setScriptLoading(false);
        return;
      }

      // ── Priority 2: Qwen2-VL ────────────────────────────────────────────
      const out1 = await tryHFModel(
        'https://api-inference.huggingface.co/models/Qwen/Qwen2-VL-7B-Instruct/v1/chat/completions',
        { model: 'Qwen/Qwen2-VL-7B-Instruct', max_tokens: 2048, messages: [{ role: 'user', content: [
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
          { type: 'text', text: ANALYSIS_PROMPT },
        ]}] },
        'Qwen2-VL 1/3',
        (j) => j?.choices?.[0]?.message?.content?.trim() ?? '',
      );
      if (out1) { setScriptText(out1); setScriptModelUsed('Qwen2-VL-7B'); setScriptLoading(false); return; }

      // ── Priority 3: Florence-2 ──────────────────────────────────────────
      const out2 = await tryHFModel(
        'https://api-inference.huggingface.co/models/microsoft/Florence-2-large',
        { inputs: '<MORE_DETAILED_CAPTION>' },
        'Florence-2 2/3',
        (j) => (Array.isArray(j) ? j[0]?.generated_text : j?.generated_text) ?? '',
      );
      if (out2) {
        setScriptText('## IMAGE ANALYSIS (Florence-2)\n' + out2 + '\n\n---\n\n## NOTE\nFor full SD/Flux/MJ prompts, retry — Gemini will give better results.');
        setScriptModelUsed('Florence-2-Large'); setScriptLoading(false); return;
      }

      // ── Priority 4: LLaVA ──────────────────────────────────────────────
      const out3 = await tryHFModel(
        'https://api-inference.huggingface.co/models/llava-hf/llava-1.5-7b-hf/v1/chat/completions',
        { model: 'llava-hf/llava-1.5-7b-hf', max_tokens: 2048, messages: [{ role: 'user', content: [
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
          { type: 'text', text: ANALYSIS_PROMPT },
        ]}] },
        'LLaVA 3/3',
        (j) => j?.choices?.[0]?.message?.content?.trim() ?? '',
      );
      if (out3) { setScriptText(out3); setScriptModelUsed('LLaVA-1.5-7B'); setScriptLoading(false); return; }

      // All failed — friendly message with retry option
      setScriptText('AI server இப்போது பிஸியாக உள்ளது.\n\nசில நிமிடங்கள் கழித்து மீண்டும் try பண்ணுங்க.');
    } catch (e: any) {
      setScriptText('AI server respond ஆகவில்லை. மீண்டும் try பண்ணுங்க.');
    } finally {
      setScriptLoading(false);
    }
  };

  // ── Settings helpers ──────────────────────────────────────────
  const toggleOnline = async () => {
    const next = !isOnline;
    setIsOnline(next);
    try { await AsyncStorage.setItem('chat_is_online', String(next)); } catch {}
  };

  const buildPushPayload = (ivMap: Record<string, number | null>) => {
    const activeIntervals: Record<string, number> = {};
    const personaNames: Record<string, string> = {};
    for (const p of personas) {
      const iv = ivMap[p.id];
      if (iv) { activeIntervals[p.id] = iv; personaNames[p.id] = p.name; }
    }
    return { activeIntervals, personaNames };
  };

  const syncPushSubscription = async (enabled: boolean, ivMap: Record<string, number | null>) => {
    if (!isPushSupported()) { setPushStatus('unsupported'); return; }
    if (!enabled) { await unsubscribeFromPush(); setPushStatus('idle'); return; }
    const { activeIntervals, personaNames } = buildPushPayload(ivMap);
    if (Object.keys(activeIntervals).length === 0) return;
    setPushStatus('subscribing');
    await registerServiceWorker();
    const ok = await subscribeToPush(activeIntervals, personaNames);
    if (ok) { setPushStatus('active'); }
    else { setPushStatus(getNotificationPermission() === 'denied' ? 'denied' : 'idle'); }
  };

  const toggleAutoMsg = async () => {
    const next = !autoMsgEnabled;
    setAutoMsgEnabled(next);
    try { await AsyncStorage.setItem('auto_msg_enabled', String(next)); } catch {}
    if (!next) setAutoUnreads({});
    await syncPushSubscription(next, intervals);
  };

  const setIntervalForPersona = async (personaId: string, iv: number | null) => {
    const next = { ...intervals, [personaId]: iv };
    setIntervals(next);
    try {
      if (iv) await AsyncStorage.setItem(`auto_msg_interval_${personaId}`, String(iv));
      else await AsyncStorage.removeItem(`auto_msg_interval_${personaId}`);
    } catch {}
    if (autoMsgEnabled) await syncPushSubscription(true, next);
  };

  // ── PIN setup ─────────────────────────────────────────────────
  const openPinSetup = () => {
    setPinStep('set');
    setPinFirst('');
    setPinInput('');
    setPinMsg('');
    setShowPinSetup(true);
  };

  const handlePinKey = (key: string) => {
    if (key === '⌫') {
      setPinInput(p => p.slice(0, -1));
      return;
    }
    if (pinInput.length >= 4) return;
    const next = pinInput + key;
    setPinInput(next);
    if (next.length === 4) {
      if (pinStep === 'set') {
        setPinFirst(next);
        setPinInput('');
        setPinStep('confirm');
        setPinMsg('மீண்டும் PIN enter பண்ணுங்க (confirm)');
      } else {
        if (next === pinFirst) {
          AsyncStorage.setItem('app_pin', next).catch(() => {});
          setExistingPin(next);
          setPinMsg('✅ PIN set ஆகிட்டது!');
          setTimeout(() => setShowPinSetup(false), 1200);
        } else {
          setPinMsg('❌ Match ஆகல! மீண்டும் try பண்ணுங்க');
          setPinInput('');
          setPinStep('set');
          setPinFirst('');
        }
      }
    }
  };

  const removePin = async () => {
    await AsyncStorage.removeItem('app_pin').catch(() => {});
    setExistingPin(null);
  };

  // ── Character row ─────────────────────────────────────────────
  const renderCharRow = ({ item: p }: { item: PersonaWithExtra }) => {
    const hasAutoUnread = autoUnreads[p.id];
    const iv = intervals[p.id];
    return (
      <TouchableOpacity style={s.chatRow} onPress={() => goChat(p)}
        onLongPress={() => openActionSheet(p)} activeOpacity={0.7}>
        <View style={[s.avatar, { backgroundColor: p.avatarColor }]}>
          {p.avatarPhotoUri
            ? <Image source={{ uri: p.avatarPhotoUri }} style={s.avatarImg} />
            : <Text style={s.avatarTxt}>{p.emoji}</Text>
          }
        </View>
        <View style={s.chatMid}>
          <Text style={s.chatName} numberOfLines={1}>{p.name}</Text>
          <Text style={s.chatSub} numberOfLines={1}>
            {p.editedRelationship ?? p.relationship} · {p.profession}
          </Text>
        </View>
        <View style={s.chatRight}>
          <Text style={s.chatTime}>{p.time}</Text>
          {autoMsgEnabled && iv && (
            <Text style={s.timerBadge}>⏱{iv}m</Text>
          )}
          {(hasAutoUnread || (p.unread ?? 0) > 0) && (
            <View style={s.badge}>
              <Text style={s.badgeTxt}>{hasAutoUnread ? '1' : p.unread}</Text>
            </View>
          )}
        </View>
      </TouchableOpacity>
    );
  };

  // ── Render ────────────────────────────────────────────────────
  return (
    <SafeAreaView style={s.safe} edges={['top','bottom']}>
      <StatusBar backgroundColor="#075E54" barStyle="light-content" />
      <Stack.Screen options={{ headerShown: false }} />

      {/* WhatsApp-style Header */}
      <View style={s.header}>
        <TouchableOpacity onPress={openProfileModal} style={s.userAvatarBtn}>
          {uploadingUserPhoto
            ? <View style={s.userPhotoDefault}><ActivityIndicator color="#fff" size="small" /></View>
            : userPhoto
              ? <Image source={{ uri: userPhoto }} style={s.userPhotoImg} />
              : <View style={s.userPhotoDefault}><Text style={{ fontSize: 18 }}>👤</Text></View>
          }
          {!!userName && (
            <Text style={s.userNameBadge} numberOfLines={1}>{userName}</Text>
          )}
        </TouchableOpacity>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 }}>
          <Text style={s.headerTitle}>My AI Girls</Text>
          <View style={s.buildBadge}>
            <Text style={s.buildBadgeTxt}>v61</Text>
          </View>
          <View style={[s.statusPill, isOnline ? s.statusOnline : s.statusOffline]}>
            <Text style={s.statusPillTxt}>{isOnline ? '🌐 Online' : '📡 Offline'}</Text>
          </View>
        </View>
        <View style={s.headerIcons}>
          <TouchableOpacity onPress={() => setShowSettings(true)} style={s.headerBtn}>
            <Text style={s.headerGear}>⚙️</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Chat list */}
      {loading ? (
        <View style={s.loadingWrap}><ActivityIndicator color="#075E54" size="large" /></View>
      ) : (
        <FlatList
          data={personas}
          keyExtractor={p => p.id}
          renderItem={renderCharRow}
          ItemSeparatorComponent={() => <View style={s.sep} />}
          contentContainerStyle={{ paddingBottom: 100 }}
        />
      )}

      {/* Floating action buttons */}
      <View style={[s.fab, { bottom: insets.bottom + 16 }]}>
        <TouchableOpacity style={[s.fabBtn, { backgroundColor: '#E91E8C' }]} onPress={() => router.push('/prompt-image')}>
          <Text style={s.fabIcon}>🎨</Text>
          <Text style={[s.fabLabel, { color: '#fff' }]}>Text→Img</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.fabBtn, { backgroundColor: '#00897B' }]} onPress={() => setShowAddCharModal(true)}>
          <Text style={[s.fabIcon, { color: '#fff' }]}>➕</Text>
          <Text style={[s.fabLabel, { color: '#fff' }]}>Character</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.fabBtn} onPress={() => setShowGroupModal(true)}>
          <Text style={s.fabIcon}>👥</Text>
          <Text style={s.fabLabel}>Group</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.fabBtn, { backgroundColor: '#4A1D96' }]} onPress={handlePhotoToScript}>
          <Image source={require('../assets/images/photo-to-script-icon.png')} style={s.fabScriptImg} />
          <Text style={[s.fabLabel, { color: '#e9d5ff', fontSize: 9 }]}>Script</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.fabBtn, { backgroundColor: '#6A1B9A' }]} onPress={() => router.push('/face-swap')}>
          <Text style={s.fabIcon}>🤳</Text>
          <Text style={[s.fabLabel, { color: '#fff' }]}>Swap</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.fabBtn, { backgroundColor: '#1565C0' }]} onPress={() => router.push('/home')}>
          <Text style={s.fabIcon}>☁️</Text>
          <Text style={[s.fabLabel, { color: '#fff' }]}>Cloud</Text>
        </TouchableOpacity>
      </View>

      {/* ── MY PROFILE MODAL ── */}
      <Modal visible={showUserPhotoModal} transparent animationType="slide"
        onRequestClose={() => setShowUserPhotoModal(false)}>
        <View style={s.profileOverlay}>
          <View style={s.profileSheet}>

            {/* Header */}
            <View style={s.profileHeader}>
              <Text style={s.profileHeaderTitle}>👤 My Profile</Text>
              <TouchableOpacity onPress={() => setShowUserPhotoModal(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Text style={s.profileHeaderClose}>✕</Text>
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={s.profileScroll}>

              {/* Avatar section */}
              <Text style={s.profileSectionLabel}>📸 Avatar</Text>
              <View style={s.profileAvatarRow}>
                <TouchableOpacity onPress={pickUserPhotoFromPhone} activeOpacity={0.8}>
                  {uploadingUserPhoto
                    ? <View style={s.profileAvatar}><ActivityIndicator color="#fff" /></View>
                    : userPhoto
                      ? <Image source={{ uri: userPhoto }} style={s.profileAvatar} />
                      : <View style={[s.profileAvatar, { backgroundColor: '#128C7E' }]}>
                          <Text style={{ fontSize: 38 }}>👤</Text>
                        </View>
                  }
                  <View style={s.profileAvatarEdit}><Text style={s.profileAvatarEditTxt}>✏️</Text></View>
                </TouchableOpacity>
                <View style={s.profileAvatarBtns}>
                  <TouchableOpacity style={s.profileAvatarBtn} onPress={pickUserPhotoFromPhone}>
                    <Text style={s.profileAvatarBtnTxt}>📱 Gallery</Text>
                  </TouchableOpacity>
                  {userPhoto && (
                    <TouchableOpacity style={[s.profileAvatarBtn, { backgroundColor: '#fdecea' }]} onPress={removeUserPhoto}>
                      <Text style={[s.profileAvatarBtnTxt, { color: '#c62828' }]}>🗑 Remove</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>

              {/* Cloud URL */}
              <View style={s.profileCloudRow}>
                <TextInput
                  style={s.profileCloudInput}
                  value={userPhotoCloudInput}
                  onChangeText={setUserPhotoCloudInput}
                  placeholder="☁️ Cloud image URL (optional)"
                  placeholderTextColor="#aaa"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <TouchableOpacity style={s.profileCloudApply} onPress={applyUserPhotoCloudUrl}>
                  <Text style={s.profileCloudApplyTxt}>✓</Text>
                </TouchableOpacity>
              </View>

              {/* User Normal Avatar */}
              <Text style={s.profileSectionLabel}>😇 Normal Mode Avatar</Text>
              <Text style={s.profileSectionHint}>Normal mode chat-ல் இந்த photo-ஓட profile use ஆகும்.</Text>
              <View style={s.profileAvatarRow}>
                <TouchableOpacity onPress={pickUserNormalPhoto} activeOpacity={0.8}>
                  {uploadingUserNormal
                    ? <View style={s.profileAvatar}><ActivityIndicator color="#fff" /></View>
                    : userNormalPhoto
                      ? <Image source={{ uri: userNormalPhoto }} style={s.profileAvatar} />
                      : <View style={[s.profileAvatar, { backgroundColor: '#2196F3' }]}>
                          <Text style={{ fontSize: 32 }}>😇</Text>
                        </View>
                  }
                  <View style={s.profileAvatarEdit}><Text style={s.profileAvatarEditTxt}>✏️</Text></View>
                </TouchableOpacity>
                <View style={s.profileAvatarBtns}>
                  <TouchableOpacity style={s.profileAvatarBtn} onPress={pickUserNormalPhoto}>
                    <Text style={s.profileAvatarBtnTxt}>📱 Gallery (Normal)</Text>
                  </TouchableOpacity>
                  {userNormalPhoto && (
                    <TouchableOpacity style={[s.profileAvatarBtn, { backgroundColor: '#fdecea' }]}
                      onPress={() => { setUserNormalPhoto(null); AsyncStorage.removeItem('user_normal_photo'); }}>
                      <Text style={[s.profileAvatarBtnTxt, { color: '#c62828' }]}>🗑 Remove</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>

              {/* User Prasana Avatar */}
              <Text style={s.profileSectionLabel}>😈 Prasana Mode Avatar</Text>
              <Text style={s.profileSectionHint}>Prasana mode chat-ல் இந்த photo-ஓட profile use ஆகும்.</Text>
              <View style={s.profileAvatarRow}>
                <TouchableOpacity onPress={pickUserPrasanaPhoto} activeOpacity={0.8}>
                  {uploadingUserPrasana
                    ? <View style={s.profileAvatar}><ActivityIndicator color="#fff" /></View>
                    : userPrasanaPhoto
                      ? <Image source={{ uri: userPrasanaPhoto }} style={s.profileAvatar} />
                      : <View style={[s.profileAvatar, { backgroundColor: '#7B1FA2' }]}>
                          <Text style={{ fontSize: 32 }}>😈</Text>
                        </View>
                  }
                  <View style={s.profileAvatarEdit}><Text style={s.profileAvatarEditTxt}>✏️</Text></View>
                </TouchableOpacity>
                <View style={s.profileAvatarBtns}>
                  <TouchableOpacity style={s.profileAvatarBtn} onPress={pickUserPrasanaPhoto}>
                    <Text style={s.profileAvatarBtnTxt}>📱 Gallery (Prasana)</Text>
                  </TouchableOpacity>
                  {userPrasanaPhoto && (
                    <TouchableOpacity style={[s.profileAvatarBtn, { backgroundColor: '#fdecea' }]}
                      onPress={() => { setUserPrasanaPhoto(null); AsyncStorage.removeItem('user_prasana_photo'); }}>
                      <Text style={[s.profileAvatarBtnTxt, { color: '#c62828' }]}>🗑 Remove</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>

              {/* Name */}
              <Text style={s.profileSectionLabel}>✏️ உன் பெயர்</Text>
              <TextInput
                style={s.profileInput}
                value={editUserName}
                onChangeText={setEditUserName}
                placeholder="உன் பெயர் enter பண்ணு (e.g. Rahul)"
                placeholderTextColor="#aaa"
                maxLength={40}
              />

              {/* Behaviour / Personality */}
              <Text style={s.profileSectionLabel}>🧠 உன் Character & Behaviour</Text>
              <Text style={s.profileSectionHint}>
                AI characters உன்னை எப்படி treat பண்ணணும்? உன் personality, age, likes — எல்லாம் சொல்லலாம்.
              </Text>
              <TextInput
                style={s.profileTextArea}
                value={editUserBehaviour}
                onChangeText={setEditUserBehaviour}
                placeholder={'எ.கா: என் பெயர் Rahul, 24 வயசு. நான் romantic-ஆ பேசுவேன், மிகவும் கேர் பண்றேன். என்னோட favourite color green. நான் engineer.'}
                placeholderTextColor="#aaa"
                multiline
                numberOfLines={5}
                textAlignVertical="top"
                maxLength={500}
              />
              <Text style={s.profileCharCount}>{editUserBehaviour.length}/500</Text>

              {/* Save */}
              <TouchableOpacity style={s.profileSaveBtn} onPress={saveUserProfile}>
                <Text style={s.profileSaveBtnTxt}>
                  {profileSaved ? '✅ Saved!' : '💾 Save Profile'}
                </Text>
              </TouchableOpacity>

              <View style={{ height: 20 }} />
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* ── SETTINGS BOTTOM SHEET ── */}
      <Modal visible={showSettings} transparent animationType="slide"
        onRequestClose={() => setShowSettings(false)}>
        <View style={s.settingsOverlay}>
          <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={() => setShowSettings(false)} />
          <View style={[s.settingsSheet, { paddingBottom: insets.bottom + 8 }]}>
            <View style={s.settingsHandle} />
            <Text style={s.settingsTitle}>⚙️ Settings</Text>

            <ScrollView showsVerticalScrollIndicator={false} style={{ maxHeight: '85%' }}>

              {/* 1. Online / Offline */}
              <View style={s.settingsSection}>
                <View style={s.settingsRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.settingsRowTitle}>🌐 Online Mode</Text>
                    <Text style={s.settingsRowSub}>
                      {isOnline ? 'Gemini API வழியா chat' : 'Offline / Gemma mode'}
                    </Text>
                  </View>
                  <Toggle value={isOnline} onToggle={toggleOnline} />
                </View>
              </View>

              {/* 2. Auto-message toggle */}
              <View style={s.settingsSection}>
                <View style={s.settingsRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.settingsRowTitle}>💬 Auto Message</Text>
                    <Text style={s.settingsRowSub}>
                      App close ஆனாலும் push notification வரும்
                    </Text>
                    {autoMsgEnabled && (
                      <View style={s.pushStatusRow}>
                        {pushStatus === 'active'      && <Text style={[s.pushBadge, { backgroundColor: '#1B5E20' }]}>🔔 Notifications Active</Text>}
                        {pushStatus === 'subscribing' && <Text style={[s.pushBadge, { backgroundColor: '#E65100' }]}>⏳ Enabling...</Text>}
                        {pushStatus === 'denied'      && <Text style={[s.pushBadge, { backgroundColor: '#B71C1C' }]}>🔕 Permission Denied — Edge Settings-ல் allow பண்ணுங்க</Text>}
                        {pushStatus === 'unsupported' && <Text style={[s.pushBadge, { backgroundColor: '#555' }]}>⚠️ This browser doesn't support push</Text>}
                      </View>
                    )}
                  </View>
                  <Toggle value={autoMsgEnabled} onToggle={toggleAutoMsg} />
                </View>

                {/* Per-character intervals */}
                {autoMsgEnabled && (
                  <View style={s.intervalList}>
                    <Text style={s.intervalHeading}>⏱ Interval per Character</Text>
                    {personas.map(p => (
                      <View key={p.id} style={s.intervalRow}>
                        <View style={[s.intervalAvatar, { backgroundColor: p.avatarColor }]}>
                          {p.avatarPhotoUri
                            ? <Image source={{ uri: p.avatarPhotoUri }} style={s.intervalAvatarImg} />
                            : <Text style={s.intervalAvatarTxt}>{p.emoji}</Text>}
                        </View>
                        <Text style={s.intervalName} numberOfLines={1}>{p.name}</Text>
                        <View style={s.intervalBtns}>
                          {INTERVALS.map(iv => (
                            <TouchableOpacity key={iv}
                              style={[s.ivBtn, intervals[p.id] === iv && s.ivBtnActive]}
                              onPress={() => setIntervalForPersona(p.id, intervals[p.id] === iv ? null : iv)}>
                              <Text style={[s.ivBtnTxt, intervals[p.id] === iv && s.ivBtnTxtActive]}>
                                {iv}m
                              </Text>
                            </TouchableOpacity>
                          ))}
                          <TouchableOpacity
                            style={[s.ivBtn, intervals[p.id] == null && s.ivBtnOff]}
                            onPress={() => setIntervalForPersona(p.id, null)}>
                            <Text style={[s.ivBtnTxt, intervals[p.id] == null && s.ivBtnOffTxt]}>off</Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                    ))}
                  </View>
                )}
              </View>

              {/* 3. Gemma AI */}
              <View style={s.settingsSection}>
                <Text style={s.settingsRowTitle}>🧠 Gemma AI (Offline)</Text>
                <View style={s.gemmaStatusRow}>
                  {isWebGPUSupported()
                    ? isModelCached()
                      ? <Text style={s.gemmaStatusOk}>✅ Ready — offline chat கிடைக்கும்</Text>
                      : <Text style={s.gemmaStatusWarn}>⬇️ Download ஆகல — Chat screen-ல் 🧠 icon tap பண்ணுங்க</Text>
                    : <Text style={s.gemmaStatusErr}>⚠️ Chrome 121+ தேவை (WebGPU)</Text>
                  }
                </View>
              </View>

              {/* 4. Ringtone */}
              <View style={s.settingsSection}>
                <Text style={s.settingsRowTitle}>🔔 Notification Ringtone</Text>
                <Text style={s.settingsRowSub}>Auto-message வரும்போது play ஆகும்</Text>
                <View style={s.ringtoneGrid}>
                  {RINGTONES.map(r => (
                    <TouchableOpacity
                      key={r.id}
                      style={[s.ringtoneBtn, ringtone === r.id && s.ringtoneBtnActive]}
                      onPress={() => pickRingtone(r.id)}
                    >
                      <Text style={s.ringtoneEmoji}>{r.emoji}</Text>
                      <Text style={[s.ringtoneTxt, ringtone === r.id && s.ringtoneTxtActive]}>
                        {r.label}
                      </Text>
                      {ringtone === r.id && <Text style={s.ringtoneCheck}>✓</Text>}
                    </TouchableOpacity>
                  ))}
                </View>
              </View>

              {/* 5. PIN Lock */}
              <View style={s.settingsSection}>
                <Text style={s.settingsRowTitle}>🔒 App PIN Lock</Text>
                <Text style={s.settingsRowSub}>
                  {existingPin ? '✅ PIN set ஆகிருக்கு — மற்றவங்க திறக்க முடியாது' : 'PIN இல்லை — யாரும் திறக்கலாம்'}
                </Text>
                <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
                  <TouchableOpacity style={s.pinBtn} onPress={openPinSetup}>
                    <Text style={s.pinBtnTxt}>{existingPin ? '🔄 PIN மாத்து' : '🔒 PIN Set பண்ணு'}</Text>
                  </TouchableOpacity>
                  {existingPin && (
                    <TouchableOpacity style={[s.pinBtn, { backgroundColor: '#fdecea' }]} onPress={removePin}>
                      <Text style={[s.pinBtnTxt, { color: '#c62828' }]}>🗑 Remove</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>

            </ScrollView>

            <TouchableOpacity style={s.keysShortcut} onPress={() => { setShowSettings(false); router.push('/keys'); }}>
              <Text style={s.keysShortcutTxt}>🔑 Keys & Accounts</Text>
            </TouchableOpacity>

            <TouchableOpacity style={s.settingsClose} onPress={() => setShowSettings(false)}>
              <Text style={s.settingsCloseTxt}>✓ Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ── PIN SETUP MODAL ── */}
      <Modal visible={showPinSetup} transparent animationType="fade"
        onRequestClose={() => setShowPinSetup(false)}>
        <View style={s.pinOverlay}>
          <View style={s.pinBox}>
            <Text style={s.pinTitle}>
              {pinStep === 'set' ? '🔒 New PIN Set பண்ணு' : '🔒 PIN Confirm பண்ணு'}
            </Text>
            <Text style={s.pinSub}>4 digits enter பண்ணுங்க</Text>

            {/* 4 dots */}
            <View style={s.pinDots}>
              {[0,1,2,3].map(i => (
                <View key={i} style={[s.pinDot, pinInput.length > i && s.pinDotFilled]} />
              ))}
            </View>

            {pinMsg ? <Text style={s.pinMsg}>{pinMsg}</Text> : null}

            {/* Numpad */}
            <View style={s.numpad}>
              {KEYS.map((k, i) => (
                k === '' ? <View key={i} style={s.numKey} /> :
                <TouchableOpacity key={i} style={[s.numKey, s.numKeyActive]} onPress={() => handlePinKey(k)}>
                  <Text style={s.numKeyTxt}>{k}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <TouchableOpacity style={s.pinCancelBtn} onPress={() => setShowPinSetup(false)}>
              <Text style={s.pinCancelTxt}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ── Edit Relationship Modal ── */}
      <Modal visible={showEditRel} transparent animationType="fade"
        onRequestClose={() => setShowEditRel(false)}>
        <View style={s.overlay}>
          <View style={s.editBox}>
            <Text style={s.editTitle}>{editingPersona?.name}</Text>
            <Text style={s.editSub}>தொடர்பு (Relationship) மாத்துங்க</Text>
            <Text style={s.editProf}>💼 {editingPersona?.profession}</Text>
            <TextInput style={s.editInput} value={relInput} onChangeText={setRelInput}
              placeholder="உதா: தங்கை, மனைவி, காதலி..." placeholderTextColor="#aaa" autoFocus />
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TouchableOpacity style={s.cancelBtn} onPress={() => setShowEditRel(false)}>
                <Text style={s.cancelTxt}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.saveBtn} onPress={() => { saveRelationship(); if (editingPersona) { ParamsStore.setEditPersonaId(editingPersona.id); router.push('/edit-character'); } }}>
                <Text style={s.saveTxt}>📷 Profile Edit</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.saveBtn} onPress={saveRelationship}>
                <Text style={s.saveTxt}>சேமி ✓</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* ── Photo to Script Modal ── */}
      <Modal visible={showScriptModal} animationType="slide" onRequestClose={() => setShowScriptModal(false)}>
        <SafeAreaView style={s.scriptSafe} edges={['top','bottom']}>

          {/* Header */}
          <View style={s.scriptHeader}>
            <TouchableOpacity onPress={() => setShowScriptModal(false)} style={s.scriptBack}>
              <Text style={s.scriptBackTxt}>✕</Text>
            </TouchableOpacity>
            <View style={{ flex:1, alignItems:'center' }}>
              <Text style={s.scriptHeaderTitle}>📸 Photo to Script</Text>
              {scriptModelUsed ? (
                <View style={s.scriptModelBadge}>
                  <Text style={s.scriptModelBadgeTxt}>✨ {scriptModelUsed}</Text>
                </View>
              ) : null}
            </View>
            <TouchableOpacity
              style={[s.scriptCopyBtn, scriptCopied && { backgroundColor:'#15803d' }]}
              onPress={async () => {
                if (!scriptText) return;
                try {
                  const Clipboard = await import('expo-clipboard');
                  await Clipboard.setStringAsync(scriptText);
                  setScriptCopied(true);
                  setTimeout(() => setScriptCopied(false), 2500);
                } catch {}
              }}
            >
              <Text style={s.scriptCopyTxt}>{scriptCopied ? '✓ Copied!' : '📋 Copy'}</Text>
            </TouchableOpacity>
          </View>

          {/* Preview image */}
          {scriptImageUri && (
            <Image source={{ uri: scriptImageUri }} style={s.scriptPreviewImg} resizeMode="cover" />
          )}

          {/* Content */}
          <ScrollView style={s.scriptScroll} contentContainerStyle={{ padding:16, paddingBottom:40 }}>
            {scriptLoading ? (
              <View style={s.scriptLoading}>
                <ActivityIndicator size="large" color="#7C3AED" />
                <Text style={s.scriptLoadTxt}>{scriptText || '📸 Image analyze பண்றேன்...'}</Text>
                <View style={s.scriptModelRow}>
                  <Text style={s.scriptModelStep}>Qwen2-VL → Florence-2 → LLaVA</Text>
                </View>
              </View>
            ) : (
              <Text style={s.scriptBody} selectable>{scriptText}</Text>
            )}
          </ScrollView>

          {/* Footer buttons — always visible */}
          <View style={s.scriptFooter}>
            <TouchableOpacity style={s.scriptNewBtn} onPress={handlePhotoToScript}>
              <Text style={s.scriptNewTxt}>🖼️ New Photo</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.scriptCopyFooterBtn, scriptCopied && { backgroundColor:'#15803d' }]}
              onPress={async () => {
                if (!scriptText) return;
                try {
                  const Clipboard = await import('expo-clipboard');
                  await Clipboard.setStringAsync(scriptText);
                  setScriptCopied(true);
                  setTimeout(() => setScriptCopied(false), 2500);
                } catch {}
              }}
            >
              <Text style={s.scriptCopyFooterTxt}>{scriptCopied ? '✓ All Copied!' : '📋 Copy All'}</Text>
            </TouchableOpacity>
          </View>

        </SafeAreaView>
      </Modal>

      {/* ── Photo Folder Modal ── */}

      <Modal visible={showFolderModal} transparent animationType="slide"
        onRequestClose={() => setShowFolderModal(false)}>
        <View style={s.overlay}>
          <View style={s.sheet}>
            <Text style={s.sheetTitle}>📸 Photo Style தேர்வு</Text>
            <ScrollView style={{ maxHeight: 420 }}>
              {PHOTO_FOLDERS.map(f => (
                <TouchableOpacity key={f.id} style={s.folderRow} onPress={() => handleFolderSelect(f.id)}>
                  <View style={[s.folderDot, { backgroundColor: f.color }]} />
                  <Text style={[s.folderLabel, { color: f.color }]}>{f.label}</Text>
                  <Text style={s.folderArrow}>›</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <TouchableOpacity style={s.cancelBtn} onPress={() => setShowFolderModal(false)}>
              <Text style={s.cancelTxt}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ── Photo Char Select Modal ── */}
      <Modal visible={showCharModal} transparent animationType="slide"
        onRequestClose={() => setShowCharModal(false)}>
        <View style={s.overlay}>
          <View style={s.sheet}>
            <Text style={s.sheetTitle}>Character தேர்வு</Text>
            <Text style={s.sheetSub}>யாரோட {PHOTO_FOLDERS.find(f => f.id === pendingFolderId)?.label} photo வேணும்?</Text>
            <ScrollView style={{ maxHeight: 380 }}>
              {personas.map(p => (
                <TouchableOpacity key={p.id} style={s.sheetRow} onPress={() => handleCharForPhoto(p)}>
                  <View style={[s.sheetAvatar, { backgroundColor: p.avatarColor }]}>
                    {p.avatarPhotoUri
                      ? <Image source={{ uri: p.avatarPhotoUri }} style={s.sheetAvatarImg} />
                      : <Text style={s.sheetAvatarTxt}>{p.emoji}</Text>}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={s.sheetName}>{p.name}</Text>
                    <Text style={s.sheetRel}>{p.editedRelationship ?? p.relationship} · {p.profession}</Text>
                  </View>
                  <Text style={s.folderArrow}>›</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <TouchableOpacity style={s.cancelBtn} onPress={() => setShowCharModal(false)}>
              <Text style={s.cancelTxt}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ── Group Chat Modal ── */}
      <Modal visible={showGroupModal} transparent animationType="slide"
        onRequestClose={() => setShowGroupModal(false)}>
        <View style={s.overlay}>
          <View style={s.sheet}>
            <Text style={s.sheetTitle}>👥 Group Chat</Text>
            <Text style={s.sheetSub}>2+ characters select பண்ணுங்க</Text>
            <ScrollView style={{ maxHeight: 380 }}>
              {personas.map(p => {
                const sel = selectedForGroup.includes(p.id);
                return (
                  <TouchableOpacity key={p.id}
                    style={[s.sheetRow, sel && s.sheetRowSel]}
                    onPress={() => setSelectedForGroup(prev =>
                      prev.includes(p.id) ? prev.filter(x => x !== p.id) : [...prev, p.id]
                    )}>
                    <View style={[s.sheetAvatar, { backgroundColor: p.avatarColor }]}>
                      <Text style={s.sheetAvatarTxt}>{p.emoji}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={s.sheetName}>{p.name}</Text>
                      <Text style={s.sheetRel}>{p.editedRelationship ?? p.relationship} · {p.profession}</Text>
                    </View>
                    {sel && <Text style={s.check}>✓</Text>}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
              <Pressable style={s.cancelBtn} onPress={() => { setShowGroupModal(false); setSelectedForGroup([]); }}>
                <Text style={s.cancelTxt}>Cancel</Text>
              </Pressable>
              <Pressable style={[s.saveBtn, selectedForGroup.length < 2 && { opacity: 0.4 }]}
                onPress={startGroupChat} disabled={selectedForGroup.length < 2}>
                <Text style={s.saveTxt}>Start ({selectedForGroup.length})</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* ── ADD CHARACTER MODAL ── */}
      <Modal visible={showAddCharModal} transparent animationType="slide"
        onRequestClose={() => setShowAddCharModal(false)}>
        <View style={s.overlay}>
          <View style={[s.profileSheet, { padding: 20, maxHeight: '70%' }]}>
            <Text style={{ fontSize: 18, fontWeight: 'bold', color: '#075E54', marginBottom: 14 }}>
              ➕ புது Character add பண்ணு
            </Text>
            <Text style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>பெயர் *</Text>
            <TextInput style={s.profileInput} value={newCharName} onChangeText={setNewCharName}
              placeholder="உதா: ரஞ்சினி" placeholderTextColor="#aaa" />
            <Text style={{ fontSize: 12, color: '#666', marginBottom: 6, marginTop: 8 }}>Role (relationship)</Text>
            <TextInput style={s.profileInput} value={newCharRole} onChangeText={setNewCharRole}
              placeholder="உதா: காதலி, தோழி, அக்கா..." placeholderTextColor="#aaa" />
            <Text style={{ fontSize: 12, color: '#666', marginBottom: 6, marginTop: 8 }}>Profession</Text>
            <TextInput style={s.profileInput} value={newCharSub} onChangeText={setNewCharSub}
              placeholder="உதா: Doctor, Teacher..." placeholderTextColor="#aaa" />
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
              <Pressable style={s.cancelBtn} onPress={() => { setShowAddCharModal(false); setNewCharName(''); setNewCharRole(''); setNewCharSub(''); }}>
                <Text style={s.cancelTxt}>Cancel</Text>
              </Pressable>
              <Pressable style={s.saveBtn} onPress={saveNewCharacter}>
                <Text style={s.saveTxt}>Save</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#ECE5DD' },

  header: {
    backgroundColor: '#128C7E',
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, paddingVertical: 14,
    gap: 10,
    elevation: 4,
    shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 3, shadowOffset: { width: 0, height: 2 },
  },
  userAvatarBtn: { alignItems: 'center', gap: 2, minWidth: 48 },
  userPhotoImg: { width: 44, height: 44, borderRadius: 22, borderWidth: 2, borderColor: '#fff' },
  userPhotoDefault: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.35)',
    justifyContent: 'center', alignItems: 'center',
    borderWidth: 2, borderColor: '#fff',
  },
  userNameBadge: {
    color: '#fff', fontSize: 9, fontWeight: '700',
    maxWidth: 60, textAlign: 'center',
  },

  // Profile modal
  profileOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  profileSheet: {
    backgroundColor: '#fff', borderTopLeftRadius: 24, borderTopRightRadius: 24,
    maxHeight: '90%',
  },
  profileHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    padding: 18, borderBottomWidth: 1, borderBottomColor: '#f0f0f0',
  },
  profileHeaderTitle: { fontSize: 18, fontWeight: 'bold', color: '#075E54' },
  profileHeaderClose: { fontSize: 22, color: '#888' },
  profileScroll: { padding: 18, paddingBottom: 40 },
  profileSectionLabel: { fontSize: 13, fontWeight: '800', color: '#075E54', marginTop: 16, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 },
  profileSectionHint: { fontSize: 12, color: '#888', marginBottom: 8, lineHeight: 18 },
  profileAvatarRow: { flexDirection: 'row', alignItems: 'center', gap: 16, marginBottom: 10 },
  profileAvatar: { width: 84, height: 84, borderRadius: 42, justifyContent: 'center', alignItems: 'center', backgroundColor: '#e0e0e0' },
  profileAvatarEdit: {
    position: 'absolute', bottom: 0, right: 0,
    backgroundColor: '#075E54', width: 24, height: 24, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
  },
  profileAvatarEditTxt: { fontSize: 11 },
  profileAvatarBtns: { flex: 1, gap: 8 },
  profileAvatarBtn: {
    backgroundColor: '#e8f5e9', borderRadius: 10, paddingVertical: 10,
    alignItems: 'center',
  },
  profileAvatarBtnTxt: { fontSize: 13, fontWeight: '700', color: '#075E54' },
  profileCloudRow: { flexDirection: 'row', gap: 8, marginBottom: 6 },
  profileCloudInput: {
    flex: 1, borderWidth: 1, borderColor: '#ddd', borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 9, fontSize: 12, color: '#111',
  },
  profileCloudApply: {
    backgroundColor: '#1565C0', borderRadius: 10, paddingHorizontal: 16,
    justifyContent: 'center', alignItems: 'center',
  },
  profileCloudApplyTxt: { color: '#fff', fontWeight: '700', fontSize: 16 },
  profileInput: {
    borderWidth: 1, borderColor: '#ddd', borderRadius: 12,
    paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, color: '#111',
    marginBottom: 4,
  },
  profileTextArea: {
    borderWidth: 1, borderColor: '#ddd', borderRadius: 12,
    paddingHorizontal: 14, paddingVertical: 12, fontSize: 14, color: '#111',
    minHeight: 110, marginBottom: 4,
  },
  profileCharCount: { fontSize: 11, color: '#aaa', textAlign: 'right', marginBottom: 12 },
  profileSaveBtn: {
    backgroundColor: '#075E54', borderRadius: 14, paddingVertical: 16,
    alignItems: 'center', marginTop: 4,
  },
  profileSaveBtnTxt: { color: '#fff', fontSize: 16, fontWeight: 'bold' },

  headerTitle: { color: '#fff', fontSize: 22, fontWeight: 'bold', paddingLeft: 4, letterSpacing: 0.3 },
  headerIcons: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  headerCharBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    backgroundColor: '#00897B', borderRadius: 16,
    paddingHorizontal: 10, paddingVertical: 5,
  },
  headerCharIcon: { fontSize: 12, color: '#fff' },
  headerCharTxt: { fontSize: 12, color: '#fff', fontWeight: '700' },
  headerBtn: { padding: 6 },
  headerGear: { fontSize: 20 },
  buildBadge: { backgroundColor: '#7C3AED', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8 },
  buildBadgeTxt: { color: '#fff', fontSize: 10, fontWeight: '800' },
  statusPill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
  statusOnline: { backgroundColor: '#1B5E20' },
  statusOffline: { backgroundColor: '#B71C1C' },
  statusPillTxt: { color: '#fff', fontSize: 11, fontWeight: '600' },
  pushStatusRow: { marginTop: 6 },
  pushBadge: { color: '#fff', fontSize: 11, fontWeight: '600', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, alignSelf: 'flex-start' },

  loadingWrap: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  chatRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#fff', paddingHorizontal: 14, paddingVertical: 12,
  },
  avatar: { width: 52, height: 52, borderRadius: 26, justifyContent: 'center', alignItems: 'center', marginRight: 14 },
  avatarImg: { width: 52, height: 52, borderRadius: 26 },
  avatarTxt: { color: '#fff', fontSize: 18, fontWeight: 'bold' },
  chatMid: { flex: 1 },
  chatName: { fontSize: 16, fontWeight: '700', color: '#111', marginBottom: 3 },
  chatSub: { fontSize: 13, color: '#666' },
  chatRight: { alignItems: 'flex-end', gap: 4 },
  chatTime: { fontSize: 12, color: '#888' },
  timerBadge: { fontSize: 10, color: '#075E54', fontWeight: '700' },
  badge: { backgroundColor: '#25D366', borderRadius: 10, minWidth: 20, height: 20, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 4 },
  badgeTxt: { color: '#fff', fontSize: 11, fontWeight: 'bold' },
  sep: { height: 1, backgroundColor: '#f0f0f0', marginLeft: 80 },

  fab: { position: 'absolute', right: 12, bottom: 20, gap: 10, alignItems: 'center' },
  fabBtn: {
    backgroundColor: '#fff', borderRadius: 12,
    paddingVertical: 8, paddingHorizontal: 10,
    alignItems: 'center', elevation: 4,
    shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 4, shadowOffset: { width: 0, height: 2 },
    minWidth: 64, width: 64,
  },
  fabIcon: { fontSize: 20 },
  fabLabel: { fontSize: 10, fontWeight: '700', color: '#333', marginTop: 2 },
  fabScriptImg: { width: 28, height: 28, borderRadius: 6 },

  // ── Photo to Script Modal ──
  scriptSafe: { flex: 1, backgroundColor: '#0f0f1a' },
  scriptHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: '#1f2937',
  },
  scriptBack: { padding: 6 },
  scriptBackTxt: { color: '#9ca3af', fontSize: 18, fontWeight: '700' },
  scriptHeaderIcon: { width: 28, height: 28, borderRadius: 6 },
  scriptHeaderTitle: { color: '#e9d5ff', fontSize: 16, fontWeight: '800' },
  scriptCopyBtn: {
    backgroundColor: '#4A1D96', borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 6,
  },
  scriptCopyTxt: { color: '#fff', fontSize: 12, fontWeight: '700' },
  scriptPreviewImg: { width: '100%', height: 180 },
  scriptScroll: { flex: 1 },
  scriptLoading: { alignItems: 'center', paddingTop: 40, gap: 12 },
  scriptLoadTxt: { color: '#c4b5fd', fontSize: 15, fontWeight: '600', marginTop: 8 },
  scriptBody: { color: '#e5e7eb', fontSize: 14, lineHeight: 22 },
  scriptFooter: { padding: 14, borderTopWidth: 1, borderTopColor: '#1f2937' },
  scriptRetryBtn: {
    backgroundColor: '#1f2937', borderRadius: 12, borderWidth: 1, borderColor: '#374151',
    paddingVertical: 12, alignItems: 'center',
  },
  scriptRetryTxt: { color: '#9ca3af', fontSize: 14, fontWeight: '600' },

  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' },

  // ── Settings Sheet ──
  settingsOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  settingsSheet: {
    backgroundColor: '#fff', borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingTop: 12, paddingHorizontal: 20, paddingBottom: 0,
    maxHeight: '80%',
  },
  settingsHandle: {
    width: 40, height: 4, backgroundColor: '#ddd', borderRadius: 2,
    alignSelf: 'center', marginBottom: 14,
  },
  settingsTitle: { fontSize: 20, fontWeight: 'bold', color: '#111', marginBottom: 16 },
  settingsSection: {
    borderBottomWidth: 1, borderBottomColor: '#f0f0f0',
    paddingVertical: 16,
  },
  settingsRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  settingsRowTitle: { fontSize: 15, fontWeight: '700', color: '#111', marginBottom: 3 },
  settingsRowSub: { fontSize: 12, color: '#777' },

  // ── Custom Toggle ──
  toggle: {
    width: 80, height: 36, borderRadius: 18,
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 4, overflow: 'hidden',
  },
  toggleOn: { backgroundColor: '#25D366' },
  toggleOff: { backgroundColor: '#EF5350' },
  toggleDot: {
    width: 28, height: 28, borderRadius: 14, backgroundColor: '#fff',
    elevation: 2, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 3, shadowOffset: { width: 0, height: 1 },
  },
  toggleDotRight: { marginLeft: 'auto' as any },
  toggleDotLeft: { marginRight: 'auto' as any },
  toggleLabel: { color: '#fff', fontSize: 11, fontWeight: '800', marginRight: 2 },

  // ── Auto-message intervals ──
  intervalList: { marginTop: 14, gap: 10 },
  intervalHeading: { fontSize: 13, fontWeight: '700', color: '#444', marginBottom: 4 },
  intervalRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#f9f9f9', borderRadius: 10, padding: 8,
  },
  intervalAvatar: { width: 32, height: 32, borderRadius: 16, justifyContent: 'center', alignItems: 'center' },
  intervalAvatarImg: { width: 32, height: 32, borderRadius: 16 },
  intervalAvatarTxt: { color: '#fff', fontSize: 12, fontWeight: 'bold' },
  intervalName: { flex: 1, fontSize: 13, fontWeight: '600', color: '#333' },
  intervalBtns: { flexDirection: 'row', gap: 4 },
  ivBtn: {
    paddingHorizontal: 8, paddingVertical: 5, borderRadius: 8,
    borderWidth: 1, borderColor: '#ddd', backgroundColor: '#fff',
  },
  ivBtnActive: { backgroundColor: '#075E54', borderColor: '#075E54' },
  ivBtnOff: { backgroundColor: '#ffebee', borderColor: '#ef9a9a' },
  ivBtnTxt: { fontSize: 11, fontWeight: '700', color: '#555' },
  ivBtnTxtActive: { color: '#fff' },
  ivBtnOffTxt: { color: '#c62828' },

  // ── Ringtone picker ──
  ringtoneGrid: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12,
  },
  ringtoneBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 9,
    borderRadius: 20, borderWidth: 1.5, borderColor: '#ddd',
    backgroundColor: '#fafafa',
  },
  ringtoneBtnActive: {
    borderColor: '#075E54', backgroundColor: '#e8f5e9',
  },
  ringtoneEmoji: { fontSize: 16 },
  ringtoneTxt: { fontSize: 12, fontWeight: '600', color: '#555' },
  ringtoneTxtActive: { color: '#075E54' },
  ringtoneCheck: { fontSize: 12, color: '#075E54', fontWeight: '900', marginLeft: 2 },

  // ── Gemma status ──
  gemmaStatusRow: { marginTop: 8, padding: 10, backgroundColor: '#f5f5f5', borderRadius: 10 },
  gemmaStatusOk: { color: '#2e7d32', fontSize: 13, fontWeight: '600' },
  gemmaStatusWarn: { color: '#e65100', fontSize: 13 },
  gemmaStatusErr: { color: '#c62828', fontSize: 13 },

  // ── PIN in settings ──
  pinBtn: {
    flex: 1, backgroundColor: '#e8f5e9', borderRadius: 10,
    paddingVertical: 12, alignItems: 'center',
  },
  pinBtnTxt: { color: '#075E54', fontWeight: '700', fontSize: 14 },

  keysShortcut: {
    backgroundColor: '#FEF3C7', borderRadius: 12,
    paddingVertical: 13, alignItems: 'center', marginTop: 12,
    borderWidth: 1, borderColor: '#F59E0B',
  },
  keysShortcutTxt: { color: '#92400E', fontSize: 15, fontWeight: 'bold' },
  settingsClose: {
    backgroundColor: '#075E54', borderRadius: 14,
    paddingVertical: 15, alignItems: 'center', marginVertical: 10,
  },
  settingsCloseTxt: { color: '#fff', fontSize: 16, fontWeight: 'bold' },

  // ── PIN setup modal ──
  pinOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.75)', justifyContent: 'center', alignItems: 'center', padding: 24 },
  pinBox: { backgroundColor: '#fff', borderRadius: 24, padding: 28, width: '100%', alignItems: 'center' },
  pinTitle: { fontSize: 18, fontWeight: 'bold', color: '#111', marginBottom: 6, textAlign: 'center' },
  pinSub: { fontSize: 13, color: '#777', marginBottom: 24, textAlign: 'center' },
  pinDots: { flexDirection: 'row', gap: 18, marginBottom: 16 },
  pinDot: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: '#aaa', backgroundColor: '#fff' },
  pinDotFilled: { backgroundColor: '#075E54', borderColor: '#075E54' },
  pinMsg: { fontSize: 13, color: '#c62828', marginBottom: 14, textAlign: 'center' },
  numpad: { flexDirection: 'row', flexWrap: 'wrap', width: 240, gap: 10, justifyContent: 'center', marginBottom: 16 },
  numKey: { width: 68, height: 56, borderRadius: 14, justifyContent: 'center', alignItems: 'center' },
  numKeyActive: { backgroundColor: '#f0f0f0', elevation: 1 },
  numKeyTxt: { fontSize: 22, fontWeight: '600', color: '#111' },
  pinCancelBtn: { paddingVertical: 10, paddingHorizontal: 24 },
  pinCancelTxt: { color: '#888', fontSize: 14, fontWeight: '600' },

  // ── Edit Relationship ──
  editBox: { backgroundColor: '#fff', borderRadius: 20, padding: 24, width: '88%' },
  editTitle: { fontSize: 18, fontWeight: 'bold', color: '#075E54', marginBottom: 4 },
  editSub: { fontSize: 13, color: '#888', marginBottom: 8 },
  editProf: { fontSize: 13, color: '#555', marginBottom: 14, backgroundColor: '#f5f5f5', padding: 8, borderRadius: 8 },
  editInput: {
    borderWidth: 1.5, borderColor: '#075E54', borderRadius: 12,
    paddingHorizontal: 14, paddingVertical: 12,
    fontSize: 15, color: '#111', marginBottom: 16,
  },

  sheet: {
    backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: 20, width: '100%', position: 'absolute', bottom: 0,
  },
  sheetTitle: { fontSize: 18, fontWeight: 'bold', color: '#075E54', marginBottom: 4 },
  sheetSub: { fontSize: 13, color: '#888', marginBottom: 12 },
  sheetRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 4, borderRadius: 10, marginBottom: 2 },
  sheetRowSel: { backgroundColor: '#e8f5e9' },
  sheetAvatar: { width: 42, height: 42, borderRadius: 21, justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  sheetAvatarImg: { width: 42, height: 42, borderRadius: 21 },
  sheetAvatarTxt: { color: '#fff', fontSize: 15, fontWeight: 'bold' },
  sheetName: { fontSize: 15, fontWeight: '600', color: '#111' },
  sheetRel: { fontSize: 12, color: '#666', marginTop: 1 },
  check: { color: '#25D366', fontSize: 20, fontWeight: 'bold' },

  folderRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 4, borderRadius: 8, marginBottom: 2 },
  folderDot: { width: 12, height: 12, borderRadius: 6, marginRight: 12 },
  folderLabel: { flex: 1, fontSize: 15, fontWeight: '600' },
  folderArrow: { color: '#bbb', fontSize: 22, fontWeight: 'bold' },

  cancelBtn: { flex: 1, padding: 14, borderRadius: 10, borderWidth: 1, borderColor: '#ccc', alignItems: 'center' },
  cancelTxt: { color: '#555', fontWeight: '600' },
  saveBtn: { flex: 1, padding: 14, borderRadius: 10, backgroundColor: '#075E54', alignItems: 'center' },
  saveTxt: { color: '#fff', fontWeight: 'bold' },
});
