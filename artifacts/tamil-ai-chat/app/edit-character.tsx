import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, Alert, ActivityIndicator, Image, Modal, Switch,
  Animated, LayoutAnimation, Platform, UIManager,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ImagePicker from 'expo-image-picker';
import { ALL_PERSONAS, BASE_PROMPT, Persona } from '../constants/personas';
import { ParamsStore } from '../context/params-store';
import { uploadToCloudinary } from '../services/api';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

export default function EditCharacterScreen() {
  const router = useRouter();
  const personaId = ParamsStore.getEditPersonaId() ?? '';
  const base = ALL_PERSONAS.find(p => p.id === personaId);

  const [persona, setPersona] = useState<Persona | null>(null);
  const [name, setName] = useState('');
  const [avatarLetter, setAvatarLetter] = useState('');
  const [greeting, setGreeting] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [charOnly, setCharOnly] = useState('');
  const [baseVisible, setBaseVisible] = useState(false);
  const [faceDesc, setFaceDesc] = useState('');
  const [bodyDesc, setBodyDesc] = useState('');
  const [attireDesc, setAttireDesc] = useState('');
  const [avatarPhotoUri, setAvatarPhotoUri] = useState<string | undefined>(undefined);
  const [normalAvatarUri, setNormalAvatarUri] = useState<string | undefined>(undefined);
  const [presanaAvatarUri, setPresanaAvatarUri] = useState<string | undefined>(undefined);
  const [showModeCloud, setShowModeCloud] = useState<'normal' | 'presana' | null>(null);
  const [modeCloudInput, setModeCloudInput] = useState('');
  const [relationship, setRelationship] = useState('');
  const [saving, setSaving] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [showCloudUrl, setShowCloudUrl] = useState(false);
  const [cloudUrlInput, setCloudUrlInput] = useState('');
  const [normalMode, setNormalMode] = useState(false);
  const [presanaBehaviour, setPresanaBehaviour] = useState('');
  const [normalBehaviour, setNormalBehaviour] = useState('');
  const [userWhatsappBeh, setUserWhatsappBeh] = useState('');
  const [userNormalBeh, setUserNormalBeh] = useState('');
  const [userPresanaBeh, setUserPresanaBeh] = useState('');
  const [userBodyDesc, setUserBodyDesc] = useState('');

  // Section B expand state
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [basePromptEdit, setBasePromptEdit] = useState('');

  useEffect(() => {
    const load = async () => {
      if (!base) return;
      try {
        const [saved, moodRaw] = await AsyncStorage.multiGet([
          `persona_edit_${base.id}`,
          `mood_mode_${base.id}`,
        ]);
        const data = saved[1] ? JSON.parse(saved[1]) : {};
        setPersona(base);
        setName(data.name ?? base.name);
        setAvatarLetter(data.avatarLetter ?? base.avatarLetter ?? base.emoji);
        setGreeting(data.greeting ?? base.greeting ?? '');
        const fullPr = data.prompt ?? base.prompt;
        setSystemPrompt(fullPr);
        const mIdx = fullPr.indexOf('**இப்போ உன்னோட character:**');
        setCharOnly(mIdx !== -1 ? fullPr.slice(mIdx + '**இப்போ உன்னோட character:**'.length).trimStart() : fullPr);
        setFaceDesc(data.faceDesc ?? base.faceDesc ?? '');
        setBodyDesc(data.bodyDesc ?? base.bodyDesc ?? '');
        setAttireDesc(data.attireDesc ?? base.attireDesc ?? '');
        setAvatarPhotoUri(data.avatarPhotoUri);
        setNormalAvatarUri(data.normalAvatarUri);
        setPresanaAvatarUri(data.presanaAvatarUri);
        setRelationship(data.relationship ?? base.relationship ?? '');
        setNormalMode(moodRaw[1] === 'normal');
        setPresanaBehaviour(data.presanaBehaviour ?? '');
        setNormalBehaviour(data.normalBehaviour ?? '');
        setUserWhatsappBeh(data.userWhatsappBeh ?? '');
        setUserNormalBeh(data.userNormalBeh ?? '');
        setUserPresanaBeh(data.userPresanaBeh ?? '');
        setUserBodyDesc(data.userBodyDesc ?? '');
        setBasePromptEdit(data.basePromptEdit ?? BASE_PROMPT);
      } catch {}
    };
    load();
  }, [personaId]);

  const toggleNormalMode = async (val: boolean) => {
    setNormalMode(val);
    if (base) {
      await AsyncStorage.setItem(`mood_mode_${base.id}`, val ? 'normal' : 'presana');
    }
  };

  const handleSave = async () => {
    if (!persona) return;
    setSaving(true);
    try {
      const data = {
        name, avatarLetter, greeting, prompt: BASE_PROMPT + '\n**இப்போ உன்னோட character:**\n' + charOnly,
        faceDesc, bodyDesc, attireDesc, avatarPhotoUri,
        normalAvatarUri, presanaAvatarUri, relationship,
        presanaBehaviour, normalBehaviour,
        userWhatsappBeh, userNormalBeh, userPresanaBeh, userBodyDesc,
      };
      await AsyncStorage.setItem(`persona_edit_${persona.id}`, JSON.stringify(data));
      Alert.alert('Saved', `${name} character update ஆச்சு!`);
      router.back();
    } catch {
      Alert.alert('Error', 'Save பண்ண முடியல, retry பண்ணுங்க');
    } finally {
      setSaving(false);
    }
  };

  const pickAvatar = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { Alert.alert('Permission', 'Gallery permission வேணும்'); return; }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.85, allowsEditing: true, aspect: [1, 1], base64: true,
    });
    if (!result.canceled && result.assets[0]) {
      const asset = result.assets[0];
      if (asset.base64) {
        setUploadingAvatar(true);
        try {
          const mime = asset.mimeType || 'image/jpeg';
          const cloudUrl = await uploadToCloudinary(asset.base64, mime, 'my-girls/avatars');
          setAvatarPhotoUri(cloudUrl.url);
        } catch {
          Alert.alert('Upload failed', 'Cloud upload தோல்வி — ☁️ Cloud URL option use பண்ணுங்க');
        } finally {
          setUploadingAvatar(false);
        }
      } else {
        setAvatarPhotoUri(asset.uri);
      }
    }
  };

  const applyCloudUrl = () => {
    if (cloudUrlInput.trim()) setAvatarPhotoUri(cloudUrlInput.trim());
    setShowCloudUrl(false);
  };

  const applyModeCloudUrl = () => {
    const url = modeCloudInput.trim();
    if (!url) { Alert.alert('URL Enter பண்ணுங்க'); return; }
    if (showModeCloud === 'normal') setNormalAvatarUri(url);
    else if (showModeCloud === 'presana') setPresanaAvatarUri(url);
    setModeCloudInput('');
    setShowModeCloud(null);
  };

  const pickModeAvatar = async (mode: 'normal' | 'presana') => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { Alert.alert('Permission', 'Gallery permission வேணும்'); return; }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.85, allowsEditing: true, aspect: [1, 1], base64: true,
    });
    if (!result.canceled && result.assets[0]) {
      const asset = result.assets[0];
      if (asset.base64) {
        setUploadingAvatar(true);
        try {
          const mime = asset.mimeType || 'image/jpeg';
          const cloudUrl = await uploadToCloudinary(asset.base64, mime, 'my-girls/avatars');
          if (mode === 'normal') setNormalAvatarUri(cloudUrl.url);
          else setPresanaAvatarUri(cloudUrl.url);
        } catch {
          Alert.alert('Upload Failed', 'Cloud upload தோல்வி — ☁️ Cloud URL option use பண்ணுங்க');
        } finally { setUploadingAvatar(false); }
      } else {
        if (mode === 'normal') setNormalAvatarUri(asset.uri);
        else setPresanaAvatarUri(asset.uri);
      }
    }
  };

  const Field = ({ label, hint, value, onChange, minH = 60 }: {
    label: string; hint?: string; value: string;
    onChange: (v: string) => void; minH?: number;
  }) => (
    <View style={styles.fieldWrap}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={[styles.fieldInput, { minHeight: minH }]}
        value={value}
        onChangeText={onChange}
        multiline
        textAlignVertical="top"
        placeholderTextColor="#bbb"
      />
      {hint ? <Text style={styles.fieldHint}>{hint}</Text> : null}
    </View>
  );

  if (!persona) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator color="#075E54" />
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <Stack.Screen options={{
        title: 'Edit Character',
        headerStyle: { backgroundColor: '#075E54' },
        headerTintColor: '#fff',
        headerTitleStyle: { fontWeight: 'bold' },
        headerRight: () => (
          <TouchableOpacity onPress={handleSave} disabled={saving} style={{ marginRight: 16 }}>
            {saving
              ? <ActivityIndicator size="small" color="#fff" />
              : <Text style={{ color: '#fff', fontSize: 16, fontWeight: 'bold' }}>Save</Text>
            }
          </TouchableOpacity>
        ),
      }} />
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">

        {/* ── AVATAR ── */}
        <View style={styles.avatarSection}>
          <TouchableOpacity onPress={pickAvatar} style={styles.avatarWrap}>
            {avatarPhotoUri
              ? <Image source={{ uri: avatarPhotoUri }} style={styles.avatarImg} />
              : <View style={[styles.avatarCircle, { backgroundColor: persona.avatarColor }]}>
                  <Text style={styles.avatarEmoji}>{avatarLetter || persona.emoji}</Text>
                </View>
            }
            <View style={styles.cameraOverlay}>
              <Text style={styles.cameraIcon}>📷</Text>
            </View>
          </TouchableOpacity>
          <View style={styles.avatarBtns}>
            <TouchableOpacity style={[styles.uploadBtn, uploadingAvatar && { opacity: 0.6 }]} onPress={pickAvatar} disabled={uploadingAvatar}>
              {uploadingAvatar
                ? <><ActivityIndicator color="#fff" size="small" /><Text style={[styles.uploadBtnText, { marginLeft: 6 }]}>Uploading...</Text></>
                : <Text style={styles.uploadBtnText}>📱 Phone</Text>
              }
            </TouchableOpacity>
            <TouchableOpacity style={[styles.uploadBtn, { backgroundColor: '#1565C0' }]} onPress={() => { setCloudUrlInput(avatarPhotoUri ?? ''); setShowCloudUrl(true); }}>
              <Text style={styles.uploadBtnText}>☁️ Cloud URL</Text>
            </TouchableOpacity>
            {avatarPhotoUri && (
              <TouchableOpacity style={[styles.uploadBtn, { backgroundColor: '#B71C1C' }]} onPress={() => setAvatarPhotoUri(undefined)}>
                <Text style={styles.uploadBtnText}>🗑️ Remove</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>

        {/* Cloud URL modal */}
        <Modal visible={showCloudUrl} transparent animationType="fade">
          <View style={styles.cloudOverlay}>
            <View style={styles.cloudModal}>
              <Text style={styles.cloudTitle}>☁️ Cloud Image URL</Text>
              <Text style={styles.cloudSub}>Cloudinary-ல் இருந்து photo URL paste பண்ணுங்க</Text>
              <TextInput
                style={styles.cloudInput}
                value={cloudUrlInput}
                onChangeText={setCloudUrlInput}
                placeholder="https://res.cloudinary.com/..."
                placeholderTextColor="#aaa"
                autoCapitalize="none"
                autoCorrect={false}
              />
              <View style={styles.cloudBtns}>
                <TouchableOpacity style={styles.cloudCancel} onPress={() => setShowCloudUrl(false)}>
                  <Text style={{ color: '#555', fontWeight: '600' }}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.cloudApply} onPress={applyCloudUrl}>
                  <Text style={{ color: '#fff', fontWeight: '600' }}>Apply</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>

        <Modal visible={showModeCloud !== null} transparent animationType="fade">
          <View style={styles.cloudOverlay}>
            <View style={styles.cloudModal}>
              <Text style={styles.cloudTitle}>
                {showModeCloud === 'normal' ? '😇 Normal Avatar URL' : '😈 Presana Avatar URL'}
              </Text>
              <Text style={styles.cloudSub}>Cloudinary-ல் இருந்து photo URL paste பண்ணுங்க</Text>
              <TextInput
                style={styles.cloudInput}
                value={modeCloudInput}
                onChangeText={setModeCloudInput}
                placeholder="https://res.cloudinary.com/..."
                placeholderTextColor="#aaa"
                autoCapitalize="none"
                autoCorrect={false}
              />
              <View style={styles.cloudBtns}>
                <TouchableOpacity style={styles.cloudCancel} onPress={() => setShowModeCloud(null)}>
                  <Text style={{ color: '#555', fontWeight: '600' }}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.cloudApply} onPress={applyModeCloudUrl}>
                  <Text style={{ color: '#fff', fontWeight: '600' }}>Apply</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>

        {/* ══════════════════════════════════════════
            SECTION A — CHARACTER DETAILS (always visible)
        ══════════════════════════════════════════ */}
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>NAME</Text>
          <TextInput
            style={styles.nameInput}
            value={name}
            onChangeText={setName}
            placeholder="Character பேரு..."
            placeholderTextColor="#bbb"
          />
          <Text style={[styles.sectionLabel, { marginTop: 14 }]}>AVATAR LETTER</Text>
          <TextInput
            style={styles.nameInput}
            value={avatarLetter}
            onChangeText={setAvatarLetter}
            placeholder="ஒரு எழுத்து (e.g. க, ப, த)"
            placeholderTextColor="#bbb"
            maxLength={2}
          />
          <Text style={[styles.sectionLabel, { marginTop: 14 }]}>RELATIONSHIP</Text>
          <TextInput
            style={styles.nameInput}
            value={relationship}
            onChangeText={setRelationship}
            placeholder="e.g. மனைவி, தோழி, மாமியார், அக்கா, முன்னாள் காதலி..."
            placeholderTextColor="#bbb"
          />
        </View>

        {/* ══════════════════════════════════════════
            USER BEHAVIOUR — how user acts with THIS character
        ══════════════════════════════════════════ */}
        <View style={styles.card}>
          <Text style={[styles.sectionLabel, { color: '#1565C0', marginBottom: 8 }]}>👤 USER — இந்த CHARACTER கிட்ட எப்படி நடந்துக்கணும்</Text>
          <Text style={styles.fieldHint}>ஒவ்வொரு mode-லயும் user எப்படி பேசுவாரு, எப்படி feel ஆவாரு என்று சொல்லுங்க — AI அதுக்கு ஏத்த மாதிரி character react பண்ணும்.</Text>

          {/* WhatsApp mode */}
          <Text style={[styles.sectionLabel, { color: '#25D366', marginTop: 12, marginBottom: 4 }]}>💬 WhatsApp Mode — User Style</Text>
          <TextInput
            style={[styles.fieldInput, { minHeight: 56 }]}
            value={userWhatsappBeh}
            onChangeText={setUserWhatsappBeh}
            multiline
            textAlignVertical="top"
            placeholder="e.g. User casual-ஆ, short-ஆ பேசுவாரு. Fun jokes போடுவாரு. Quick replies expect பண்ணுவாரு."
            placeholderTextColor="#bbb"
          />

          {/* Normal mode */}
          <Text style={[styles.sectionLabel, { color: '#075E54', marginTop: 10, marginBottom: 4 }]}>😇 Normal Mode — User Style</Text>
          <TextInput
            style={[styles.fieldInput, { minHeight: 56 }]}
            value={userNormalBeh}
            onChangeText={setUserNormalBeh}
            multiline
            textAlignVertical="top"
            placeholder="e.g. User romantic-ஆ, double meaning-ஆ பேசுவாரு. Emotional-ஆ feel ஆவாரு."
            placeholderTextColor="#bbb"
          />

          {/* Presana mode */}
          <Text style={[styles.sectionLabel, { color: '#E91E63', marginTop: 10, marginBottom: 4 }]}>😈 Presana Mode — User Style</Text>
          <TextInput
            style={[styles.fieldInput, { minHeight: 56 }]}
            value={userPresanaBeh}
            onChangeText={setUserPresanaBeh}
            multiline
            textAlignVertical="top"
            placeholder="e.g. User bold-ஆ, explicit-ஆ, direct-ஆ பேசுவாரு. Dominate பண்ண விரும்புவாரு."
            placeholderTextColor="#bbb"
          />

          {/* User body description */}
          <Text style={[styles.sectionLabel, { color: '#6D4C41', marginTop: 10, marginBottom: 4 }]}>🧍 User உருவம் / Body Description</Text>
          <TextInput
            style={[styles.fieldInput, { minHeight: 72 }]}
            value={userBodyDesc}
            onChangeText={setUserBodyDesc}
            multiline
            textAlignVertical="top"
            placeholder="e.g. User 30 வயது, medium height, athletic build, dark skin. Character இதை அறிஞ்சு interact பண்ணும்."
            placeholderTextColor="#bbb"
          />
        </View>

        {/* MOOD / BEHAVIOUR — visible */}
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>MOOD / BEHAVIOUR</Text>
          <View style={styles.moodRow}>
            <View style={styles.moodInfo}>
              <Text style={styles.moodTitle}>
                {normalMode ? '😇 Normal Mode' : '😈 Presana Mode'}
              </Text>
              <Text style={styles.moodSub}>
                {normalMode
                  ? 'Friendly-ஆ, clean-ஆ, professional-ஆ பேசுவாங்க'
                  : (presanaBehaviour.trim() ? presanaBehaviour.trim() : 'Flirty, romantic, playful-ஆ பேசுவாங்க (default)')}
              </Text>
            </View>
            <Switch
              value={normalMode}
              onValueChange={toggleNormalMode}
              trackColor={{ false: '#E91E63', true: '#075E54' }}
              thumbColor="#fff"
            />
          </View>
          <View style={styles.moodBadgeRow}>
            <TouchableOpacity
              style={[styles.moodBadge, !normalMode && styles.moodBadgeActive]}
              onPress={() => toggleNormalMode(false)}
            >
              <Text style={[styles.moodBadgeTxt, !normalMode && { color: '#fff' }]}>😈 Presana</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.moodBadge, normalMode && { backgroundColor: '#075E54', borderColor: '#075E54' }]}
              onPress={() => toggleNormalMode(true)}
            >
              <Text style={[styles.moodBadgeTxt, normalMode && { color: '#fff' }]}>😇 Normal</Text>
            </TouchableOpacity>
          </View>

          {/* Presana behaviour — visible */}
          <View style={{ marginTop: 14 }}>
            <Text style={[styles.sectionLabel, { color: '#E91E63', marginBottom: 4 }]}>😈 PRESANA MODE — BEHAVIOUR TEXT</Text>
            <Text style={{ color: '#888', fontSize: 11, marginBottom: 6 }}>இந்த character presana mode-ல எப்படி பேசணும்னு customize பண்ணுங்க.</Text>
            <TextInput
              style={[styles.fieldInput, { minHeight: 80 }]}
              value={presanaBehaviour}
              onChangeText={setPresanaBehaviour}
              multiline
              textAlignVertical="top"
              scrollEnabled={false}
              placeholder="எல்லாமே opena pesalam adult contact ellame kettavarthai solli kuda kupidalam"
              placeholderTextColor="#bbb"
            />
          </View>

          {/* Normal behaviour — visible */}
          <View style={{ marginTop: 12 }}>
            <Text style={[styles.sectionLabel, { color: '#075E54', marginBottom: 4 }]}>😇 NORMAL MODE — BEHAVIOUR TEXT</Text>
            <Text style={{ color: '#888', fontSize: 11, marginBottom: 6 }}>Normal mode-ல எப்படி பேசணும்னு customize பண்ணுங்க.</Text>
            <TextInput
              style={[styles.fieldInput, { minHeight: 80 }]}
              value={normalBehaviour}
              onChangeText={setNormalBehaviour}
              multiline
              textAlignVertical="top"
              scrollEnabled={false}
              placeholder="sexy double meaning pesu mamanarkuda old and young lover mathri pesanum but velipadaiya irukka kudathu"
              placeholderTextColor="#bbb"
            />
          </View>

          <Text style={{ color: '#888', fontSize: 11, marginTop: 8 }}>💡 Save பண்ணா chat-ல உடனே apply ஆகும்.</Text>
        </View>

        {/* ══════════════════════════════════════════
            SECTION B — ⚙️ அமைப்புகள் (tap to expand)
        ══════════════════════════════════════════ */}
        <TouchableOpacity
          style={styles.advancedHeader}
          onPress={() => {
            LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
            setAdvancedOpen(v => !v);
          }}
          activeOpacity={0.8}
        >
          <Text style={styles.advancedHeaderTxt}>⚙️ மேல் அமைப்புகள்</Text>
          <Text style={styles.advancedChevron}>{advancedOpen ? '▲' : '▼'}</Text>
        </TouchableOpacity>

        {advancedOpen && (
          <View style={styles.advancedBody}>

            {/* GREETING */}
            <View style={styles.card}>
              <Text style={styles.sectionLabel}>GREETING (FIRST MESSAGE)</Text>
              <TextInput
                style={[styles.fieldInput, { minHeight: 80 }]}
                value={greeting}
                onChangeText={setGreeting}
                multiline
                textAlignVertical="top"
                placeholder="Character-ஓட first message..."
                placeholderTextColor="#bbb"
              />
            </View>

            {/* SYSTEM PROMPT — split: RED (base rules) + GREEN (char-specific) */}
            <View style={styles.card}>
              <Text style={styles.sectionLabel}>SYSTEM PROMPT (CHARACTER BEHAVIOR)</Text>

              {/* 🔴 RED — BASE RULES (collapsible) */}
              <View style={{ borderWidth: 2, borderColor: '#e53935', borderRadius: 8, marginBottom: 10, overflow: 'hidden' }}>
                <TouchableOpacity
                  onPress={() => setBaseVisible(v => !v)}
                  style={{ backgroundColor: '#ffeaea', paddingHorizontal: 12, paddingVertical: 8, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
                  activeOpacity={0.85}
                >
                  <Text style={{ color: '#c62828', fontWeight: '700', fontSize: 12 }}>🔴 BASE RULES (All characters)</Text>
                  <Text style={{ color: '#c62828', fontSize: 13, fontWeight: '700' }}>{baseVisible ? '▲ மூடு' : '▼ திற'}</Text>
                </TouchableOpacity>
                {baseVisible && (
                  <View style={{ backgroundColor: '#fff5f5' }}>
                    <Text style={{ color: '#388e3c', fontSize: 10, paddingHorizontal: 10, paddingTop: 6 }}>✏️ Long-press → Cut / Copy / Paste / Select All</Text>
                    <TextInput
                      style={[styles.fieldInput, { minHeight: 200, borderWidth: 0, borderRadius: 0, backgroundColor: '#fff5f5', fontSize: 11, lineHeight: 18, color: '#555' }]}
                      value={basePromptEdit}
                      onChangeText={setBasePromptEdit}
                      multiline
                      textAlignVertical="top"
                      editable={true}
                      selectTextOnFocus={false}
                      contextMenuHidden={false}
                      scrollEnabled={false}
                      autoCorrect={false}
                      autoCapitalize="none"
                      spellCheck={false}
                    />
                    <TouchableOpacity
                      onPress={() => setBasePromptEdit(BASE_PROMPT)}
                      style={{ margin: 8, paddingVertical: 6, paddingHorizontal: 14, backgroundColor: '#ffcdd2', borderRadius: 12, alignSelf: 'flex-start' }}
                    >
                      <Text style={{ color: '#c62828', fontSize: 11, fontWeight: '600' }}>↺ Default-க்கு Reset</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>

              {/* 🟢 GREEN — CHARACTER-SPECIFIC (always visible, editable) */}
              <View style={{ borderWidth: 2, borderColor: '#2e7d32', borderRadius: 8, overflow: 'hidden' }}>
                <View style={{ backgroundColor: '#e8f5e9', paddingHorizontal: 12, paddingVertical: 8 }}>
                  <Text style={{ color: '#1b5e20', fontWeight: '700', fontSize: 12 }}>🟢 இந்த CHARACTER மட்டும் (திருத்தலாம்)</Text>
                  <Text style={{ color: '#388e3c', fontSize: 10, marginTop: 2 }}>✏️ Long-press → Cut / Copy / Paste / Select All</Text>
                </View>
                <TextInput
                  style={[styles.fieldInput, { minHeight: 200, borderWidth: 0, borderRadius: 0, backgroundColor: '#f9fff9' }]}
                  value={charOnly}
                  onChangeText={setCharOnly}
                  multiline
                  textAlignVertical="top"
                  editable={true}
                  selectTextOnFocus={false}
                  contextMenuHidden={false}
                  scrollEnabled={false}
                  autoCorrect={false}
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="இந்த character-ஓட தனித்துவமான behavior, story, personality..."
                  placeholderTextColor="#bbb"
                />
              </View>
            </View>

            {/* MODE AVATARS */}
            <View style={styles.card}>
              <Text style={styles.sectionLabel}>MODE AVATARS</Text>
              <Text style={{ color: '#888', fontSize: 11, marginBottom: 14 }}>Normal mode-ல் வேற photo, Presana mode-ல் வேற photo. Empty விட்டா main avatar use ஆகும்.</Text>
              <View style={styles.modeAvatarRow}>
                <View style={{ flex: 1, alignItems: 'center' }}>
                  <Text style={[styles.sectionLabel, { color: '#075E54', marginBottom: 8 }]}>😇 NORMAL</Text>
                  <TouchableOpacity onPress={() => pickModeAvatar('normal')}>
                    {normalAvatarUri
                      ? <Image source={{ uri: normalAvatarUri }} style={styles.modeAvatarImg} />
                      : <View style={[styles.modeAvatarPlaceholder, { borderColor: '#075E54' }]}>
                          <Text style={{ fontSize: 28 }}>😇</Text>
                          <Text style={{ fontSize: 10, color: '#075E54', marginTop: 4 }}>Tap to set</Text>
                        </View>
                    }
                  </TouchableOpacity>
                  {normalAvatarUri && (
                    <TouchableOpacity style={[styles.modeRemoveBtn, { borderColor: '#075E54' }]} onPress={() => setNormalAvatarUri(undefined)}>
                      <Text style={{ color: '#075E54', fontSize: 12 }}>🗑️ Remove</Text>
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity
                    style={{ marginTop: 8, paddingVertical: 5, paddingHorizontal: 10, backgroundColor: '#E3F2FD', borderRadius: 12 }}
                    onPress={() => { setModeCloudInput(''); setShowModeCloud('normal'); }}
                  >
                    <Text style={{ color: '#1565C0', fontSize: 11, fontWeight: '600' }}>☁️ Cloud URL</Text>
                  </TouchableOpacity>
                </View>
                <View style={{ flex: 1, alignItems: 'center' }}>
                  <Text style={[styles.sectionLabel, { color: '#E91E63', marginBottom: 8 }]}>😈 PRESANA</Text>
                  <TouchableOpacity onPress={() => pickModeAvatar('presana')}>
                    {presanaAvatarUri
                      ? <Image source={{ uri: presanaAvatarUri }} style={styles.modeAvatarImg} />
                      : <View style={[styles.modeAvatarPlaceholder, { borderColor: '#E91E63' }]}>
                          <Text style={{ fontSize: 28 }}>😈</Text>
                          <Text style={{ fontSize: 10, color: '#E91E63', marginTop: 4 }}>Tap to set</Text>
                        </View>
                    }
                  </TouchableOpacity>
                  {presanaAvatarUri && (
                    <TouchableOpacity style={[styles.modeRemoveBtn, { borderColor: '#E91E63' }]} onPress={() => setPresanaAvatarUri(undefined)}>
                      <Text style={{ color: '#E91E63', fontSize: 12 }}>🗑️ Remove</Text>
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity
                    style={{ marginTop: 8, paddingVertical: 5, paddingHorizontal: 10, backgroundColor: '#FCE4EC', borderRadius: 12 }}
                    onPress={() => { setModeCloudInput(''); setShowModeCloud('presana'); }}
                  >
                    <Text style={{ color: '#C62828', fontSize: 11, fontWeight: '600' }}>☁️ Cloud URL</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>

            {/* IMAGE GENERATION DETAILS */}
            <View style={styles.card}>
              <Text style={styles.sectionLabel}>IMAGE GENERATION DETAILS</Text>
              <Field label="A. முக அமைப்பு (FACE)" value={faceDesc} onChange={setFaceDesc} hint="e.g. beautiful Tamil woman, 24 years old, long wavy black hair..." minH={80} />
              <View style={styles.divider} />
              <Field label="B. உடல் அமைப்பு (BODY)" value={bodyDesc} onChange={setBodyDesc} hint="e.g. slim curvy figure, natural proportioned..." minH={60} />
              <View style={styles.divider} />
              <Field label="C. உடை (ATTIRE)" value={attireDesc} onChange={setAttireDesc} hint="e.g. casual salwar or jeans and top..." minH={80} />
            </View>

          </View>
        )}

        <Text style={styles.footerNote}>
          This is a built-in character. Your edits are saved locally.
        </Text>

        <TouchableOpacity style={styles.saveBtn} onPress={handleSave} disabled={saving}>
          {saving
            ? <ActivityIndicator color="#fff" />
            : <Text style={styles.saveBtnText}>Save Character</Text>
          }
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f0f2f5' },
  scroll: { flex: 1 },
  content: { padding: 12, paddingBottom: 50 },
  avatarSection: { alignItems: 'center', paddingVertical: 20 },
  avatarWrap: { position: 'relative', marginBottom: 12 },
  avatarCircle: { width: 100, height: 100, borderRadius: 50, justifyContent: 'center', alignItems: 'center' },
  avatarImg: { width: 100, height: 100, borderRadius: 50 },
  avatarEmoji: { color: '#fff', fontSize: 36, fontWeight: 'bold' },
  cameraOverlay: { position: 'absolute', bottom: 2, right: 2, backgroundColor: '#333', borderRadius: 14, width: 28, height: 28, justifyContent: 'center', alignItems: 'center' },
  cameraIcon: { fontSize: 14 },
  avatarBtns: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', justifyContent: 'center' },
  uploadBtn: { backgroundColor: '#075E54', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20 },
  uploadBtnText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  cloudOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  cloudModal: { backgroundColor: '#fff', borderRadius: 16, padding: 20, width: '100%' },
  cloudTitle: { fontSize: 17, fontWeight: 'bold', color: '#1565C0', marginBottom: 6 },
  cloudSub: { fontSize: 12, color: '#888', marginBottom: 14 },
  cloudInput: { borderWidth: 1, borderColor: '#ddd', borderRadius: 10, padding: 10, fontSize: 13, color: '#222', backgroundColor: '#f8f9fa', marginBottom: 16 },
  cloudBtns: { flexDirection: 'row', gap: 10, justifyContent: 'flex-end' },
  cloudCancel: { paddingHorizontal: 18, paddingVertical: 10, borderRadius: 20, backgroundColor: '#f0f0f0' },
  cloudApply: { paddingHorizontal: 18, paddingVertical: 10, borderRadius: 20, backgroundColor: '#1565C0' },
  card: { backgroundColor: '#fff', borderRadius: 12, padding: 16, marginBottom: 14, elevation: 2 },
  sectionLabel: { fontSize: 10, fontWeight: '700', color: '#888', letterSpacing: 0.8, marginBottom: 8 },
  nameInput: { backgroundColor: '#f8f9fa', borderRadius: 8, borderWidth: 1, borderColor: '#e0e0e0', padding: 10, fontSize: 15, color: '#111' },
  fieldWrap: { marginBottom: 4 },
  fieldLabel: { fontSize: 11, fontWeight: '700', color: '#555', marginBottom: 6, marginTop: 4 },
  fieldInput: { backgroundColor: '#f8f9fa', borderRadius: 8, borderWidth: 1, borderColor: '#e0e0e0', padding: 10, fontSize: 14, color: '#222', lineHeight: 20 },
  fieldHint: { fontSize: 11, color: '#aaa', marginTop: 4, marginBottom: 4, lineHeight: 16 },
  divider: { height: 1, backgroundColor: '#f0f0f0', marginVertical: 14 },
  footerNote: { fontSize: 12, color: '#888', textAlign: 'center', paddingHorizontal: 20, marginBottom: 16, lineHeight: 18 },
  saveBtn: { backgroundColor: '#075E54', borderRadius: 12, paddingVertical: 16, alignItems: 'center' },
  saveBtnText: { color: '#fff', fontSize: 16, fontWeight: 'bold' },
  moodRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  moodInfo: { flex: 1, marginRight: 12 },
  moodTitle: { fontSize: 16, fontWeight: '700', color: '#111', marginBottom: 3 },
  moodSub: { fontSize: 12, color: '#888', lineHeight: 17 },
  moodBadgeRow: { flexDirection: 'row', gap: 10 },
  moodBadge: { flex: 1, paddingVertical: 10, borderRadius: 20, borderWidth: 1.5, borderColor: '#ddd', alignItems: 'center' },
  moodBadgeActive: { backgroundColor: '#E91E63', borderColor: '#E91E63' },
  moodBadgeTxt: { fontSize: 14, fontWeight: '700', color: '#555' },
  modeAvatarRow: { flexDirection: 'row', gap: 12 },
  modeAvatarImg: { width: 90, height: 90, borderRadius: 45, borderWidth: 2, borderColor: '#ddd' },
  modeAvatarPlaceholder: { width: 90, height: 90, borderRadius: 45, borderWidth: 2, borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center', backgroundColor: '#fafafa' },
  modeRemoveBtn: { marginTop: 8, paddingHorizontal: 12, paddingVertical: 5, borderRadius: 14, borderWidth: 1 },
  advancedHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#fff', borderRadius: 12, padding: 16, marginBottom: 14, elevation: 2, borderWidth: 1.5, borderColor: '#075E54' },
  advancedHeaderTxt: { fontSize: 15, fontWeight: '700', color: '#075E54' },
  advancedChevron: { fontSize: 14, color: '#075E54', fontWeight: '700' },
  advancedBody: { marginBottom: 4 },
});
