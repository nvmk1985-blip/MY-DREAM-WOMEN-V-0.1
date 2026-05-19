import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  FlatList, StyleSheet, KeyboardAvoidingView,
  Platform, ActivityIndicator, Alert, Modal,
  Image, ScrollView, Dimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useRouter } from 'expo-router';
import { sendMessage, sendToLocalGemma, Message, generateImage, listCloudinaryImages } from '../services/api';

// Per-style photo cache helpers — same key as ai-girls-cloud.tsx uses
const stylePhotoCacheKey = (personaId: string, styleId: string) =>
  `cloud_photos_${personaId}_${styleId}`;

async function getStylePhotos(personaId: string, styleId: string): Promise<Array<{url:string;public_id:string}>> {
  try {
    const raw = await AsyncStorage.getItem(stylePhotoCacheKey(personaId, styleId));
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

async function addStylePhoto(personaId: string, styleId: string, photo: {url:string;public_id:string}) {
  try {
    const existing = await getStylePhotos(personaId, styleId);
    if (!existing.some(p => p.public_id === photo.public_id)) {
      const updated = [photo, ...existing].slice(0, 100);
      await AsyncStorage.setItem(stylePhotoCacheKey(personaId, styleId), JSON.stringify(updated));
    }
  } catch {}
}

// Sequential photo index — advances each time a style is tapped
const photoIdxKey = (personaId: string, styleId: string) =>
  `photo_idx_${personaId}_${styleId}`;

async function getNextPhotoIdx(personaId: string, styleId: string, total: number): Promise<number> {
  try {
    const raw = await AsyncStorage.getItem(photoIdxKey(personaId, styleId));
    const current = raw ? parseInt(raw, 10) : 0;
    const next = (current + 1) % total;
    await AsyncStorage.setItem(photoIdxKey(personaId, styleId), String(next));
    return current; // show current, save next for next time
  } catch { return 0; }
}
import { getScriptedReply } from '../utils/offline-responses';
import {
  isWebGPUSupported, isModelCached, isEngineReady,
  loadModel, chatWithGemma, getModelSizeLabel, validateCacheStorage,
} from '../services/webllm';
import { saveGeneratedImageToCloud } from './cloud-storage';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';
import { ALL_PERSONAS, Persona } from '../constants/personas';
import { ParamsStore } from '../context/params-store';

const { width, height } = Dimensions.get('window');


// ── Chat Wallpapers ──────────────────────────────────────────────
const WALLPAPERS = [
  { id: 'default', label: '🟢 WhatsApp', bg: '#ECE5DD', dark: false },
  { id: 'dark',    label: '🌙 Dark',     bg: '#1C1C1E', dark: true  },
  { id: 'pink',    label: '🌸 Pink',     bg: '#FCE4EC', dark: false },
  { id: 'blue',    label: '💙 Blue',     bg: '#E3F2FD', dark: false },
  { id: 'purple',  label: '💜 Purple',   bg: '#F3E5F5', dark: false },
  { id: 'green',   label: '🌿 Forest',   bg: '#E8F5E9', dark: false },
];
// ── Bubble Styles ─────────────────────────────────────────────────
const BUBBLE_STYLES_LIST = [
  { id: 'classic', label: '💬 Classic' },
  { id: 'round',   label: '🫧 Round'   },
  { id: 'modern',  label: '✨ Modern'  },
];

const BUILTIN_PHOTO_STYLES = [
  { id: 'normal',    label: 'Normal Photo',          prompt: 'normal photo, fully clothed, casual' },
  { id: 'nude',      label: 'Nude 🔞',               prompt: 'nude, fully naked, explicit' },
  { id: 'seminude',  label: 'Semi-nude',             prompt: 'semi nude, partially undressed' },
  { id: 'breast',    label: 'Breast show',           prompt: 'topless, showing breasts, bare chest' },
  { id: 'seductive', label: 'Seductive pose',        prompt: 'seductive pose, alluring, provocative look' },
  { id: 'wet',       label: 'Wet clothes',           prompt: 'wet clothes, drenched, see through wet fabric' },
  { id: 'legs',      label: 'Legs spread',           prompt: 'legs spread wide, revealing pose' },
  { id: 'saree',     label: 'சேலை தூக்கி காட்டு',  prompt: 'lifting saree up, revealing thighs, traditional saree' },
  { id: 'sleeping',  label: 'Sleeping exposed',      prompt: 'sleeping pose, exposed, lying down' },
  { id: 'halfbreast',label: 'Half breast visible',   prompt: 'half breast visible, deep cleavage, low cut top' },
];
const CUSTOM_STYLES_KEY = 'custom_photo_styles_v1';
type CustomStyle = { id: string; label: string; prompt?: string };

export default function ChatScreen() {
  const router = useRouter();
  const params = ParamsStore.getChatParams();
  const personaId = params?.personaId ?? '';
  const provider = params?.provider ?? 'gemini';

  const [persona, setPersona] = useState<Persona | undefined>(undefined);
  const [avatarUri, setAvatarUri] = useState<string | undefined>(undefined);
  const [userPhotoUri, setUserPhotoUri] = useState<string | null>(null);
  const [userName, setUserName]           = useState('');
  const [userBehaviour, setUserBehaviour] = useState('');

  useEffect(() => {
    const load = async () => {
      const base = ALL_PERSONAS.find(p => p.id === personaId);
      if (!base) return;
      try {
        const saved = await AsyncStorage.getItem(`persona_edit_${base.id}`);
        if (saved) {
          const data = JSON.parse(saved);
          setPersona({ ...base, ...data, prompt: data.prompt ?? base.prompt });
          setAvatarUri(data.avatarPhotoUri);
        } else {
          setPersona(base);
          setAvatarUri(base.avatarPhotoUri);
        }
      } catch {
        setPersona(base);
      }
    };
    load();
  }, [personaId]);

  const welcome = persona
    ? (persona.greeting?.trim() || `வணக்கம்! நான் ${persona.name}. என்ன கதைக்கணும்? 😊`)
    : 'வணக்கம்! நான் Tamil AI. என்ன உதவி செய்யட்டும்? 😊';

  const [messages, setMessages] = useState<Message[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [showGenModal, setShowGenModal] = useState(false);
  const [genPrompt, setGenPrompt] = useState('');
  const [selectedStyleId, setSelectedStyleId] = useState('normal');
  const [generatingPhoto, setGeneratingPhoto] = useState(false);
  const [fullViewImg, setFullViewImg] = useState<string | null>(null);

  // Cloud photo browser (full-screen)
  const [showCloudBrowser, setShowCloudBrowser] = useState(false);
  const [cloudPhotos, setCloudPhotos] = useState<{ url: string; public_id: string }[]>([]);
  const [cloudPhotoIdx, setCloudPhotoIdx] = useState(0);
  const [loadingCloud, setLoadingCloud] = useState(false);

  // Inline photo preview inside the style modal
  const [showGeneratePanel, setShowGeneratePanel] = useState(false);
  const [showAddUrl, setShowAddUrl] = useState(false);
  const [addUrlInput, setAddUrlInput] = useState('');

  // Dialect toggle
  const [dialectMode, setDialectMode] = useState(true);
  // Mood: 'presana' (default flirty) | 'normal' (clean friendly)
  const [moodMode, setMoodMode] = useState<'presana' | 'normal'>('presana');

  // ── Chat Style (wallpaper + bubble) ──
  const [chatWallpaper, setChatWallpaper] = useState('default');
  const [bubbleStyle, setBubbleStyle] = useState('classic');
  const [showStyleSheet, setShowStyleSheet] = useState(false);

  // ── Birthday ──
  const [birthday, setBirthday] = useState('');
  const [birthdayInput, setBirthdayInput] = useState('');

  // ── Message long-press action ──
  const [selectedMsg, setSelectedMsg] = useState<Message | null>(null);

  // ── Image → Prompt ──
  const [promptLoading, setPromptLoading] = useState(false);
  const [promptText, setPromptText]       = useState('');
  const [showPromptModal, setShowPromptModal] = useState(false);

  // ── Tamil → English Translate ──
  const [translateLoading, setTranslateLoading] = useState(false);
  const [translateResult, setTranslateResult]   = useState('');
  const [showTranslateModal, setShowTranslateModal] = useState(false);

  // ── Custom Photo Styles (shared with Notes) ──
  const [customStyles, setCustomStyles] = useState<CustomStyle[]>([]);
  const [showAddStyleModal, setShowAddStyleModal] = useState(false);
  const [newStyleName, setNewStyleName] = useState('');
  const [newStylePrompt, setNewStylePrompt] = useState('');

  // Combined styles: built-in + custom
  const PHOTO_STYLES = [...BUILTIN_PHOTO_STYLES, ...customStyles];

  const loadCustomStyles = useCallback(async () => {
    try {
      const raw = await AsyncStorage.getItem(CUSTOM_STYLES_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const valid = parsed.filter(s => s && typeof s.id === 'string' && typeof s.label === 'string');
        setCustomStyles(valid);
      }
    } catch {}
  }, []);

  useEffect(() => { loadCustomStyles(); }, [loadCustomStyles]);

  // Refresh custom styles every time the style picker opens
  // (so styles added in Notes appear immediately)
  useEffect(() => {
    if (showGenModal) loadCustomStyles();
  }, [showGenModal, loadCustomStyles]);

  // Race-safe: re-read AsyncStorage before merge (Notes screen may have added styles meanwhile)
  const addCustomStyle = async () => {
    const name = newStyleName.trim();
    if (!name) return;
    const newStyle: CustomStyle = {
      id: `custom_${Date.now().toString(36)}`,
      label: name,
      prompt: newStylePrompt.trim() || name.toLowerCase(),
    };
    try {
      const raw = await AsyncStorage.getItem(CUSTOM_STYLES_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      const current: CustomStyle[] = Array.isArray(parsed) ? parsed : [];
      const merged = [...current, newStyle];
      await AsyncStorage.setItem(CUSTOM_STYLES_KEY, JSON.stringify(merged));
      setCustomStyles(merged);
    } catch {
      const updated = [...customStyles, newStyle];
      setCustomStyles(updated);
      await AsyncStorage.setItem(CUSTOM_STYLES_KEY, JSON.stringify(updated));
    }
    setNewStyleName('');
    setNewStylePrompt('');
    setShowAddStyleModal(false);
  };

  const removeCustomStyle = async (id: string) => {
    try {
      const raw = await AsyncStorage.getItem(CUSTOM_STYLES_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      const current: CustomStyle[] = Array.isArray(parsed) ? parsed : [];
      const updated = current.filter(s => s.id !== id);
      await AsyncStorage.setItem(CUSTOM_STYLES_KEY, JSON.stringify(updated));
      setCustomStyles(updated);
    } catch {
      const updated = customStyles.filter(s => s.id !== id);
      setCustomStyles(updated);
      await AsyncStorage.setItem(CUSTOM_STYLES_KEY, JSON.stringify(updated));
    }
  };

  useEffect(() => {
    if (!personaId) return;
    AsyncStorage.multiGet([
      `dialect_mode_${personaId}`,
      `mood_mode_${personaId}`,
      `chat_wallpaper_${personaId}`,
      `bubble_style_${personaId}`,
      `birthday_${personaId}`,
    ]).then(pairs => {
      if (pairs[0][1] !== null) setDialectMode(pairs[0][1] === 'true');
      if (pairs[1][1] !== null) setMoodMode(pairs[1][1] === 'normal' ? 'normal' : 'presana');
      if (pairs[2][1]) setChatWallpaper(pairs[2][1]);
      if (pairs[3][1]) setBubbleStyle(pairs[3][1]);
      if (pairs[4][1]) {
        setBirthday(pairs[4][1]);
        setBirthdayInput(pairs[4][1]);
        // Birthday check: MM-DD
        const today = new Date();
        const todayMMDD = `${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
        const checkedKey = `bday_checked_${personaId}_${today.getFullYear()}`;
        AsyncStorage.getItem(checkedKey).then(done => {
          if (pairs[4][1] === todayMMDD && !done) {
            AsyncStorage.setItem(checkedKey, '1').catch(() => {});
            setTimeout(() => {
              setMessages(prev => [...prev, {
                id: `bday_${Date.now()}`,
                role: 'assistant' as const,
                content: `🎂 Happy Birthday da! இன்னைக்கு உன்னோட special day! 🎉 உனக்காகவே wait பண்றேன் ❤️`,
                timestamp: new Date(),
              }]);
            }, 1500);
          }
        }).catch(() => {});
      }
    }).catch(() => {});
  }, [personaId]);

  const toggleDialect = async () => {
    const next = !dialectMode;
    setDialectMode(next);
    if (personaId) await AsyncStorage.setItem(`dialect_mode_${personaId}`, String(next));
  };

  const toggleMood = async () => {
    const next: 'presana' | 'normal' = moodMode === 'presana' ? 'normal' : 'presana';
    setMoodMode(next);
    if (personaId) await AsyncStorage.setItem(`mood_mode_${personaId}`, next);
  };

  // Online / Offline toggle + local Gemma settings
  const [isOnline, setIsOnline] = useState(true);
  const [localGemmaPort, setLocalGemmaPort] = useState('8080');
  const [showGemmaSettings, setShowGemmaSettings] = useState(false);
  const [portInput, setPortInput] = useState('8080');

  // WebLLM (in-browser Gemma) state
  const [webllmReady, setWebllmReady] = useState(false);
  const [webllmDownloading, setWebllmDownloading] = useState(false);
  const [webllmProgress, setWebllmProgress] = useState(0);
  const [webllmStatusText, setWebllmStatusText] = useState('');
  const [webllmError, setWebllmError] = useState('');
  const [showMobileWarn, setShowMobileWarn] = useState(false);
  const [modelSizeLabel, setModelSizeLabel] = useState('~1.4–2.8 GB');
  const webGPU = isWebGPUSupported();

  useEffect(() => {
    AsyncStorage.multiGet(['user_profile_photo', 'user_name', 'user_behaviour']).then(pairs => {
      if (pairs[0][1]) setUserPhotoUri(pairs[0][1]);
      if (pairs[1][1]) setUserName(pairs[1][1]);
      if (pairs[2][1]) setUserBehaviour(pairs[2][1]);
    }).catch(() => {});
    AsyncStorage.multiGet(['chat_is_online', 'local_gemma_port']).then(pairs => {
      const onlineVal = pairs[0][1];
      const portVal = pairs[1][1];
      if (onlineVal !== null) setIsOnline(onlineVal === 'true');
      if (portVal) { setLocalGemmaPort(portVal); setPortInput(portVal); }
    }).catch(() => {});
    // Validate Cache Storage before auto-loading (Edge memory saver may have cleared it)
    validateCacheStorage().then(valid => {
      if (valid) {
        setWebllmReady(true);
        setWebllmDownloading(true);
        setWebllmStatusText('Gemma memory-ல் load ஆகுது...');
        loadModel(({ progress, text }) => {
          setWebllmProgress(progress);
          setWebllmStatusText(text);
        }).then(() => {
          setWebllmReady(true);
          setWebllmDownloading(false);
          setWebllmProgress(0);
          setWebllmStatusText('');
        }).catch(() => {
          setWebllmDownloading(false);
          setWebllmProgress(0);
          setWebllmStatusText('');
        });
      }
      // If not valid: localStorage key cleared by validateCacheStorage, no auto-download
    });
    // Detect f16 vs f32 and set size label
    getModelSizeLabel().then(label => setModelSizeLabel(label)).catch(() => {});
  }, []);

  const doStartDownload = async () => {
    setShowMobileWarn(false);
    setWebllmError('');
    setWebllmDownloading(true);
    setWebllmProgress(0);
    setWebllmStatusText('Gemma 2B தயார் பண்றேன்...');
    setShowGemmaSettings(true); // keep open so progress bar is visible
    try {
      await loadModel(({ progress, text }) => {
        setWebllmProgress(progress);
        setWebllmStatusText(text);
      });
      setWebllmReady(true);
      setWebllmDownloading(false);
    } catch (err: any) {
      setWebllmDownloading(false);
      setWebllmProgress(0);
      const raw = (err?.message ?? '') as string;
      setWebllmError(raw || 'மீண்டும் try பண்ணுங்க.');
      setShowGemmaSettings(true);
    }
  };

  const startWebLLMDownload = () => {
    if (!webGPU) {
      setWebllmError('உங்க browser WebGPU support பண்றதில்லை. Chrome 121+ (Android) தேவை.');
      return;
    }
    // Close Gemma settings first, then show warning (avoids modal stacking issue)
    setShowGemmaSettings(false);
    setTimeout(() => setShowMobileWarn(true), 350);
  };

  const toggleOnline = () => {
    const next = !isOnline;
    setIsOnline(next);
    AsyncStorage.setItem('chat_is_online', String(next)).catch(() => {});
  };

  const saveGemmaPort = () => {
    const p = portInput.trim() || '8080';
    setLocalGemmaPort(p);
    AsyncStorage.setItem('local_gemma_port', p).catch(() => {});
    setShowGemmaSettings(false);
  };

  const flatListRef = useRef<FlatList>(null);

  // Load chat history from AsyncStorage; show greeting only if no history
  useEffect(() => {
    if (!persona) return;
    setHistoryLoaded(false);
    AsyncStorage.getItem(`chat_history_${persona.id}`).then(saved => {
      if (saved) {
        try {
          const parsed = JSON.parse(saved) as Array<{ id: string; role: string; content: string; timestamp: string; imageUri?: string }>;
          const msgs: Message[] = parsed.map(m => ({ ...m, timestamp: new Date(m.timestamp) }));
          setMessages(msgs);
        } catch {
          setMessages([{ id: '0', role: 'assistant', content: welcome, timestamp: new Date() }]);
        }
      } else {
        setMessages([{ id: '0', role: 'assistant', content: welcome, timestamp: new Date() }]);
      }
      setHistoryLoaded(true);
    }).catch(() => {
      setMessages([{ id: '0', role: 'assistant', content: welcome, timestamp: new Date() }]);
      setHistoryLoaded(true);
    });
  }, [persona?.id]);

  // Auto-save chat history whenever messages change (keep last 200)
  useEffect(() => {
    if (!historyLoaded || !personaId || messages.length === 0) return;
    const toSave = messages.slice(-200);
    AsyncStorage.setItem(`chat_history_${personaId}`, JSON.stringify(toSave)).catch(() => {});
  }, [messages, historyLoaded, personaId]);

  // Track last chat time + inject auto-message greeting if pending
  useEffect(() => {
    if (!personaId) return;
    const checkPending = async () => {
      try {
        await AsyncStorage.setItem(`last_chat_time_${personaId}`, Date.now().toString());
        const pending = await AsyncStorage.getItem(`auto_msg_pending_${personaId}`);
        if (pending === 'true') {
          await AsyncStorage.removeItem(`auto_msg_pending_${personaId}`);
          const greetings = [
            'என்ன பண்ற? miss ஆகுது 😊',
            'நீ வருவியா? 🥺',
            'ஏன் chat பண்ணல? 💕',
            'Hello?? 👋 நான் இங்க இருக்கேன்!',
            'என்னங்க, மறந்துட்டீங்களா? 😅',
            'உன்னோட voice கேக்கணும் 🥹',
          ];
          const text = greetings[Math.floor(Math.random() * greetings.length)];
          setTimeout(() => {
            setMessages(prev => [
              ...prev,
              { id: `auto_${Date.now()}`, role: 'assistant', content: text, timestamp: new Date() },
            ]);
          }, 800);
        }
      } catch {}
    };
    checkPending();
  }, [personaId]);

  // Reset add-url state when modal opens
  useEffect(() => {
    if (!showGenModal) return;
    setShowAddUrl(false);
    setAddUrlInput('');
  }, [showGenModal]);

  const clearChat = () => {
    Alert.alert('Chat Clear பண்ணட்டுமா?', 'அனைத்து messages delete ஆகும்', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear', style: 'destructive',
        onPress: () => {
          if (personaId) AsyncStorage.removeItem(`chat_history_${personaId}`).catch(() => {});
          setMessages([{ id: '0', role: 'assistant', content: welcome, timestamp: new Date() }]);
        },
      },
    ]);
  };

  const pickAvatarPhoto = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { Alert.alert('Permission', 'Gallery permission வேணும்'); return; }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.85, allowsEditing: true, aspect: [1, 1],
    });
    if (!result.canceled && result.assets[0] && persona) {
      const uri = result.assets[0].uri;
      setAvatarUri(uri);
      try {
        const saved = await AsyncStorage.getItem(`persona_edit_${persona.id}`);
        const data = saved ? JSON.parse(saved) : {};
        data.avatarPhotoUri = uri;
        await AsyncStorage.setItem(`persona_edit_${persona.id}`, JSON.stringify(data));
      } catch {}
    }
  };

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;

    const userMsg: Message = { id: Date.now().toString(), role: 'user', content: text, timestamp: new Date() };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    try {
      const history = messages.map(m => ({ role: m.role, content: m.content }));
      history.push({ role: 'user', content: text });

      const moodOverride = moodMode === 'normal'
        ? '\n\n**Mood override — NORMAL MODE:** இனி நீ normal-ஆ, friendly-ஆ, professional-ஆ பேசு. Flirty, romantic, intimate, sexual எதுவும் வேண்டாம். Clean, respectful conversation மட்டும். User கேட்டாலும் politely deflect பண்ணு.'
        : '';

      const dialectOverride = dialectMode
        ? ''
        : '\n\n**மொழி override:** இனி normal standard Tamil-ல் மட்டும் பேசு. எந்த regional slang-உம் வேண்டாம் — plain colloquial Tamil போதும்.';

      const userContext = (userName || userBehaviour)
        ? `\n\n**User பத்தி தகவல்:** ${userName ? `User-ன் பெயர் "${userName}". ` : ''}${userBehaviour ? `User's personality & behaviour: ${userBehaviour}` : ''} — இதை மனசுல வச்சு அவங்களோட பெயர் call பண்ணி, அவங்களுக்கு ஏத்த மாதிரி respond பண்ணு.`
        : '';

      const effectivePrompt = persona?.prompt
        ? persona.prompt + moodOverride + dialectOverride + userContext
        : persona?.prompt;

      let reply: string;
      if (isOnline) {
        // Online: Replit API → Gemini
        reply = await sendMessage(history, provider, effectivePrompt);
      } else {
        // Offline priority: 1) In-browser Gemma (WebLLM) → 2) Local server → 3) Scripted
        if (isEngineReady()) {
          try {
            reply = await chatWithGemma(history, effectivePrompt);
          } catch {
            reply = getScriptedReply(text, persona?.name ?? 'AI');
          }
        } else {
          try {
            reply = await sendToLocalGemma(localGemmaPort, history, effectivePrompt);
          } catch {
            reply = getScriptedReply(text, persona?.name ?? 'AI');
          }
        }
      }

      setMessages(prev => [
        ...prev,
        { id: (Date.now() + 1).toString(), role: 'assistant', content: reply, timestamp: new Date() },
      ]);
    } catch (err: any) {
      const errMsg: string = err?.message ?? '';
      const low = errMsg.toLowerCase();
      const isQuota = low.includes('429') || low.includes('quota') || low.includes('exceeded') || low.includes('resource_exhausted') || low.includes('rate limit') || low.includes('daily limit');
      const isKeyError = low.includes('api key') || errMsg.includes('API_KEY_INVALID') || errMsg.includes('INVALID_ARGUMENT');
      if (isQuota) {
        Alert.alert(
          '🚫 Daily Limit ஆச்சு',
          'இன்னைக்கு Gemini free quota முடிஞ்சுது.\n\n✅ Solution:\n1. Home → 🔑 Keys → Gemini → உங்க own key add பண்ணி Switch ON பண்ணுங்க\n2. அல்லது நாளைக்கு try பண்ணுங்க\n\nFree key: aistudio.google.com',
        );
      } else if (isKeyError) {
        Alert.alert(
          '🔑 API Key பிழை',
          'Gemini API key valid இல்ல.\n\nHome → 🔑 Keys tile → Gemini API → key enter பண்ணி Save பண்ணுங்க.',
        );
      } else {
        Alert.alert('பிழை', errMsg || 'பதில் வரவில்லை. மீண்டும் முயல்க.');
      }
    } finally {
      setLoading(false);
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }, [input, loading, messages, provider, persona, isOnline, localGemmaPort]);

  const handleShowGalleryInChat = async (styleId: string) => {
    if (!persona) return;
    setShowGenModal(false);
    setSelectedStyleId(styleId);
    const photos = await getStylePhotos(persona.id, styleId);
    if (photos.length === 0) {
      const styleLabel = PHOTO_STYLES.find(s => s.id === styleId)?.label ?? styleId;
      Alert.alert(
        'Photos இல்லை',
        `"${styleLabel}" folder-ல் photos இல்லை.\n\nCloud Storage-ல் upload பண்ணுங்க அல்லது AI Generate பண்ணுங்க!`,
      );
      return;
    }
    const styleLabel = PHOTO_STYLES.find(s => s.id === styleId)?.label ?? styleId;
    const idx = await getNextPhotoIdx(persona.id, styleId, photos.length);
    const photo = photos[idx];
    const photoMsg: Message = {
      id: Date.now().toString(),
      role: 'assistant',
      content: `📷 ${styleLabel} (${idx + 1}/${photos.length})`,
      timestamp: new Date(),
      imageUrl: photo.url,
    };
    setMessages(prev => [...prev, photoMsg]);
    setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 200);
  };

  const handleBrowseCloud = async (styleIdOverride?: string) => {
    if (!persona) return;
    const styleId = styleIdOverride ?? selectedStyleId;
    setShowGenModal(false);
    setLoadingCloud(true);
    setCloudPhotoIdx(0);
    setCloudPhotos([]);
    setShowCloudBrowser(true);
    try {
      // Primary: local AsyncStorage cache
      let photos = await getStylePhotos(persona.id, styleId);
      // Fallback: try Cloudinary API if cache empty
      if (photos.length === 0) {
        const folder = `my-girls/${persona.id}/${styleId}`;
        const imgs = await listCloudinaryImages(folder).catch(() => []);
        photos = imgs.map(i => ({ url: i.url, public_id: i.public_id }));
        photos.forEach(p => addStylePhoto(persona!.id, styleId, p));
      }
      if (photos.length === 0) {
        const styleLabel = PHOTO_STYLES.find(s => s.id === styleId)?.label ?? styleId;
        Alert.alert(
          'Photos இல்லை',
          `${persona.name}-ஓட "${styleLabel}" photos இல்லை.\n\nமுதல்ல Generate பண்ணுங்க — auto-save ஆகும்!`,
          [{ text: 'OK', onPress: () => setShowCloudBrowser(false) }],
        );
      } else {
        setCloudPhotos(photos.map(p => ({ url: p.url, public_id: p.public_id, width: 0, height: 0 })));
      }
    } catch {
      Alert.alert('Error', 'Photos load பண்ண முடியல. Try again.');
      setShowCloudBrowser(false);
    } finally {
      setLoadingCloud(false);
    }
  };


  const handleAddPhotoFromUrl = async () => {
    const url = addUrlInput.trim();
    if (!url || !persona) return;
    if (!url.startsWith('http')) { Alert.alert('தவறான URL', 'http/https URL பேஸ்ட் பண்ணுங்க'); return; }
    const public_id = url.split('/').slice(-2).join('/').replace(/\.[^.]+$/, '') || `manual_${Date.now()}`;
    await addStylePhoto(persona.id, selectedStyleId, { url, public_id });
    setAddUrlInput('');
    setShowAddUrl(false);
    Alert.alert('✅ Photo சேர்க்கப்பட்டது!', 'Style-ஐ தட்டி photo பாருங்க.');
  };

  const sendCloudPhotoToChat = () => {
    const photo = cloudPhotos[cloudPhotoIdx];
    if (!photo) return;
    const msg: Message = {
      id: Date.now().toString(), role: 'assistant',
      content: `☁️ Cloud photo ${cloudPhotoIdx + 1}/${cloudPhotos.length}`,
      timestamp: new Date(), imageUrl: photo.url,
    };
    setMessages(prev => [...prev, msg]);
    setShowCloudBrowser(false);
    setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 200);
  };

  const handleGeneratePhoto = async () => {
    if (!persona) return;
    setShowGenModal(false);
    setGeneratingPhoto(true);

    const loadingId = Date.now().toString();
    const loadingMsg: Message = {
      id: loadingId, role: 'assistant',
      content: '🎨 Photo generate பண்றேன்... (~15–30 sec)',
      timestamp: new Date(), imageLoading: true,
    };
    setMessages(prev => [...prev, loadingMsg]);
    setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);

    try {
      const style = PHOTO_STYLES.find(s => s.id === selectedStyleId);
      const stylePrompt = style ? style.prompt : '';
      const combined = [stylePrompt, genPrompt.trim()].filter(Boolean).join(', ');
      const result = await generateImage({
        imgFace: persona.faceDesc,
        imgBody: persona.bodyDesc,
        imgAttire: persona.attireDesc,
        imagePrompt: combined || undefined,
        personaName: persona.name,
        mode: 'single',
      });

      const dataUri = `data:${result.mimeType};base64,${result.b64_json}`;

      // Save to persona+style specific folder & cache the URL locally for instant modal loading
      const saveFolder = persona ? `${persona.id}/${selectedStyleId}` : 'ai';
      saveGeneratedImageToCloud(result.b64_json, result.mimeType, saveFolder).then(cloudImg => {
        if (cloudImg && persona) {
          addStylePhoto(persona.id, selectedStyleId, { url: cloudImg.url, public_id: cloudImg.public_id });
        }
      }).catch(() => {});

      setMessages(prev => prev.map(m =>
        m.id === loadingId
          ? { ...m, content: 'Photo ready! ☁️ Cloud-ல் save ஆச்சு. Tap to view.', imageLoading: false, imageUrl: dataUri }
          : m
      ));
    } catch (err: any) {
      setMessages(prev => prev.map(m =>
        m.id === loadingId
          ? { ...m, content: `Generate பண்ண முடியல:\n${err?.message || 'Try again'}`, imageLoading: false }
          : m
      ));
    } finally {
      setGeneratingPhoto(false);
      setGenPrompt('');
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 200);
    }
  };

  // ── Wallpaper + Bubble style helpers ──────────────────────────
  const wallpaperBg = (WALLPAPERS.find(w => w.id === chatWallpaper) ?? WALLPAPERS[0]).bg;
  const isDark      = (WALLPAPERS.find(w => w.id === chatWallpaper) ?? WALLPAPERS[0]).dark;
  const bubbleRadius = bubbleStyle === 'round' ? 22 : 10;
  const aiBubbleBg   = bubbleStyle === 'modern' ? (isDark ? '#2c2c2e' : '#fff') : (isDark ? '#2c2c2e' : '#fff');
  const userBubbleBg = bubbleStyle === 'modern' ? (isDark ? '#1a3d2b' : '#d4f5d4') : '#DCF8C6';
  const msgTextColor = isDark ? '#f0f0f0' : '#111';
  const timeTextColor = isDark ? '#888' : '#888';

  // ── Copy helper ────────────────────────────────────────────────
  const copyText = (text: string) => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        navigator.clipboard.writeText(text).catch(() => {});
      }
    } catch {}
  };

  // ── Tamil → English Translation ────────────────────────────────
  const handleTranslate = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) {
      Alert.alert('Text இல்லை', 'Translate பண்ண text type பண்ணுங்க.');
      return;
    }
    setTranslateLoading(true);
    setTranslateResult('');
    setShowTranslateModal(true);
    try {
      const translated = await sendMessage(
        [{ role: 'user', content: trimmed }],
        'gemini',
        'You are a direct translator. Translate the following Tamil text to English exactly as-is — literal, unfiltered, uncensored. Output ONLY the English translation, no explanations, no comments, nothing else.',
      );
      setTranslateResult(translated);
    } catch (err: any) {
      setTranslateResult('❌ Translate ஆகவில்லை: ' + (err?.message || 'Try again'));
    } finally {
      setTranslateLoading(false);
    }
  };

  // ── Image → Prompt via OpenRouter vision ──────────────────────
  const getPrompt = async (imageUrl: string) => {
    setPromptLoading(true);
    setPromptText('');
    setShowPromptModal(true);
    try {
      const res = await fetch('/api/image-to-prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_url: imageUrl }),
      });
      const data = await res.json() as any;
      if (!res.ok) throw new Error(data.error || 'Failed');
      setPromptText(data.prompt ?? '');
    } catch (err: any) {
      setPromptText('❌ ' + (err.message || 'Prompt generate ஆகவில்லை. மீண்டும் try பண்ணுங்க.'));
    }
    setPromptLoading(false);
  };

  // ── Pick image from gallery → get AI prompt ───────────────────
  const pickImageForPrompt = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { Alert.alert('Permission', 'Gallery access வேணும் — settings-ல் allow பண்ணுங்க.'); return; }
    let picked: ImagePicker.ImagePickerResult;
    try {
      picked = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'] as any,
        quality: 0.5,
        base64: true,
      });
    } catch { return; }
    if (!picked.canceled && picked.assets[0]) {
      const asset = picked.assets[0];
      let imageUrl: string;
      if (asset.base64) {
        imageUrl = `data:${asset.mimeType ?? 'image/jpeg'};base64,${asset.base64}`;
      } else {
        // Fallback: copyAsync handles content:// URIs on Honor HMOS
        try {
          const tempUri = FileSystem.cacheDirectory + `prompt_${Date.now()}.jpg`;
          await FileSystem.copyAsync({ from: asset.uri, to: tempUri });
          const b64 = await FileSystem.readAsStringAsync(tempUri, {
            encoding: FileSystem.EncodingType.Base64,
          });
          await FileSystem.deleteAsync(tempUri, { idempotent: true });
          imageUrl = `data:${asset.mimeType ?? 'image/jpeg'};base64,${b64}`;
        } catch {
          Alert.alert('பிழை', 'Image read ஆகல. மீண்டும் try பண்ணுங்க.');
          return;
        }
      }
      await getPrompt(imageUrl);
    }
  };

  // ── Delete a single message ────────────────────────────────────
  const deleteMsg = (id: string) => {
    setMessages(prev => prev.filter(m => m.id !== id));
    setSelectedMsg(null);
  };

  // ── Save wallpaper/bubble/birthday ────────────────────────────
  const saveWallpaper = async (id: string) => {
    setChatWallpaper(id);
    if (personaId) await AsyncStorage.setItem(`chat_wallpaper_${personaId}`, id).catch(() => {});
  };
  const saveBubbleStyle = async (id: string) => {
    setBubbleStyle(id);
    if (personaId) await AsyncStorage.setItem(`bubble_style_${personaId}`, id).catch(() => {});
  };
  const saveBirthday = async () => {
    const val = birthdayInput.trim();
    setBirthday(val);
    if (personaId) await AsyncStorage.setItem(`birthday_${personaId}`, val).catch(() => {});
  };

  const renderItem = ({ item }: { item: Message }) => {
    const isUser = item.role === 'user';
    return (
      <View style={[styles.msgRow, isUser ? styles.userRow : styles.aiRow]}>
        {!isUser && persona && (
          <View style={styles.avatarWrap}>
            {avatarUri
              ? <Image source={{ uri: avatarUri }} style={styles.avatarImg} />
              : <View style={[styles.avatarCircle, { backgroundColor: persona.avatarColor }]}>
                  <Text style={styles.avatarEmoji}>{persona.avatarLetter || persona.emoji}</Text>
                </View>
            }
          </View>
        )}
        <TouchableOpacity
          activeOpacity={0.85}
          onLongPress={() => setSelectedMsg(item)}
          delayLongPress={400}
          style={[
            styles.bubble,
            { borderRadius: bubbleRadius },
            isUser
              ? [styles.userBubble, { backgroundColor: userBubbleBg, marginRight: 6 }]
              : [styles.aiBubble,  { backgroundColor: aiBubbleBg }],
          ]}
        >
          {item.imageLoading ? (
            <View style={styles.imgLoadingWrap}>
              <ActivityIndicator color="#075E54" size="small" />
              <Text style={[styles.msgText, { color: msgTextColor }]}>{item.content}</Text>
            </View>
          ) : item.imageUrl ? (
            <TouchableOpacity onPress={() => setFullViewImg(item.imageUrl!)} onLongPress={() => setSelectedMsg(item)} delayLongPress={400}>
              <Image source={{ uri: item.imageUrl }} style={styles.generatedImg} resizeMode="cover" />
              <Text style={[styles.msgText, { color: msgTextColor, marginTop: 4 }]}>{item.content}</Text>
            </TouchableOpacity>
          ) : (
            <Text style={[styles.msgText, { color: msgTextColor }]}>{item.content}</Text>
          )}
          <Text style={[styles.timeText, { color: timeTextColor }]}>
            {item.timestamp.toLocaleTimeString('ta-IN', { hour: '2-digit', minute: '2-digit' })}
          </Text>
        </TouchableOpacity>
        {isUser && (
          <View style={styles.userAvatarWrap}>
            {userPhotoUri
              ? <Image source={{ uri: userPhotoUri }} style={styles.userAvatarImg} />
              : <View style={styles.userAvatarDefault}><Text style={styles.userAvatarTxt}>👤</Text></View>
            }
          </View>
        )}
      </View>
    );
  };

  const dialectLabel = persona?.dialect
    ? dialectMode
      ? persona.dialect === 'Madurai' ? '🗣 மதுரை' : persona.dialect === 'Tirunelveli' ? '🗣 நெல்லை' : '🗣 கோவை'
      : '🗣 Normal'
    : null;

  const headerTitle = () => (
    <TouchableOpacity style={styles.headerTitleWrap} onPress={pickAvatarPhoto}>
      {avatarUri
        ? <Image source={{ uri: avatarUri }} style={styles.headerAvatarImg} />
        : persona
          ? <View style={[styles.headerAvatar, { backgroundColor: persona.avatarColor }]}>
              <Text style={styles.headerAvatarText}>{persona.avatarLetter || persona.emoji}</Text>
            </View>
          : null
      }
      <View>
        <Text style={styles.headerName}>{persona?.name ?? '...'}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {/* Mood badge */}
          <TouchableOpacity onPress={toggleMood} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
            <Text style={[styles.headerMoodBadge, moodMode === 'normal' && styles.headerMoodNormal]}>
              {moodMode === 'normal' ? '😇 Normal' : '😈 Presana'} ⇄
            </Text>
          </TouchableOpacity>
          {/* Dialect badge */}
          {dialectLabel && (
            <>
              <Text style={{ color: '#4db6ac', fontSize: 10 }}>·</Text>
              <TouchableOpacity onPress={toggleDialect} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                <Text style={[styles.headerDialectBadge, !dialectMode && { color: '#80cbc4' }]}>{dialectLabel} ⇄</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>
    </TouchableOpacity>
  );

  const headerRight = () => (
    <View style={styles.headerBtns}>
      <TouchableOpacity style={styles.headerBtn} onPress={() => setShowStyleSheet(true)}>
        <Text style={styles.headerBtnIcon}>🎨</Text>
      </TouchableOpacity>
      {persona && (
        <TouchableOpacity style={styles.headerBtn} onPress={() => {
          ParamsStore.setEditPersonaId(persona.id);
          router.push('/edit-character');
        }}>
          <Text style={styles.headerBtnIcon}>✏️</Text>
        </TouchableOpacity>
      )}
      <TouchableOpacity style={styles.headerBtn} onPress={clearChat}>
        <Text style={styles.headerBtnIcon}>🗑️</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: wallpaperBg }]}>
      <Stack.Screen options={{
        headerTitle,
        headerRight,
        headerStyle: { backgroundColor: '#128C7E' },
        headerTintColor: '#fff',
      }} />

      {/* Offline status banner — status only, settings via ⚙️ gear icon */}
      {!isOnline && (
        <View style={[styles.offlineBanner, webllmReady && { backgroundColor: '#1565C0' }, webllmDownloading && { backgroundColor: '#7B1FA2' }]}>
          <Text style={styles.offlineBannerTxt}>
            {isEngineReady()
              ? '🧠 Offline — Gemma AI Active'
              : webllmDownloading && isModelCached()
                ? `🔄 Gemma initialize ஆகுது... ${Math.round(webllmProgress * 100)}%`
                : webllmDownloading
                  ? `📥 Gemma downloading... ${Math.round(webllmProgress * 100)}%`
                  : `📡 Offline — Scripted mode`}
          </Text>
          {webllmDownloading && (
            <TouchableOpacity onPress={() => { setWebllmDownloading(false); setWebllmProgress(0); setWebllmStatusText(''); }}>
              <Text style={styles.offlineBannerCancel}>⛔ நிறுத்து</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
      >
        <FlatList
          ref={flatListRef}
          data={messages}
          keyExtractor={item => item.id}
          renderItem={renderItem}
          contentContainerStyle={styles.msgList}

        />
        {loading && (
          <View style={styles.loadingRow}>
            <View style={styles.loadingBubble}>
              <ActivityIndicator size="small" color="#075E54" />
              <Text style={styles.loadingText}>
                {persona ? `${persona.name} பதில் அளிக்கிறார்...` : 'பதில் தயாராகிறது...'}
              </Text>
            </View>
          </View>
        )}

        <View style={styles.inputBar}>
          <TextInput
            style={styles.input}
            value={input}
            onChangeText={setInput}
            placeholder="தமிழில் தட்டச்சு பண்ணுங்க..."
            placeholderTextColor="#999"
            multiline
            maxLength={1000}
          />
          <View style={styles.btnStack}>
            <TouchableOpacity
              style={styles.promptPickBtn}
              onPress={pickImageForPrompt}
              disabled={promptLoading}
            >
              {promptLoading
                ? <ActivityIndicator color="#fff" size="small" />
                : <Text style={styles.cameraIcon}>📋</Text>
              }
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.cameraBtn}
              onPress={() => setShowGenModal(true)}
              disabled={generatingPhoto}
            >
              {generatingPhoto
                ? <ActivityIndicator color="#fff" size="small" />
                : <Text style={styles.cameraIcon}>📷</Text>
              }
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.translateBtn}
              onPress={() => handleTranslate(input)}
              disabled={translateLoading}
            >
              {translateLoading
                ? <ActivityIndicator color="#fff" size="small" />
                : <Text style={styles.cameraIcon}>🔤</Text>
              }
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.sendBtn, (!input.trim() || loading) && styles.sendBtnDisabled]}
              onPress={handleSend}
              disabled={!input.trim() || loading}
            >
              <Text style={styles.sendIcon}>➤</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>

      <Modal visible={showGenModal} transparent animationType="slide" onRequestClose={() => setShowGenModal(false)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setShowGenModal(false)}>
          <TouchableOpacity activeOpacity={1} style={{ width: '100%' }}>
            <View style={styles.pickerSheet}>
              <View style={styles.pickerHandle} />
              <View style={styles.pickerHeader}>
                <Text style={styles.pickerTitle}>Photo Style தேர்வு செய்</Text>
                <TouchableOpacity onPress={() => setShowGenModal(false)}>
                  <Text style={styles.pickerClose}>✕</Text>
                </TouchableOpacity>
              </View>

              {/* ── Full-width style list ── */}
              <ScrollView style={styles.styleListFull} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
                {/* + Add Custom Style row (at top) */}
                <TouchableOpacity
                  style={[styles.styleRowFull, { borderColor: '#6C5CE7', borderWidth: 1, borderStyle: 'dashed' }]}
                  onPress={() => { setShowGenModal(false); setTimeout(() => setShowAddStyleModal(true), 250); }}
                >
                  <Text style={{ fontSize: 22, width: 24, textAlign: 'center', color: '#6C5CE7' }}>+</Text>
                  <Text style={[styles.styleRowFullLabel, { color: '#6C5CE7', fontWeight: '600' }]} numberOfLines={1}>
                    Add Custom Style
                  </Text>
                  <Text style={styles.styleRowArrow}>›</Text>
                </TouchableOpacity>
                {PHOTO_STYLES.map((style) => {
                  const isSelected = style.id === selectedStyleId;
                  const isCustom = style.id.startsWith('custom_');
                  return (
                    <TouchableOpacity
                      key={style.id}
                      style={[styles.styleRowFull, isSelected && styles.styleRowSelected]}
                      onPress={() => {
                        setSelectedStyleId(style.id);
                        setShowGeneratePanel(false);
                        handleShowGalleryInChat(style.id);
                      }}
                      onLongPress={() => {
                        if (isCustom) {
                          Alert.alert(
                            'Delete custom style?',
                            `"${style.label}" நீக்கணுமா?`,
                            [
                              { text: 'Cancel', style: 'cancel' },
                              { text: 'Delete', style: 'destructive', onPress: () => removeCustomStyle(style.id) },
                            ],
                          );
                        }
                      }}
                    >
                      <View style={[styles.styleRadio, isSelected && styles.styleRadioSelected]}>
                        {isSelected && <View style={styles.styleRadioDot} />}
                      </View>
                      <Text style={[styles.styleRowFullLabel, isSelected && styles.styleLabelSelected]} numberOfLines={1}>
                        {isCustom ? '★ ' : ''}{style.label}
                      </Text>
                      <Text style={styles.styleRowArrow}>›</Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>

              {/* ── Generate panel (collapsible) ── */}
              <View style={styles.generateSection}>
                <TouchableOpacity
                  style={styles.generateToggle}
                  onPress={() => setShowGeneratePanel(p => !p)}
                  disabled={generatingPhoto}
                >
                  <Text style={styles.generateToggleTxt}>
                    {generatingPhoto ? '⏳ Generating...' : (showGeneratePanel ? '▲ AI Generate மூடு' : '🎨 AI Generate (New Photo)')}
                  </Text>
                </TouchableOpacity>

                {showGeneratePanel && !generatingPhoto && (
                  <View style={styles.generateInner}>
                    <TextInput
                      style={styles.genInput}
                      value={genPrompt}
                      onChangeText={setGenPrompt}
                      placeholder="e.g. sitting on bed, smiling..."
                      placeholderTextColor="#aaa"
                      multiline
                    />
                    <TouchableOpacity style={styles.genBtn} onPress={handleGeneratePhoto}>
                      <Text style={styles.genBtnText}>🎨 Generate (1–3 min)</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>

            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* ── Add Custom Style modal (shared with Notes via AsyncStorage) ── */}
      <Modal visible={showAddStyleModal} transparent animationType="slide" onRequestClose={() => setShowAddStyleModal(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' }}>
          <View style={{ backgroundColor: '#fff', padding: 20, borderTopLeftRadius: 20, borderTopRightRadius: 20 }}>
            <Text style={{ fontSize: 18, fontWeight: '700', marginBottom: 12, color: '#222' }}>+ Custom Style சேர்க்க</Text>
            <Text style={{ fontSize: 13, color: '#666', marginBottom: 6 }}>Style Name (Notes & Chat-ல் தோன்றும்)</Text>
            <TextInput
              style={{ borderWidth: 1, borderColor: '#ddd', borderRadius: 10, padding: 12, fontSize: 15, marginBottom: 12, color: '#222' }}
              value={newStyleName}
              onChangeText={setNewStyleName}
              placeholder="e.g. Beach Pose"
              placeholderTextColor="#999"
              autoFocus
            />
            <Text style={{ fontSize: 13, color: '#666', marginBottom: 6 }}>AI Prompt (optional — photo generation-க்கு)</Text>
            <TextInput
              style={{ borderWidth: 1, borderColor: '#ddd', borderRadius: 10, padding: 12, fontSize: 15, marginBottom: 16, color: '#222', height: 60, textAlignVertical: 'top' }}
              value={newStylePrompt}
              onChangeText={setNewStylePrompt}
              placeholder="e.g. sitting on beach, bikini, sunset"
              placeholderTextColor="#999"
              multiline
            />
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <TouchableOpacity
                style={{ flex: 1, padding: 14, borderRadius: 10, backgroundColor: '#f0f0f0', alignItems: 'center' }}
                onPress={() => { setShowAddStyleModal(false); setNewStyleName(''); setNewStylePrompt(''); }}
              >
                <Text style={{ color: '#666', fontWeight: '600' }}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={{ flex: 1, padding: 14, borderRadius: 10, backgroundColor: '#6C5CE7', alignItems: 'center', opacity: newStyleName.trim() ? 1 : 0.4 }}
                onPress={addCustomStyle}
                disabled={!newStyleName.trim()}
              >
                <Text style={{ color: '#fff', fontWeight: '700' }}>Add</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ── Cloud Photo Browser Modal ── */}
      <Modal visible={showCloudBrowser} transparent={false} animationType="slide" onRequestClose={() => setShowCloudBrowser(false)}>
        <View style={styles.browserBg}>
          {/* Header */}
          <View style={styles.browserHeader}>
            <TouchableOpacity onPress={() => setShowCloudBrowser(false)} style={styles.browserCloseBtn}>
              <Text style={styles.browserCloseTxt}>✕</Text>
            </TouchableOpacity>
            <View style={{ flex: 1, alignItems: 'center' }}>
              <Text style={styles.browserTitle}>{persona?.name} — {PHOTO_STYLES.find(s => s.id === selectedStyleId)?.label}</Text>
              {cloudPhotos.length > 0 && (
                <Text style={styles.browserCount}>{cloudPhotoIdx + 1} / {cloudPhotos.length}</Text>
              )}
            </View>
            <TouchableOpacity onPress={sendCloudPhotoToChat} style={styles.browserSendBtn} disabled={cloudPhotos.length === 0}>
              <Text style={styles.browserSendTxt}>Chat-ல் அனுப்பு ➤</Text>
            </TouchableOpacity>
          </View>

          {/* Photo area */}
          <View style={styles.browserPhotoWrap}>
            {loadingCloud ? (
              <View style={styles.browserCenter}>
                <ActivityIndicator color="#fff" size="large" />
                <Text style={styles.browserLoadingTxt}>Cloud-ல் இருந்து photos load பண்றேன்...</Text>
              </View>
            ) : cloudPhotos.length === 0 ? (
              <View style={styles.browserCenter}>
                <Text style={styles.browserEmptyIcon}>☁️</Text>
                <Text style={styles.browserEmptyTxt}>Photos இல்லை{'\n'}Generate பண்ணினா இங்க வரும்</Text>
              </View>
            ) : (
              <TouchableOpacity activeOpacity={0.9} onPress={() => setFullViewImg(cloudPhotos[cloudPhotoIdx].url)} style={{ flex: 1, justifyContent: 'center' }}>
                <Image
                  source={{ uri: cloudPhotos[cloudPhotoIdx].url }}
                  style={styles.browserPhoto}
                  resizeMode="contain"
                />
              </TouchableOpacity>
            )}
          </View>

          {/* Navigation bar */}
          {cloudPhotos.length > 0 && (
            <View style={styles.browserNav}>
              <TouchableOpacity
                style={[styles.navBtn, cloudPhotoIdx === 0 && styles.navBtnDisabled]}
                onPress={() => setCloudPhotoIdx(i => Math.max(0, i - 1))}
                disabled={cloudPhotoIdx === 0}
              >
                <Text style={styles.navBtnTxt}>◀ Prev</Text>
              </TouchableOpacity>

              {/* Dot indicators (show up to 10) */}
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.dotsWrap}>
                {cloudPhotos.slice(0, 50).map((_, i) => (
                  <TouchableOpacity key={i} onPress={() => setCloudPhotoIdx(i)}>
                    <View style={[styles.dot, i === cloudPhotoIdx && styles.dotActive]} />
                  </TouchableOpacity>
                ))}
              </ScrollView>

              <TouchableOpacity
                style={[styles.navBtn, cloudPhotoIdx === cloudPhotos.length - 1 && styles.navBtnDisabled]}
                onPress={() => setCloudPhotoIdx(i => Math.min(cloudPhotos.length - 1, i + 1))}
                disabled={cloudPhotoIdx === cloudPhotos.length - 1}
              >
                <Text style={styles.navBtnTxt}>Next ▶</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Bottom action row */}
          {cloudPhotos.length > 0 && (
            <View style={styles.browserActions}>
              <TouchableOpacity style={styles.browserActionBtn} onPress={sendCloudPhotoToChat}>
                <Text style={styles.browserActionTxt}>💬 Chat-ல் அனுப்பு</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.browserActionBtn, { backgroundColor: '#1565C0' }]}
                onPress={() => setFullViewImg(cloudPhotos[cloudPhotoIdx].url)}>
                <Text style={styles.browserActionTxt}>🔍 Full Screen</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.browserActionBtn, { backgroundColor: '#6a1b9a' }]}
                onPress={() => getPrompt(cloudPhotos[cloudPhotoIdx].url)}>
                <Text style={styles.browserActionTxt}>📋 Prompt</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </Modal>

      <Modal visible={!!fullViewImg} transparent={false} animationType="fade" onRequestClose={() => setFullViewImg(null)}>
        <View style={styles.viewerBg}>
          <TouchableOpacity style={styles.viewerClose} onPress={() => setFullViewImg(null)}>
            <Text style={styles.viewerCloseText}>✕</Text>
          </TouchableOpacity>
          {fullViewImg && <Image source={{ uri: fullViewImg }} style={styles.viewerImg} resizeMode="contain" />}
          {fullViewImg && (
            <TouchableOpacity style={styles.viewerPromptBtn} onPress={() => getPrompt(fullViewImg)}>
              <Text style={styles.viewerPromptTxt}>📋 Prompt எடு</Text>
            </TouchableOpacity>
          )}
        </View>
      </Modal>

      {/* ── Image → Prompt Result Modal ── */}
      <Modal visible={showPromptModal} transparent animationType="slide" onRequestClose={() => setShowPromptModal(false)}>
        <View style={styles.promptOverlay}>
          <View style={styles.promptSheet}>
            <View style={styles.promptHeader}>
              <Text style={styles.promptTitle}>📋 Image Prompt</Text>
              <TouchableOpacity onPress={() => setShowPromptModal(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Text style={styles.promptClose}>✕</Text>
              </TouchableOpacity>
            </View>
            {promptLoading ? (
              <View style={styles.promptLoading}>
                <ActivityIndicator size="large" color="#6a1b9a" />
                <Text style={styles.promptLoadingTxt}>AI image-ஐ analyze பண்றது... ⏳</Text>
              </View>
            ) : (
              <ScrollView style={styles.promptScroll} showsVerticalScrollIndicator={false}>
                <Text selectable style={styles.promptText}>{promptText}</Text>
              </ScrollView>
            )}
            {!promptLoading && !!promptText && !promptText.startsWith('❌') && (
              <TouchableOpacity style={styles.promptCopyBtn} onPress={() => copyText(promptText)}>
                <Text style={styles.promptCopyTxt}>📋 Prompt Copy பண்ணு</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      </Modal>

      {/* ── Tamil → English Translate Modal ── */}
      <Modal visible={showTranslateModal} transparent animationType="slide" onRequestClose={() => setShowTranslateModal(false)}>
        <View style={styles.promptOverlay}>
          <View style={styles.promptSheet}>
            <View style={styles.promptHeader}>
              <Text style={styles.promptTitle}>🔤 Tamil → English</Text>
              <TouchableOpacity onPress={() => setShowTranslateModal(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Text style={styles.promptClose}>✕</Text>
              </TouchableOpacity>
            </View>
            {translateLoading ? (
              <View style={styles.promptLoading}>
                <ActivityIndicator size="large" color="#1565C0" />
                <Text style={styles.promptLoadingTxt}>Translate பண்றேன்... ⏳</Text>
              </View>
            ) : (
              <ScrollView style={styles.promptScroll} showsVerticalScrollIndicator={false}>
                <Text selectable style={[styles.promptText, { fontSize: 16, lineHeight: 26 }]}>{translateResult}</Text>
              </ScrollView>
            )}
            {!translateLoading && !!translateResult && !translateResult.startsWith('❌') && (
              <TouchableOpacity style={[styles.promptCopyBtn, { backgroundColor: '#1565C0' }]} onPress={() => copyText(translateResult)}>
                <Text style={styles.promptCopyTxt}>📋 Copy Translation</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      </Modal>

      {/* ── Message Long-Press Action Modal ── */}
      <Modal visible={!!selectedMsg} transparent animationType="fade" onRequestClose={() => setSelectedMsg(null)}>
        <TouchableOpacity style={styles.msgActionOverlay} activeOpacity={1} onPress={() => setSelectedMsg(null)}>
          <View style={styles.msgActionBox}>
            <Text style={styles.msgActionPreview} numberOfLines={2}>
              {selectedMsg?.imageUrl ? '🖼 Image' : selectedMsg?.content}
            </Text>
            {selectedMsg?.imageUrl && (
              <TouchableOpacity style={styles.msgActionBtn} onPress={() => { getPrompt(selectedMsg!.imageUrl!); setSelectedMsg(null); }}>
                <Text style={styles.msgActionIcon}>📋</Text>
                <Text style={styles.msgActionTxt}>Prompt எடு</Text>
              </TouchableOpacity>
            )}
            {!selectedMsg?.imageUrl && (
              <TouchableOpacity style={styles.msgActionBtn} onPress={() => { copyText(selectedMsg?.content ?? ''); setSelectedMsg(null); }}>
                <Text style={styles.msgActionIcon}>📋</Text>
                <Text style={styles.msgActionTxt}>Copy</Text>
              </TouchableOpacity>
            )}
            {!selectedMsg?.imageUrl && (
              <TouchableOpacity style={styles.msgActionBtn} onPress={() => { handleTranslate(selectedMsg?.content ?? ''); setSelectedMsg(null); }}>
                <Text style={styles.msgActionIcon}>🔤</Text>
                <Text style={styles.msgActionTxt}>Tamil → English Translate</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={[styles.msgActionBtn, styles.msgActionDelete]} onPress={() => selectedMsg && deleteMsg(selectedMsg.id)}>
              <Text style={styles.msgActionIcon}>🗑</Text>
              <Text style={[styles.msgActionTxt, { color: '#c62828' }]}>Delete</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.msgActionCancel} onPress={() => setSelectedMsg(null)}>
              <Text style={styles.msgActionCancelTxt}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* ── Chat Style Sheet (Wallpaper + Bubble + Birthday) ── */}
      <Modal visible={showStyleSheet} transparent animationType="slide" onRequestClose={() => setShowStyleSheet(false)}>
        <TouchableOpacity style={styles.styleSheetOverlay} activeOpacity={1} onPress={() => setShowStyleSheet(false)}>
          <TouchableOpacity activeOpacity={1}>
            <ScrollView style={styles.styleSheet} keyboardShouldPersistTaps="handled">
              <View style={styles.styleSheetHandle} />
              <Text style={styles.styleSheetTitle}>🎨 Chat Style</Text>

              {/* Wallpaper */}
              <Text style={styles.styleSheetSection}>🖼 Wallpaper</Text>
              <View style={styles.wallpaperGrid}>
                {WALLPAPERS.map(w => (
                  <TouchableOpacity key={w.id} style={[styles.wallpaperChip, { backgroundColor: w.bg }, chatWallpaper === w.id && styles.wallpaperChipActive]}
                    onPress={() => saveWallpaper(w.id)}>
                    <Text style={styles.wallpaperChipTxt}>{w.label}</Text>
                    {chatWallpaper === w.id && <Text style={styles.wallpaperCheck}>✓</Text>}
                  </TouchableOpacity>
                ))}
              </View>

              {/* Bubble Style */}
              <Text style={styles.styleSheetSection}>💬 Bubble Style</Text>
              <View style={styles.bubbleStyleRow}>
                {BUBBLE_STYLES_LIST.map(b => (
                  <TouchableOpacity key={b.id} style={[styles.bubbleStyleChip, bubbleStyle === b.id && styles.bubbleStyleChipActive]}
                    onPress={() => saveBubbleStyle(b.id)}>
                    <Text style={[styles.bubbleStyleTxt, bubbleStyle === b.id && styles.bubbleStyleTxtActive]}>{b.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              {/* Birthday */}
              <Text style={styles.styleSheetSection}>🎂 Birthday (MM-DD)</Text>
              <Text style={styles.styleSheetSub}>இந்த date-ல் special message தானா வரும்</Text>
              <View style={styles.bdayRow}>
                <TextInput
                  style={styles.bdayInput}
                  value={birthdayInput}
                  onChangeText={setBirthdayInput}
                  placeholder="05-15"
                  placeholderTextColor="#aaa"
                  maxLength={5}
                  keyboardType="numbers-and-punctuation"
                />
                <TouchableOpacity style={styles.bdaySaveBtn} onPress={saveBirthday}>
                  <Text style={styles.bdaySaveTxt}>Save 🎂</Text>
                </TouchableOpacity>
              </View>
              {birthday ? <Text style={styles.bdaySet}>✅ Birthday: {birthday} set!</Text> : null}

              <TouchableOpacity style={styles.styleSheetClose} onPress={() => setShowStyleSheet(false)}>
                <Text style={styles.styleSheetCloseTxt}>✓ Done</Text>
              </TouchableOpacity>
              <View style={{ height: 20 }} />
            </ScrollView>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* ── Mobile Data Warning — Modal so it appears above Gemma settings Modal ── */}
      <Modal visible={showMobileWarn} transparent animationType="fade"
        onRequestClose={() => setShowMobileWarn(false)}>
        <View style={styles.mobileWarnOverlay}>
          <View style={styles.mobileWarnBox}>
            <Text style={styles.mobileWarnIcon}>📶</Text>
            <Text style={styles.mobileWarnTitle}>Mobile Data பயன்படுத்துகிறீர்களா?</Text>
            <Text style={styles.mobileWarnDesc}>
              Gemma 2B download {modelSizeLabel} data பயன்படுத்தும்.{'\n'}
              Wifi-ல் download பண்ணினா data சேமிக்கலாம்.{'\n\n'}
              Mobile data-ல் download பண்ண ஆசையா?
            </Text>
            <View style={styles.mobileWarnBtns}>
              <TouchableOpacity style={styles.mobileWarnCancel} onPress={() => setShowMobileWarn(false)}>
                <Text style={styles.mobileWarnCancelTxt}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.mobileWarnOk} onPress={doStartDownload}>
                <Text style={styles.mobileWarnOkTxt}>📥 Download பண்ணு</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* ── Gemma / Offline Settings Modal ── */}
      <Modal visible={showGemmaSettings} transparent animationType="slide" onRequestClose={() => setShowGemmaSettings(false)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => { if (!webllmDownloading) setShowGemmaSettings(false); }}>
          <TouchableOpacity activeOpacity={1}>
            <ScrollView style={styles.gemmaSheet} keyboardShouldPersistTaps="handled">

              {/* ── Section 1: In-browser Gemma (WebLLM) ── */}
              <Text style={styles.gemmaTitle}>🧠 Browser-ல் Gemma AI (Best)</Text>

              {!webGPU ? (
                <View style={styles.gemmaAlert}>
                  <Text style={styles.gemmaAlertTxt}>⚠️ உங்க browser WebGPU support பண்றதில்லை. Chrome 121+ தேவை.</Text>
                </View>
              ) : webllmReady ? (
                <View style={styles.gemmaReady}>
                  <Text style={styles.gemmaReadyTxt}>✅ Gemma 2B Ready! Offline-ல் real AI கிடைக்கும்.</Text>
                </View>
              ) : webllmDownloading ? (
                <View style={styles.gemmaProgress}>
                  <Text style={styles.gemmaProgressTxt}>{webllmStatusText || 'Loading...'}</Text>
                  <View style={styles.progressBarBg}>
                    <View style={[styles.progressBarFill, { width: `${Math.round(webllmProgress * 100)}%` as any }]} />
                  </View>
                  <Text style={styles.gemmaProgressPct}>{Math.round(webllmProgress * 100)}%</Text>
                  <Text style={styles.gemmaDesc}>Screen-ஐ off பண்ணாதீங்க — download நிற்கும்</Text>
                </View>
              ) : (
                <View>
                  {webllmError ? (
                    <View style={styles.gemmaErrorBox}>
                      <Text style={styles.gemmaErrorTxt}>❌ {webllmError}</Text>
                    </View>
                  ) : null}
                  <Text style={styles.gemmaDesc}>
                    Gemma 2B model-ஐ browser-ல் download பண்ணு ({modelSizeLabel}).{'\n'}
                    Wifi அல்லது Mobile Data — எதுவும் OK!{'\n'}
                    ஒரே ஒரு முறை download — பிறகு offline-ல் real AI 🔥{'\n\n'}
                    ⚠️ Screen off பண்ணாதீங்க — download pause ஆகும்.{'\n'}
                    ⚠️ Edge Memory Saver cache-ஐ clear பண்ணும் — மீண்டும் download பண்ணணும். Edge → Settings → Performance → Memory Saver-ல் இந்த site-ஐ exception-ஆ add பண்ணுங்க.
                  </Text>
                  <TouchableOpacity style={styles.downloadBtn} onPress={startWebLLMDownload}>
                    <Text style={styles.downloadBtnTxt}>📥 Gemma AI Download பண்ணு{webllmError ? ' (மீண்டும் try)' : ''}</Text>
                  </TouchableOpacity>
                </View>
              )}

              <View style={styles.gemmaDivider} />

              {/* ── Section 2: Local server (advanced) ── */}
              <Text style={styles.gemmaTitle}>⚙️ Local App Server (Advanced)</Text>
              <Text style={styles.gemmaDesc}>
                PocketPal AI / Jan போன்ற app install பண்ணி port enter பண்ணுங்க.{'\n'}
                • PocketPal AI → <Text style={styles.gemmaPortHint}>8080</Text>{'\n'}
                • Jan → <Text style={styles.gemmaPortHint}>1234</Text>
              </Text>
              <Text style={styles.gemmaPortLabel}>Port Number</Text>
              <TextInput
                style={styles.gemmaPortInput}
                value={portInput}
                onChangeText={setPortInput}
                keyboardType="number-pad"
                placeholder="8080"
                placeholderTextColor="#aaa"
                maxLength={5}
              />
              <View style={styles.gemmaBtnRow}>
                <TouchableOpacity style={[styles.gemmaBtn, { backgroundColor: '#ccc' }]} onPress={() => setShowGemmaSettings(false)} disabled={webllmDownloading}>
                  <Text style={[styles.gemmaBtnTxt, { color: '#333' }]}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.gemmaBtn} onPress={saveGemmaPort} disabled={webllmDownloading}>
                  <Text style={styles.gemmaBtnTxt}>Save Port</Text>
                </TouchableOpacity>
              </View>
              <View style={{ height: 16 }} />
            </ScrollView>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#ECE5DD' },
  flex: { flex: 1 },
  headerTitleWrap: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  headerAvatarImg: { width: 42, height: 42, borderRadius: 21 },
  headerAvatar: { width: 42, height: 42, borderRadius: 21, justifyContent: 'center', alignItems: 'center' },
  headerAvatarText: { color: '#fff', fontSize: 16, fontWeight: 'bold' },
  headerName: { color: '#fff', fontSize: 18, fontWeight: 'bold', letterSpacing: 0.3 },
  headerOnline: { color: '#b2dfdb', fontSize: 11 },
  headerDialectBadge: { color: '#FFD54F', fontSize: 13, fontWeight: '600', marginTop: 2 },
  headerMoodBadge: { color: '#F48FB1', fontSize: 13, fontWeight: '700', marginTop: 2 },
  headerMoodNormal: { color: '#A5D6A7' },
  headerBtns: { flexDirection: 'row', alignItems: 'center', marginRight: 8, gap: 10 },
  headerBtn: { padding: 6 },
  headerBtnIcon: { fontSize: 22 },
  msgList: { padding: 10, paddingBottom: 4 },
  msgRow: { marginVertical: 3, flexDirection: 'row', alignItems: 'flex-end' },
  userRow: { justifyContent: 'flex-end', gap: 6 },
  aiRow: { justifyContent: 'flex-start', gap: 6 },
  avatarWrap: { width: 34, height: 34, borderRadius: 17, overflow: 'hidden', marginBottom: 2 },
  avatarImg: { width: 34, height: 34, borderRadius: 17 },
  avatarCircle: { width: 34, height: 34, borderRadius: 17, justifyContent: 'center', alignItems: 'center' },
  avatarEmoji: { fontSize: 16, color: '#fff' },
  userAvatarWrap: { width: 34, height: 34, borderRadius: 17, overflow: 'hidden', marginBottom: 2 },
  userAvatarImg: { width: 34, height: 34, borderRadius: 17 },
  userAvatarDefault: { width: 34, height: 34, borderRadius: 17, backgroundColor: '#DCF8C6', justifyContent: 'center', alignItems: 'center' },
  userAvatarTxt: { fontSize: 16 },
  imgLoadingWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  generatedImg: { width: 220, height: 280, borderRadius: 8, marginBottom: 4 },
  bubble: { maxWidth: '75%', borderRadius: 10, padding: 10, paddingBottom: 6, elevation: 1 },
  userBubble: { backgroundColor: '#DCF8C6', borderTopRightRadius: 2 },
  aiBubble: { backgroundColor: '#fff', borderTopLeftRadius: 2 },
  galleryBubble: { backgroundColor: 'transparent', padding: 0, shadowOpacity: 0 },
  msgText: { fontSize: 15, lineHeight: 22, color: '#111' },
  timeText: { fontSize: 10, color: '#888', alignSelf: 'flex-end', marginTop: 3 },
  loadingRow: { flexDirection: 'row', padding: 8, paddingLeft: 14 },
  loadingBubble: { backgroundColor: '#fff', borderRadius: 10, padding: 10, flexDirection: 'row', alignItems: 'center', gap: 8 },
  loadingText: { color: '#075E54', fontSize: 13 },
  inputBar: { flexDirection: 'row', alignItems: 'flex-end', padding: 8, backgroundColor: '#F0F0F0', borderTopWidth: 1, borderTopColor: '#ddd', gap: 8 },
  input: { flex: 1, backgroundColor: '#fff', borderRadius: 24, paddingHorizontal: 16, paddingVertical: 10, fontSize: 15, maxHeight: 120, color: '#111', borderWidth: 1, borderColor: '#ddd' },
  btnStack: { flexDirection: 'column', gap: 6, alignItems: 'center' },
  promptPickBtn: { backgroundColor: '#7B1FA2', width: 36, height: 36, borderRadius: 18, justifyContent: 'center', alignItems: 'center', elevation: 2 },
  cameraBtn: { backgroundColor: '#E53935', width: 42, height: 42, borderRadius: 21, justifyContent: 'center', alignItems: 'center', elevation: 3 },
  translateBtn: { backgroundColor: '#1565C0', width: 42, height: 42, borderRadius: 21, justifyContent: 'center', alignItems: 'center', elevation: 3 },
  cameraIcon: { fontSize: 18 },
  sendBtn: { backgroundColor: '#25D366', width: 46, height: 46, borderRadius: 23, justifyContent: 'center', alignItems: 'center', elevation: 2 },
  sendBtnDisabled: { backgroundColor: '#a8d5b5' },
  sendIcon: { color: '#fff', fontSize: 18, fontWeight: 'bold' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  pickerSheet: { backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: 20, paddingBottom: 10, maxHeight: '85%' },
  pickerHandle: { width: 40, height: 4, backgroundColor: '#ddd', borderRadius: 2, alignSelf: 'center', marginTop: 10, marginBottom: 6 },
  pickerHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#eee' },
  pickerTitle: { fontSize: 17, fontWeight: 'bold', color: '#111' },
  pickerClose: { fontSize: 20, color: '#888', padding: 4 },
  pickerCharInfo: { backgroundColor: '#e8f5e9', borderRadius: 8, padding: 10, marginTop: 10 },
  pickerCharText: { color: '#2e7d32', fontSize: 13 },
  styleRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 13, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: '#f0f0f0' },
  styleRowSelected: { backgroundColor: '#f0f4ff' },
  styleRadio: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: '#bbb', marginRight: 8, justifyContent: 'center', alignItems: 'center' },
  styleRadioSelected: { borderColor: '#6C63FF' },
  styleRadioDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#6C63FF' },
  styleLabel: { fontSize: 14.5, color: '#333', flex: 1 },
  styleLabelSelected: { color: '#6C63FF', fontWeight: '600' },

  // New split layout
  styleListFull: { maxHeight: 340 },
  styleRowFull: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 18, borderBottomWidth: 1, borderBottomColor: '#f0f0f0' },
  styleRowFullLabel: { fontSize: 15, color: '#333', flex: 1 },
  styleRowArrow: { color: '#aaa', fontSize: 18, marginLeft: 6 },

  // Generate collapsible
  generateSection: { borderTopWidth: 1, borderTopColor: '#eee', marginTop: 4 },
  generateToggle: { paddingHorizontal: 16, paddingVertical: 12, backgroundColor: '#f5f5f5' },
  generateToggleTxt: { color: '#075E54', fontWeight: '700', fontSize: 14, textAlign: 'center' },
  generateInner: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 4 },

  genLabel: { fontSize: 13, fontWeight: '600', color: '#444', marginBottom: 8 },
  genInput: { backgroundColor: '#f8f8f8', borderRadius: 10, borderWidth: 1, borderColor: '#ddd', padding: 12, fontSize: 14, color: '#222', minHeight: 60, textAlignVertical: 'top', marginBottom: 8 },
  genBtn: { backgroundColor: '#075E54', borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginBottom: 10 },
  genBtnText: { color: '#fff', fontSize: 16, fontWeight: 'bold' },
  genNote: { fontSize: 12, color: '#888', textAlign: 'center' },
  viewerBg: { flex: 1, backgroundColor: '#000', justifyContent: 'center', alignItems: 'center' },
  viewerClose: { position: 'absolute', top: 50, right: 20, zIndex: 10, padding: 8 },
  viewerCloseText: { color: '#fff', fontSize: 22, fontWeight: 'bold' },
  viewerImg: { width, height: height * 0.72 },

  // Generate button row
  genBtnRow: { flexDirection: 'row', gap: 10, marginBottom: 10 },
  browseBtn: { backgroundColor: '#1565C0' },

  // Cloud browser
  browserBg: { flex: 1, backgroundColor: '#111' },
  browserHeader: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#075E54', paddingHorizontal: 12,
    paddingVertical: 14, paddingTop: 44, gap: 8,
  },
  browserCloseBtn: { padding: 6 },
  browserCloseTxt: { color: '#fff', fontSize: 22, fontWeight: 'bold' },
  browserTitle: { color: '#fff', fontSize: 14, fontWeight: '700', textAlign: 'center' },
  browserCount: { color: '#b2dfdb', fontSize: 13, marginTop: 2 },
  browserSendBtn: { backgroundColor: '#25D366', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  browserSendTxt: { color: '#fff', fontSize: 12, fontWeight: '700' },
  browserPhotoWrap: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#111' },
  browserCenter: { alignItems: 'center', gap: 16 },
  browserLoadingTxt: { color: '#aaa', fontSize: 14, textAlign: 'center', marginTop: 12 },
  browserEmptyIcon: { fontSize: 64 },
  browserEmptyTxt: { color: '#aaa', fontSize: 16, textAlign: 'center', lineHeight: 26 },
  browserPhoto: { width, height: height * 0.62 },
  browserNav: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#1a1a1a', paddingVertical: 14, paddingHorizontal: 12,
  },
  navBtn: {
    backgroundColor: '#333', borderRadius: 10,
    paddingHorizontal: 16, paddingVertical: 10,
  },
  navBtnDisabled: { opacity: 0.3 },
  navBtnTxt: { color: '#fff', fontWeight: '700', fontSize: 14 },
  dotsWrap: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, flex: 1, justifyContent: 'center' },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#555' },
  dotActive: { backgroundColor: '#25D366', width: 12, height: 12, borderRadius: 6 },
  browserActions: {
    flexDirection: 'row', gap: 12, padding: 14,
    backgroundColor: '#1a1a1a', borderTopWidth: 1, borderTopColor: '#333',
  },
  browserActionBtn: {
    flex: 1, backgroundColor: '#075E54', borderRadius: 12,
    paddingVertical: 14, alignItems: 'center',
  },
  browserActionTxt: { color: '#fff', fontWeight: '700', fontSize: 14 },

  // Offline banner
  offlineBanner: { backgroundColor: '#FF6F00', paddingVertical: 4, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  offlineBannerTxt: { color: '#fff', fontSize: 12, fontWeight: '600' },
  offlineBannerCancel: { color: '#FFE082', fontSize: 12, fontWeight: '700', textDecorationLine: 'underline' },

  // Gemma / Offline settings modal
  gemmaSheet: {
    backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: 20, maxHeight: '85%',
  },
  gemmaDivider: { height: 1, backgroundColor: '#eee', marginVertical: 20 },
  gemmaTitle: { fontSize: 16, fontWeight: 'bold', color: '#111', marginBottom: 10 },
  gemmaDesc: { fontSize: 13, color: '#444', lineHeight: 20, marginBottom: 14 },
  gemmaPortHint: { fontWeight: 'bold', color: '#075E54' },
  gemmaPortLabel: { fontSize: 13, fontWeight: '600', color: '#444', marginBottom: 6 },
  gemmaPortInput: {
    borderWidth: 1, borderColor: '#ddd', borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 10,
    fontSize: 18, color: '#111', marginBottom: 16,
    textAlign: 'center', letterSpacing: 2,
  },
  gemmaBtnRow: { flexDirection: 'row', gap: 10 },
  gemmaBtn: {
    flex: 1, backgroundColor: '#075E54', borderRadius: 12,
    paddingVertical: 12, alignItems: 'center',
  },
  gemmaBtnTxt: { color: '#fff', fontWeight: 'bold', fontSize: 15 },

  // WebLLM download UI
  downloadBtn: {
    backgroundColor: '#1565C0', borderRadius: 12,
    paddingVertical: 14, alignItems: 'center', marginBottom: 8,
  },
  downloadBtnTxt: { color: '#fff', fontWeight: 'bold', fontSize: 14, textAlign: 'center' },
  gemmaReady: { backgroundColor: '#e8f5e9', borderRadius: 10, padding: 14, marginBottom: 8 },
  gemmaReadyTxt: { color: '#2e7d32', fontWeight: '600', fontSize: 14 },
  gemmaAlert: { backgroundColor: '#fff3e0', borderRadius: 10, padding: 14, marginBottom: 8 },
  gemmaAlertTxt: { color: '#e65100', fontSize: 13 },
  gemmaProgress: { padding: 4, marginBottom: 8 },
  gemmaProgressTxt: { color: '#444', fontSize: 12, marginBottom: 8, lineHeight: 18 },
  gemmaProgressPct: { color: '#075E54', fontWeight: 'bold', fontSize: 14, textAlign: 'center', marginTop: 4 },
  progressBarBg: { height: 10, backgroundColor: '#e0e0e0', borderRadius: 5, overflow: 'hidden' },
  progressBarFill: { height: 10, backgroundColor: '#1565C0', borderRadius: 5 },
  gemmaErrorBox: { backgroundColor: '#fdecea', borderRadius: 10, padding: 12, marginBottom: 12 },
  gemmaErrorTxt: { color: '#c62828', fontSize: 13, lineHeight: 20 },
  mobileWarnOverlay: {
    ...StyleSheet.absoluteFillObject, zIndex: 300,
    backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', alignItems: 'center', padding: 24,
  },
  mobileWarnBox: { backgroundColor: '#fff', borderRadius: 18, padding: 24, width: '100%' },
  mobileWarnIcon: { fontSize: 36, textAlign: 'center', marginBottom: 10 },
  mobileWarnTitle: { fontSize: 17, fontWeight: 'bold', color: '#111', textAlign: 'center', marginBottom: 10 },
  mobileWarnDesc: { fontSize: 14, color: '#444', lineHeight: 22, marginBottom: 20, textAlign: 'center' },
  mobileWarnBtns: { flexDirection: 'row', gap: 12 },
  mobileWarnCancel: { flex: 1, backgroundColor: '#e0e0e0', borderRadius: 10, paddingVertical: 13, alignItems: 'center' },
  mobileWarnCancelTxt: { color: '#555', fontWeight: '700', fontSize: 14 },
  mobileWarnOk: { flex: 2, backgroundColor: '#1565C0', borderRadius: 10, paddingVertical: 13, alignItems: 'center' },
  mobileWarnOkTxt: { color: '#fff', fontWeight: '800', fontSize: 14 },


  // Add-from-URL
  addUrlBtn: {
    marginTop: 10, backgroundColor: '#e8f5e9', borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 7, borderWidth: 1, borderColor: '#a5d6a7',
  },
  addUrlBtnTxt: { color: '#2e7d32', fontSize: 11, fontWeight: '700' },
  addUrlBox: { width: '100%', paddingHorizontal: 4, marginTop: 8 },
  addUrlInput: {
    backgroundColor: '#fff', borderWidth: 1, borderColor: '#aaa',
    borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6,
    fontSize: 11, color: '#111',
  },
  addUrlSave: {
    flex: 1, backgroundColor: '#075E54', borderRadius: 8,
    paddingVertical: 7, alignItems: 'center',
  },
  addUrlSaveTxt: { color: '#fff', fontWeight: 'bold', fontSize: 14 },
  addUrlCancel: {
    flex: 1, backgroundColor: '#e53935', borderRadius: 8,
    paddingVertical: 7, alignItems: 'center',
  },
  addUrlCancelTxt: { color: '#fff', fontWeight: 'bold', fontSize: 14 },
  addUrlSmallBtn: {
    marginTop: 4, marginHorizontal: 4, backgroundColor: '#f0f0f0', borderRadius: 6,
    paddingVertical: 5, alignItems: 'center', borderWidth: 1, borderColor: '#ddd',
  },
  addUrlSmallBtnTxt: { color: '#555', fontSize: 10, fontWeight: '600' },

  // ── Message action (long-press) ──
  msgActionOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', alignItems: 'center', padding: 28 },
  msgActionBox: { backgroundColor: '#fff', borderRadius: 18, width: '100%', overflow: 'hidden' },
  msgActionPreview: { fontSize: 13, color: '#555', padding: 16, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: '#f0f0f0' },
  msgActionBtn: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 16, paddingHorizontal: 20, borderBottomWidth: 1, borderBottomColor: '#f5f5f5' },
  msgActionDelete: { },
  msgActionIcon: { fontSize: 20 },
  msgActionTxt: { fontSize: 16, fontWeight: '600', color: '#111' },
  msgActionCancel: { paddingVertical: 16, alignItems: 'center' },
  msgActionCancelTxt: { fontSize: 15, color: '#888', fontWeight: '600' },

  // ── Chat Style Sheet ──
  styleSheetOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  styleSheet: { backgroundColor: '#fff', borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 20, maxHeight: '85%' },
  styleSheetHandle: { width: 40, height: 4, backgroundColor: '#ddd', borderRadius: 2, alignSelf: 'center', marginTop: 12, marginBottom: 6 },
  styleSheetTitle: { fontSize: 20, fontWeight: 'bold', color: '#111', marginBottom: 16, marginTop: 4 },
  styleSheetSection: { fontSize: 14, fontWeight: '700', color: '#333', marginBottom: 10, marginTop: 4 },
  styleSheetSub: { fontSize: 12, color: '#888', marginBottom: 8, marginTop: -6 },
  styleSheetClose: { backgroundColor: '#075E54', borderRadius: 14, paddingVertical: 15, alignItems: 'center', marginTop: 16 },
  styleSheetCloseTxt: { color: '#fff', fontSize: 16, fontWeight: 'bold' },

  // ── Wallpaper grid ──
  wallpaperGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 18 },
  wallpaperChip: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 14, borderWidth: 2, borderColor: 'transparent', flexDirection: 'row', alignItems: 'center', gap: 4 },
  wallpaperChipActive: { borderColor: '#075E54' },
  wallpaperChipTxt: { fontSize: 13, fontWeight: '600', color: '#333' },
  wallpaperCheck: { fontSize: 12, color: '#075E54', fontWeight: '900' },

  // ── Bubble style chips ──
  bubbleStyleRow: { flexDirection: 'row', gap: 10, marginBottom: 18 },
  bubbleStyleChip: { flex: 1, paddingVertical: 12, borderRadius: 14, borderWidth: 1.5, borderColor: '#ddd', alignItems: 'center', backgroundColor: '#fafafa' },
  bubbleStyleChipActive: { borderColor: '#075E54', backgroundColor: '#e8f5e9' },
  bubbleStyleTxt: { fontSize: 13, fontWeight: '600', color: '#555' },
  bubbleStyleTxtActive: { color: '#075E54' },

  // ── Birthday ──
  bdayRow: { flexDirection: 'row', gap: 10, marginBottom: 6 },
  bdayInput: { flex: 1, borderWidth: 1.5, borderColor: '#ddd', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, fontSize: 16, color: '#111', letterSpacing: 2 },
  bdaySaveBtn: { backgroundColor: '#075E54', borderRadius: 12, paddingHorizontal: 18, justifyContent: 'center' },
  bdaySaveTxt: { color: '#fff', fontWeight: 'bold', fontSize: 14 },
  bdaySet: { fontSize: 12, color: '#2e7d32', marginBottom: 12 },

  // ── Full-screen viewer prompt button ──
  viewerPromptBtn: {
    position: 'absolute', bottom: 36, alignSelf: 'center',
    backgroundColor: '#6a1b9a', borderRadius: 24,
    paddingHorizontal: 22, paddingVertical: 12,
  },
  viewerPromptTxt: { color: '#fff', fontWeight: 'bold', fontSize: 15 },

  // ── Prompt result modal ──
  promptOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  promptSheet: {
    backgroundColor: '#fff', borderTopLeftRadius: 24, borderTopRightRadius: 24,
    maxHeight: '70%', paddingBottom: 20,
  },
  promptHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    padding: 18, borderBottomWidth: 1, borderBottomColor: '#eee',
  },
  promptTitle: { fontSize: 17, fontWeight: 'bold', color: '#6a1b9a' },
  promptClose: { fontSize: 22, color: '#888' },
  promptLoading: { padding: 40, alignItems: 'center', gap: 14 },
  promptLoadingTxt: { fontSize: 14, color: '#555', textAlign: 'center' },
  promptScroll: { padding: 16, maxHeight: 340 },
  promptText: {
    fontSize: 14, color: '#111', lineHeight: 22,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  promptCopyBtn: {
    marginHorizontal: 16, marginTop: 10,
    backgroundColor: '#6a1b9a', borderRadius: 14,
    paddingVertical: 14, alignItems: 'center',
  },
  promptCopyTxt: { color: '#fff', fontWeight: 'bold', fontSize: 15 },
});
