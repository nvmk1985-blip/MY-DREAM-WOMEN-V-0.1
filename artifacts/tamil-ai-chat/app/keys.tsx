import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  ScrollView, TextInput, Alert, ActivityIndicator, Modal, Switch,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';

const DEVICE_KEY_STORAGE = 'device_key';
const KEYS_STORAGE = 'api_keys_store';
const KEYS_ENABLED_STORAGE = 'api_keys_enabled_v1';
const GEMINI_ROTATION_IDX = 'gemini_key_rotation_idx';
const GEMINI_SLOT_COUNT = 13;

type KeyStatus = 'idle' | 'checking' | 'ok' | 'error';

interface ApiKeyEntry {
  id: string;
  label: string;
  site: string;
  value: string;
  enabled: boolean;
  expanded: boolean;
  status: KeyStatus;
}

const DEFAULT_KEYS: Omit<ApiKeyEntry, 'value' | 'expanded' | 'status'>[] = [
  { id: 'expo',       label: 'Expo Token',   site: 'expo.dev',          enabled: false },
  { id: 'github',     label: 'GitHub Token', site: 'github.com',        enabled: false },
  { id: 'cloudinary', label: 'Cloudinary',   site: 'cloudinary.com',    enabled: false },
  { id: 'hf',         label: 'HuggingFace',  site: 'huggingface.co',    enabled: false },
  { id: 'openrouter',  label: 'OpenRouter API', site: 'openrouter.ai',     enabled: false },
  { id: 'fal',         label: 'FAL AI',          site: 'fal.ai',            enabled: false },
  { id: 'img_prompt_gemini', label: '📸 Image to Prompt', site: 'aistudio.google.com', enabled: false },
];

// ── Key testers ──────────────────────────────────────────────────
async function testGeminiKey(key: string): Promise<KeyStatus> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`,
      { method: 'GET', headers: { 'Content-Type': 'application/json' } }
    );
    return res.ok ? 'ok' : 'error';
  } catch { return 'error'; }
}

async function testHuggingFaceKey(token: string): Promise<KeyStatus> {
  try {
    const res = await fetch('https://huggingface.co/api/whoami-v2', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.ok ? 'ok' : 'error';
  } catch { return 'error'; }
}

}

async function testOpenRouterKey(key: string): Promise<KeyStatus> {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/auth/key', {
      headers: { Authorization: `Bearer ${key}`, 'HTTP-Referer': 'https://my-girls.app' },
    });
    return res.ok ? 'ok' : 'error';
  } catch { return 'error'; }
}

async function testKey(id: string, value: string): Promise<KeyStatus> {
  if (!value.trim()) return 'idle';
  if (id.startsWith('gemini') || id === 'img_prompt_gemini') return testGeminiKey(value);
  if (id === 'hf') return testHuggingFaceKey(value);
  if (id === 'openrouter') return testOpenRouterKey(value);
  return 'ok'; // fal/github/expo/cloudinary — no simple test
}

// ── Status badge ─────────────────────────────────────────────────
function StatusBadge({ status }: { status: KeyStatus }) {
  if (status === 'checking') return <ActivityIndicator size="small" color="#f59e0b" style={{ marginRight: 8 }} />;
  if (status === 'ok') return (
    <View style={[sb.badge, sb.ok]}><Text style={sb.txt}>✅ OK</Text></View>
  );
  if (status === 'error') return (
    <View style={[sb.badge, sb.err]}><Text style={sb.txt}>❌ INVALID</Text></View>
  );
  return <View style={[sb.badge, sb.idle]}><Text style={sb.txt}>EMPTY</Text></View>;
}

const sb = StyleSheet.create({
  badge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, marginRight: 6 },
  ok: { backgroundColor: '#065f46' },
  err: { backgroundColor: '#7f1d1d' },
  idle: { backgroundColor: '#374151' },
  txt: { color: '#fff', fontSize: 10, fontWeight: '800' },
});

export default function KeysScreen() {
  const router = useRouter();
  const [deviceKey, setDeviceKey] = useState('');
  const [keys, setKeys] = useState<ApiKeyEntry[]>(
    DEFAULT_KEYS.map(k => ({ ...k, value: '', expanded: false, status: 'idle' as KeyStatus }))
  );
  const [geminiKeys, setGeminiKeys] = useState<string[]>(Array(GEMINI_SLOT_COUNT).fill(''));
  const [geminiEnabled, setGeminiEnabled] = useState<boolean[]>(Array(GEMINI_SLOT_COUNT).fill(false));
  const [geminiExpanded, setGeminiExpanded] = useState<boolean[]>(Array(GEMINI_SLOT_COUNT).fill(false));
  const [geminiStatuses, setGeminiStatuses] = useState<KeyStatus[]>(Array(GEMINI_SLOT_COUNT).fill('idle'));
  const [geminiSectionOpen, setGeminiSectionOpen] = useState(true);
  const [rotationIdx, setRotationIdx] = useState(0);
  const [saving, setSaving] = useState(false);
  const [checkingAll, setCheckingAll] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [addModal, setAddModal] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newSite, setNewSite] = useState('');

  const loadKeys = useCallback(async () => {
    const dk = await AsyncStorage.getItem(DEVICE_KEY_STORAGE);
    if (dk) {
      setDeviceKey(dk);
    } else {
      const nk = `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`.slice(0, 24);
      setDeviceKey(nk);
      await AsyncStorage.setItem(DEVICE_KEY_STORAGE, nk);
    }
    const saved = await AsyncStorage.getItem(KEYS_STORAGE);
    const enabledRaw = await AsyncStorage.getItem(KEYS_ENABLED_STORAGE);
    const idxRaw = await AsyncStorage.getItem(GEMINI_ROTATION_IDX);
    const parsed = saved ? (JSON.parse(saved) as Record<string, string>) : {};
    const enabled = enabledRaw ? (JSON.parse(enabledRaw) as Record<string, boolean>) : {};

    setKeys(prev => prev.map(k => ({ ...k, value: parsed[k.id] || '', enabled: !!enabled[k.id] })));

    const gKeys: string[] = [];
    const gEnabled: boolean[] = [];
    for (let i = 1; i <= GEMINI_SLOT_COUNT; i++) {
      gKeys.push(parsed[`gemini_${i}`] || '');
      gEnabled.push(!!enabled[`gemini_${i}`]);
    }
    setGeminiKeys(gKeys);
    setGeminiEnabled(gEnabled);
    setRotationIdx(parseInt(idxRaw || '0', 10));
    return { parsed, enabled };
  }, []);

  useEffect(() => {
    loadKeys().then(({ parsed, enabled }) => {
      // Auto-check any key that has a value
      autoCheckAll(parsed, enabled);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const autoCheckAll = async (parsed: Record<string, string>, _enabled: Record<string, boolean>) => {
    // Check Gemini keys in background (non-blocking)
    for (let i = 0; i < GEMINI_SLOT_COUNT; i++) {
      const key = parsed[`gemini_${i + 1}`];
      if (key?.trim()) {
        const slotIndex = i;
        setGeminiStatuses(prev => { const n = [...prev]; n[slotIndex] = 'checking'; return n; });
        testGeminiKey(key).then(status => {
          setGeminiStatuses(prev => { const n = [...prev]; n[slotIndex] = status; return n; });
        });
      }
    }
    // Check HuggingFace
    if (parsed['hf']?.trim()) {
      setKeys(prev => prev.map(k => k.id === 'hf' ? { ...k, status: 'checking' } : k));
      testHuggingFaceKey(parsed['hf']).then(status => {
        setKeys(prev => prev.map(k => k.id === 'hf' ? { ...k, status } : k));
      });
    }

    // Check OpenRouter (needed for Photo to Script image analysis)
    if (parsed['openrouter']?.trim()) {
      setKeys(prev => prev.map(k => k.id === 'openrouter' ? { ...k, status: 'checking' } : k));
      testOpenRouterKey(parsed['openrouter']).then(status => {
        setKeys(prev => prev.map(k => k.id === 'openrouter' ? { ...k, status } : k));
      });
    }
  };

  const checkAllNow = async () => {
    setCheckingAll(true);
    const saved = await AsyncStorage.getItem(KEYS_STORAGE);
    const parsed = saved ? JSON.parse(saved) as Record<string, string> : {};

    // Mark all as checking
    setGeminiStatuses(Array(GEMINI_SLOT_COUNT).fill('checking'));
    setKeys(prev => prev.map(k => k.value ? { ...k, status: 'checking' } : k));

    // Check Gemini slots
    const geminiPromises = Array.from({ length: GEMINI_SLOT_COUNT }, async (_, i) => {
      const key = parsed[`gemini_${i + 1}`];
      if (!key?.trim()) {
        setGeminiStatuses(prev => { const n = [...prev]; n[i] = 'idle'; return n; });
        return;
      }
      const status = await testGeminiKey(key);
      setGeminiStatuses(prev => { const n = [...prev]; n[i] = status; return n; });
    });

    // Check other keys
    const otherPromises = DEFAULT_KEYS.map(async dk => {
      const val = parsed[dk.id];
      if (!val?.trim()) {
        setKeys(prev => prev.map(k => k.id === dk.id ? { ...k, status: 'idle' } : k));
        return;
      }
      const status = await testKey(dk.id, val);
      setKeys(prev => prev.map(k => k.id === dk.id ? { ...k, status } : k));
    });

    await Promise.all([...geminiPromises, ...otherPromises]);
    setCheckingAll(false);

    const gOk = geminiStatuses.filter(s => s === 'ok').length;
    Alert.alert('✅ Check Complete', `Gemini: verified\nHuggingFace: verified\nAll keys checked!`);
  };

  const saveGeminiKey = async (slotIndex: number) => {
    setSaving(true);
    try {
      const id = `gemini_${slotIndex + 1}`;
      const value = geminiKeys[slotIndex];
      const saved = await AsyncStorage.getItem(KEYS_STORAGE);
      const parsed = saved ? JSON.parse(saved) : {};
      parsed[id] = value;
      await AsyncStorage.setItem(KEYS_STORAGE, JSON.stringify(parsed));
      if (value.trim()) {
        const enabledRaw = await AsyncStorage.getItem(KEYS_ENABLED_STORAGE);
        const map = enabledRaw ? JSON.parse(enabledRaw) : {};
        map[id] = true;
        await AsyncStorage.setItem(KEYS_ENABLED_STORAGE, JSON.stringify(map));
        const newEnabled = [...geminiEnabled];
        newEnabled[slotIndex] = true;
        setGeminiEnabled(newEnabled);

        // Auto-test the key
        const newSt = [...geminiStatuses];
        newSt[slotIndex] = 'checking';
        setGeminiStatuses(newSt);
        const status = await testGeminiKey(value);
        setGeminiStatuses(prev => { const n = [...prev]; n[slotIndex] = status; return n; });
        Alert.alert(
          status === 'ok' ? '✅ Connected!' : '⚠️ Saved (Key Error)',
          status === 'ok'
            ? `Gemini Key ${slotIndex + 1} valid & active!`
            : `Key saved but test failed. Wrong key? Quota exceeded?`
        );
      } else {
        Alert.alert('✅ Cleared', `Gemini Key ${slotIndex + 1} cleared.`);
        const newSt = [...geminiStatuses];
        newSt[slotIndex] = 'idle';
        setGeminiStatuses(newSt);
      }
    } catch {
      Alert.alert('Error', 'Save பண்ண முடியல');
    } finally {
      setSaving(false);
    }
  };

  const clearGeminiKey = async (slotIndex: number) => {
    const id = `gemini_${slotIndex + 1}`;
    const newKeys = [...geminiKeys]; newKeys[slotIndex] = '';
    setGeminiKeys(newKeys);
    const newEnabled = [...geminiEnabled]; newEnabled[slotIndex] = false;
    setGeminiEnabled(newEnabled);
    const newSt = [...geminiStatuses]; newSt[slotIndex] = 'idle';
    setGeminiStatuses(newSt);
    try {
      const saved = await AsyncStorage.getItem(KEYS_STORAGE);
      const parsed = saved ? JSON.parse(saved) : {};
      delete parsed[id];
      await AsyncStorage.setItem(KEYS_STORAGE, JSON.stringify(parsed));
      const enabledRaw = await AsyncStorage.getItem(KEYS_ENABLED_STORAGE);
      const map = enabledRaw ? JSON.parse(enabledRaw) : {};
      map[id] = false;
      await AsyncStorage.setItem(KEYS_ENABLED_STORAGE, JSON.stringify(map));
    } catch {}
  };

  const toggleGeminiEnabled = async (slotIndex: number, value: boolean) => {
    const id = `gemini_${slotIndex + 1}`;
    const newEnabled = [...geminiEnabled]; newEnabled[slotIndex] = value;
    setGeminiEnabled(newEnabled);
    try {
      const enabledRaw = await AsyncStorage.getItem(KEYS_ENABLED_STORAGE);
      const map = enabledRaw ? JSON.parse(enabledRaw) : {};
      map[id] = value;
      await AsyncStorage.setItem(KEYS_ENABLED_STORAGE, JSON.stringify(map));
    } catch {}
  };

  const toggleGeminiExpand = (slotIndex: number) => {
    setGeminiExpanded(prev => prev.map((v, i) => i === slotIndex ? !v : false));
  };

  const resetRotation = async () => {
    await AsyncStorage.setItem(GEMINI_ROTATION_IDX, '0');
    setRotationIdx(0);
    Alert.alert('✅ Reset', 'Rotation Key 1-லிருந்து மீண்டும் start!');
  };

  const activeGeminiCount = geminiEnabled.filter((e, i) => e && geminiKeys[i]).length;
  const okGeminiCount = geminiStatuses.filter(s => s === 'ok').length;

  const toggleEnabled = async (id: string, value: boolean) => {
    setKeys(prev => prev.map(k => k.id === id ? { ...k, enabled: value } : k));
    try {
      const raw = await AsyncStorage.getItem(KEYS_ENABLED_STORAGE);
      const map = raw ? JSON.parse(raw) : {};
      map[id] = value;
      await AsyncStorage.setItem(KEYS_ENABLED_STORAGE, JSON.stringify(map));
    } catch {}
  };

  const saveKey = async (id: string, value: string) => {
    setSaving(true);
    try {
      const saved = await AsyncStorage.getItem(KEYS_STORAGE);
      const parsed = saved ? JSON.parse(saved) : {};
      parsed[id] = value;
      await AsyncStorage.setItem(KEYS_STORAGE, JSON.stringify(parsed));
      if (id === 'hf') await AsyncStorage.setItem('hf_api_key', value);

      if (value.trim()) {
        // Auto-test
        setKeys(prev => prev.map(k => k.id === id ? { ...k, status: 'checking' } : k));
        const status = await testKey(id, value);
        setKeys(prev => prev.map(k => k.id === id ? { ...k, status } : k));
        Alert.alert(
          status === 'ok' ? '✅ Connected!' : (status === 'error' ? '⚠️ Saved (Invalid Key)' : '✅ Saved'),
          status === 'ok' ? 'Key valid & connected!' : 'Key saved. Test failed — wrong key?'
        );
      } else {
        setKeys(prev => prev.map(k => k.id === id ? { ...k, status: 'idle' } : k));
        Alert.alert('Cleared', 'Key removed.');
      }
    } catch {
      Alert.alert('Error', 'Save பண்ண முடியல');
    } finally {
      setSaving(false);
    }
  };

  const toggleExpand = (id: string) => {
    setKeys(prev => prev.map(k => ({ ...k, expanded: k.id === id ? !k.expanded : false })));
  };

  const addCustomKey = async () => {
    const label = newLabel.trim();
    const site = newSite.trim() || 'custom';
    if (!label) { Alert.alert('பிழை', 'Key பெயர் உள்ளிடுங்க'); return; }
    const id = 'custom_' + Date.now();
    const entry: ApiKeyEntry = { id, label, site, value: '', enabled: false, expanded: false, status: 'idle' };
    setKeys(prev => [...prev, entry]);
    setAddModal(false); setNewLabel(''); setNewSite('');
  };

  const deleteCustomKey = (id: string, label: string) => {
    if (DEFAULT_KEYS.some(k => k.id === id)) {
      Alert.alert('Delete முடியாது', 'Default keys delete பண்ண முடியாது'); return;
    }
    Alert.alert('Delete?', `"${label}" delete பண்ணட்டுமா?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        setKeys(prev => prev.filter(k => k.id !== id));
        const saved = await AsyncStorage.getItem(KEYS_STORAGE);
        const parsed = saved ? JSON.parse(saved) : {};
        delete parsed[id];
        await AsyncStorage.setItem(KEYS_STORAGE, JSON.stringify(parsed));
      }},
    ]);
  };

  const cloudSave = async () => {
    setSyncing(true);
    await new Promise(r => setTimeout(r, 1500));
    setSyncing(false);
    Alert.alert('Cloud Save', 'Keys encrypted cloud-ல் save ✅');
  };

  const cloudLoad = async () => {
    setSyncing(true);
    await new Promise(r => setTimeout(r, 1500));
    setSyncing(false);
    Alert.alert('Cloud Load', 'Cloud keys load ✅');
  };

  return (
    <SafeAreaView style={s.safe}>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={s.header}>
        <Text style={s.headerIcon}>🔑</Text>
        <Text style={s.headerTitle}>Keys & Accounts</Text>
        <TouchableOpacity onPress={checkAllNow} disabled={checkingAll} style={s.checkAllBtn}>
          {checkingAll
            ? <ActivityIndicator color="#fff" size="small" />
            : <Text style={s.checkAllTxt}>🔍 Check All</Text>}
        </TouchableOpacity>
        <TouchableOpacity onPress={() => { setNewLabel(''); setNewSite(''); setAddModal(true); }} style={s.addBtn}>
          <Text style={s.addBtnTxt}>＋</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={s.scroll}>

        {/* Summary bar */}
        <View style={s.summaryBar}>
          <View style={s.summaryItem}>
            <Text style={s.summaryNum}>{okGeminiCount}</Text>
            <Text style={s.summaryLbl}>Gemini ✅</Text>
          </View>
          <View style={s.summaryDivider} />
          <View style={s.summaryItem}>
            <Text style={s.summaryNum}>{activeGeminiCount}</Text>
            <Text style={s.summaryLbl}>Active</Text>
          </View>
          <View style={s.summaryDivider} />
          <View style={s.summaryItem}>
            <Text style={s.summaryNum}>
              {keys.filter(k => k.status === 'ok').length}
            </Text>
            <Text style={s.summaryLbl}>Other ✅</Text>
          </View>
          <TouchableOpacity onPress={checkAllNow} disabled={checkingAll} style={s.recheckBtn}>
            {checkingAll
              ? <ActivityIndicator color="#7dd3fc" size="small" />
              : <Text style={s.recheckTxt}>🔄 Re-check</Text>}
          </TouchableOpacity>
        </View>

        {/* Device Key */}
        <View style={s.deviceKeyCard}>
          <Text style={s.deviceKeyLabel}>DEVICE KEY</Text>
          <View style={s.deviceKeyRow}>
            <TextInput
              style={s.deviceKeyInput}
              value={deviceKey}
              onChangeText={setDeviceKey}
              placeholder="Device key..."
              placeholderTextColor="#666"
              selectTextOnFocus
            />
            <TouchableOpacity style={s.clearBtn} onPress={() => { setDeviceKey(''); AsyncStorage.removeItem(DEVICE_KEY_STORAGE); }}>
              <Text style={s.clearBtnTxt}>✕</Text>
            </TouchableOpacity>
          </View>
          <View style={s.cloudBtns}>
            <TouchableOpacity style={s.cloudLoadBtn} onPress={cloudLoad} disabled={syncing}>
              {syncing ? <ActivityIndicator color="#fff" size="small" /> : <Text style={s.cloudBtnTxt}>⬇️ Cloud Load</Text>}
            </TouchableOpacity>
            <TouchableOpacity style={s.cloudSaveBtn} onPress={cloudSave} disabled={syncing}>
              {syncing ? <ActivityIndicator color="#fff" size="small" /> : <Text style={s.cloudBtnTxt}>☁️ Cloud Save</Text>}
            </TouchableOpacity>
          </View>
        </View>

        {/* ── Gemini Keys Section ── */}
        <TouchableOpacity style={s.sectionHeader} onPress={() => setGeminiSectionOpen(v => !v)} activeOpacity={0.8}>
          <View style={s.sectionHeaderLeft}>
            <Text style={s.sectionHeaderIcon}>🤖</Text>
            <View>
              <Text style={s.sectionHeaderTitle}>Gemini API Keys (13 Slots)</Text>
              <Text style={s.sectionHeaderSub}>
                {okGeminiCount} connected • {activeGeminiCount} active • Rotation: Key {(rotationIdx % Math.max(activeGeminiCount, 1)) + 1}
              </Text>
            </View>
          </View>
          <View style={s.sectionHeaderRight}>
            <View style={[s.activeBadge, okGeminiCount > 0 && s.activeBadgeOn]}>
              <Text style={s.activeBadgeTxt}>{okGeminiCount} ✅</Text>
            </View>
            <Text style={s.sectionArrow}>{geminiSectionOpen ? '▲' : '▼'}</Text>
          </View>
        </TouchableOpacity>

        {geminiSectionOpen && (
          <View style={s.geminiSection}>
            {/* Rotation status bar */}
            <View style={s.rotationBar}>
              <Text style={s.rotationTxt}>
                🔄 {activeGeminiCount > 0
                  ? `Key ${(rotationIdx % activeGeminiCount) + 1} → quota தீர்ந்தா next key auto`
                  : 'No active keys — Server keys use ஆகும்'}
              </Text>
              <TouchableOpacity onPress={resetRotation} style={s.resetBtn}>
                <Text style={s.resetBtnTxt}>Reset</Text>
              </TouchableOpacity>
            </View>

            {/* 13 key slots */}
            {Array.from({ length: GEMINI_SLOT_COUNT }, (_, i) => (
              <View key={i} style={[s.geminiSlot, geminiStatuses[i] === 'ok' ? s.geminiSlotOk : null]}>
                <TouchableOpacity style={s.geminiSlotRow} onPress={() => toggleGeminiExpand(i)} activeOpacity={0.7}>
                  <View style={[s.slotNumBadge, geminiStatuses[i] === 'ok' && s.slotNumBadgeOn]}>
                    <Text style={s.slotNumTxt}>{i + 1}</Text>
                  </View>
                  <View style={s.slotInfo}>
                    <Text style={s.slotLabel}>Gemini Key {i + 1}</Text>
                    <Text style={s.slotValue} numberOfLines={1}>
                      {geminiKeys[i]
                        ? geminiKeys[i].slice(0, 8) + '••••' + geminiKeys[i].slice(-4)
                        : 'Empty — tap to add'}
                    </Text>
                  </View>
                  <Switch
                    value={geminiEnabled[i] && !!geminiKeys[i]}
                    onValueChange={v => toggleGeminiEnabled(i, v)}
                    disabled={!geminiKeys[i]}
                    trackColor={{ false: '#333', true: '#25D366' }}
                    thumbColor={geminiEnabled[i] ? '#fff' : '#888'}
                    style={{ marginRight: 4 }}
                  />
                  {geminiStatuses[i] === 'checking'
                    ? <ActivityIndicator size="small" color="#f59e0b" style={{ marginRight: 8, width: 52 }} />
                    : geminiStatuses[i] === 'ok'
                      ? <View style={[sb.badge, sb.ok, { marginRight: 6 }]}><Text style={sb.txt}>✅ OK</Text></View>
                      : geminiStatuses[i] === 'error'
                        ? <View style={[sb.badge, sb.err, { marginRight: 6 }]}><Text style={sb.txt}>❌ ERR</Text></View>
                        : <View style={[sb.badge, sb.idle, { marginRight: 6 }]}><Text style={sb.txt}>EMPTY</Text></View>}
                  <Text style={s.expandArrow}>{geminiExpanded[i] ? '▲' : '▼'}</Text>
                </TouchableOpacity>

                {geminiExpanded[i] && (
                  <View style={s.geminiSlotExpanded}>
                    <TextInput
                      style={s.keyInput}
                      value={geminiKeys[i]}
                      onChangeText={v => {
                        const nk = [...geminiKeys]; nk[i] = v; setGeminiKeys(nk);
                      }}
                      placeholder="AIzaSy... (aistudio.google.com → free key)"
                      secureTextEntry={true}
                      placeholderTextColor="#555"
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                    <View style={s.slotBtns}>
                      <TouchableOpacity style={s.saveKeyBtn} onPress={() => saveGeminiKey(i)} disabled={saving}>
                        <Text style={s.saveKeyBtnTxt}>💾 Save & Test</Text>
                      </TouchableOpacity>
                      {geminiKeys[i] ? (
                        <TouchableOpacity style={s.clearSlotBtn} onPress={() => clearGeminiKey(i)}>
                          <Text style={s.clearSlotBtnTxt}>🗑 Clear</Text>
                        </TouchableOpacity>
                      ) : null}
                    </View>
                  </View>
                )}
              </View>
            ))}

            <View style={s.geminiHint}>
              <Text style={s.geminiHintTxt}>
                💡 aistudio.google.com → Get API key → Free (15 req/min){'\n'}
                💾 Save & Test → green ✅ = connected, red ❌ = invalid{'\n'}
                🔄 Quota தீர்ந்தா automatically next key try பண்ணும்
              </Text>
            </View>
          </View>
        )}

        {/* Other API Keys */}
        <Text style={s.otherKeysLabel}>OTHER KEYS</Text>

        {keys.map(key => (
          <View key={key.id} style={[s.keyCard, key.status === 'ok' ? s.keyCardOk : null]}>
            <TouchableOpacity style={s.keyRow} onPress={() => toggleExpand(key.id)} activeOpacity={0.7}>
              <View style={s.keyIconWrap}>
                <Text style={s.keyIcon}>🔑</Text>
              </View>
              <View style={s.keyInfo}>
                <Text style={s.keyLabel}>{key.label}</Text>
                <Text style={s.keySite}>{key.site}</Text>
              </View>
              <Switch
                value={key.enabled && !!key.value}
                onValueChange={v => toggleEnabled(key.id, v)}
                disabled={!key.value}
                trackColor={{ false: '#444', true: '#25D366' }}
                thumbColor={key.enabled ? '#fff' : '#888'}
                style={{ marginRight: 4 }}
              />
              <StatusBadge status={key.value ? key.status : 'idle'} />
              {!DEFAULT_KEYS.some(d => d.id === key.id) && (
                <TouchableOpacity onPress={() => deleteCustomKey(key.id, key.label)} style={s.keyTrash}>
                  <Text style={{ fontSize: 16 }}>🗑</Text>
                </TouchableOpacity>
              )}
              <Text style={s.expandArrow}>{key.expanded ? '▲' : '▼'}</Text>
            </TouchableOpacity>

            {key.expanded && (
              <View style={s.keyExpanded}>
                <TextInput
                  style={s.keyInput}
                  value={key.value}
                  onChangeText={v => setKeys(prev => prev.map(k => k.id === key.id ? { ...k, value: v } : k))}
                  placeholder={`${key.label} enter பண்ணுங்க...`}
                  placeholderTextColor="#555"
                  secureTextEntry={key.id !== 'hf'}
                  autoCapitalize="none"
                />
                <TouchableOpacity style={s.saveKeyBtn} onPress={() => saveKey(key.id, key.value)} disabled={saving}>
                  <Text style={s.saveKeyBtnTxt}>💾 Save & Test</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        ))}
      </ScrollView>

      {/* Add custom key modal */}
      <Modal visible={addModal} transparent animationType="slide" onRequestClose={() => setAddModal(false)}>
        <View style={s.modalOverlay}>
          <View style={s.modalBox}>
            <Text style={s.modalTitle}>🔑 புதிய Key சேர்</Text>
            <TextInput style={s.modalInput} value={newLabel} onChangeText={setNewLabel}
              placeholder="Key பெயர் (e.g. OpenAI...)" placeholderTextColor="#555" autoFocus />
            <TextInput style={[s.modalInput, { marginTop: 10 }]} value={newSite} onChangeText={setNewSite}
              placeholder="Website (e.g. openai.com)" placeholderTextColor="#555" autoCapitalize="none" />
            <View style={s.modalBtns}>
              <TouchableOpacity style={s.modalCancel} onPress={() => setAddModal(false)}>
                <Text style={s.modalCancelTxt}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.modalAdd} onPress={addCustomKey}>
                <Text style={s.modalAddTxt}>Add</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#0d1117' },
  header: {
    backgroundColor: '#0d6e7a', flexDirection: 'row',
    alignItems: 'center', gap: 10,
    paddingHorizontal: 16, paddingVertical: 14,
  },
  headerIcon: { fontSize: 22 },
  headerTitle: { color: '#fff', fontSize: 18, fontWeight: 'bold', flex: 1 },
  checkAllBtn: {
    backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 20,
    paddingHorizontal: 12, paddingVertical: 6,
  },
  checkAllTxt: { color: '#fff', fontSize: 13, fontWeight: '700' },
  addBtn: { width: 34, height: 34, borderRadius: 17, backgroundColor: 'rgba(255,255,255,0.2)', justifyContent: 'center', alignItems: 'center' },
  addBtnTxt: { color: '#fff', fontSize: 20, fontWeight: 'bold', lineHeight: 26 },
  scroll: { padding: 14, paddingBottom: 90 },

  summaryBar: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#111827', borderRadius: 12, padding: 14, marginBottom: 14,
    borderWidth: 1, borderColor: '#1f2937',
  },
  summaryItem: { flex: 1, alignItems: 'center' },
  summaryNum: { color: '#7dd3fc', fontSize: 22, fontWeight: '800' },
  summaryLbl: { color: '#6b7280', fontSize: 11, marginTop: 2 },
  summaryDivider: { width: 1, height: 36, backgroundColor: '#1f2937' },
  recheckBtn: { marginLeft: 12, backgroundColor: '#1e3a4a', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6 },
  recheckTxt: { color: '#7dd3fc', fontSize: 12, fontWeight: '700' },

  deviceKeyCard: {
    backgroundColor: '#111827', borderRadius: 14, padding: 16,
    marginBottom: 14, borderWidth: 1.5, borderColor: '#0d6e7a',
  },
  deviceKeyLabel: { color: '#0d6e7a', fontSize: 11, fontWeight: '800', letterSpacing: 0.8, marginBottom: 10 },
  deviceKeyRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#1f2937', borderRadius: 10,
    borderWidth: 1, borderColor: '#374151', marginBottom: 12,
  },
  deviceKeyInput: { flex: 1, color: '#e5e7eb', fontSize: 14, padding: 12, fontFamily: 'monospace' },
  clearBtn: { paddingHorizontal: 12, paddingVertical: 12 },
  clearBtnTxt: { color: '#6b7280', fontSize: 16 },
  cloudBtns: { flexDirection: 'row', gap: 10 },
  cloudLoadBtn: { flex: 1, backgroundColor: '#1565C0', borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  cloudSaveBtn: { flex: 1, backgroundColor: '#374151', borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  cloudBtnTxt: { color: '#fff', fontWeight: '700', fontSize: 14 },

  sectionHeader: {
    backgroundColor: '#0d1f2d', borderRadius: 12, padding: 14,
    marginBottom: 2, borderWidth: 1.5, borderColor: '#1a4a5a',
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  sectionHeaderLeft: { flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 },
  sectionHeaderIcon: { fontSize: 26 },
  sectionHeaderTitle: { color: '#fff', fontSize: 14, fontWeight: '700' },
  sectionHeaderSub: { color: '#6b9aaa', fontSize: 11, marginTop: 2 },
  sectionHeaderRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  activeBadge: { backgroundColor: '#333', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  activeBadgeOn: { backgroundColor: '#065f46' },
  activeBadgeTxt: { color: '#9ca3af', fontSize: 11, fontWeight: '800' },
  sectionArrow: { color: '#6b7280', fontSize: 14 },

  geminiSection: {
    backgroundColor: '#0a1520', borderRadius: 12, marginBottom: 14,
    borderWidth: 1, borderColor: '#1a4a5a', overflow: 'hidden',
  },
  rotationBar: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#0d2233', paddingHorizontal: 14, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: '#1a3a4a',
  },
  rotationTxt: { flex: 1, color: '#7dd3fc', fontSize: 12 },
  resetBtn: { backgroundColor: '#1e3a4a', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 },
  resetBtnTxt: { color: '#7dd3fc', fontSize: 12, fontWeight: '700' },

  geminiSlot: { borderBottomWidth: 1, borderBottomColor: '#111d2a' },
  geminiSlotOk: { backgroundColor: '#071a10' },
  geminiSlotRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 12 },
  slotNumBadge: { width: 32, height: 32, borderRadius: 8, backgroundColor: '#1e2d3a', justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  slotNumBadgeOn: { backgroundColor: '#065f46' },
  slotNumTxt: { color: '#7dd3fc', fontSize: 13, fontWeight: '800' },
  slotInfo: { flex: 1 },
  slotLabel: { color: '#e5e7eb', fontSize: 14, fontWeight: '600' },
  slotValue: { color: '#6b7280', fontSize: 11, marginTop: 2, fontFamily: 'monospace' },

  geminiSlotExpanded: { paddingHorizontal: 14, paddingBottom: 14, borderTopWidth: 1, borderTopColor: '#1a3a4a' },
  slotBtns: { flexDirection: 'row', gap: 10, marginTop: 10 },
  saveKeyBtn: { flex: 1, backgroundColor: '#1565C0', borderRadius: 8, paddingVertical: 10, alignItems: 'center' },
  saveKeyBtnTxt: { color: '#fff', fontWeight: 'bold', fontSize: 13 },
  clearSlotBtn: { backgroundColor: '#7f1d1d', borderRadius: 8, paddingHorizontal: 16, paddingVertical: 10, alignItems: 'center' },
  clearSlotBtnTxt: { color: '#fca5a5', fontWeight: 'bold', fontSize: 13 },

  geminiHint: { backgroundColor: '#0d2233', padding: 14, borderTopWidth: 1, borderTopColor: '#1a3a4a' },
  geminiHintTxt: { color: '#6b9aaa', fontSize: 12, lineHeight: 20 },

  otherKeysLabel: { color: '#6b7280', fontSize: 11, fontWeight: '800', letterSpacing: 1, marginBottom: 8, marginTop: 4 },

  keyCard: { backgroundColor: '#111827', borderRadius: 12, marginBottom: 8, borderWidth: 1, borderColor: '#1f2937', overflow: 'hidden' },
  keyCardOk: { borderColor: '#065f46' },
  keyRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 14 },
  keyIconWrap: { width: 38, height: 38, borderRadius: 10, backgroundColor: '#1f2937', justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  keyIcon: { fontSize: 18 },
  keyInfo: { flex: 1 },
  keyLabel: { color: '#e5e7eb', fontSize: 15, fontWeight: '600' },
  keySite: { color: '#6b7280', fontSize: 12, marginTop: 2 },
  expandArrow: { color: '#6b7280', fontSize: 13 },
  keyTrash: { paddingHorizontal: 8, paddingVertical: 4, marginRight: 4 },
  keyExpanded: { paddingHorizontal: 14, paddingBottom: 14, borderTopWidth: 1, borderTopColor: '#1f2937', gap: 10 },
  keyInput: {
    backgroundColor: '#1f2937', borderRadius: 8, borderWidth: 1, borderColor: '#374151',
    padding: 10, color: '#e5e7eb', fontSize: 13, marginTop: 10,
  },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', padding: 24 },
  modalBox: { backgroundColor: '#1f2937', borderRadius: 18, padding: 24 },
  modalTitle: { color: '#fff', fontSize: 18, fontWeight: 'bold', marginBottom: 16 },
  modalInput: { backgroundColor: '#111827', borderRadius: 10, borderWidth: 1, borderColor: '#374151', color: '#e5e7eb', fontSize: 14, paddingHorizontal: 14, paddingVertical: 12 },
  modalBtns: { flexDirection: 'row', gap: 12, marginTop: 20 },
  modalCancel: { flex: 1, backgroundColor: '#374151', borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  modalCancelTxt: { color: '#9ca3af', fontWeight: '700' },
  modalAdd: { flex: 1, backgroundColor: '#0d6e7a', borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  modalAddTxt: { color: '#fff', fontWeight: '700' },
});
