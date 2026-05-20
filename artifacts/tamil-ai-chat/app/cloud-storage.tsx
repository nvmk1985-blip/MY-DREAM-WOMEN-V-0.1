import React, { useState, useEffect, useCallback, useRef } from 'react';
import * as Clipboard from 'expo-clipboard';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView,
  Image, Modal, Dimensions, ActivityIndicator,
  Alert, RefreshControl, TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ImagePicker from 'expo-image-picker';
import { uploadToCloudinary, uploadUriToCloudinary, listCloudinaryImages, deleteFromCloudinary } from '../services/api';

const { width } = Dimensions.get('window');
const THUMB = (width - 6) / 3;
const LOCAL_KEY = 'my_girls_cloud_images';

export interface CloudImage {
  url: string;
  public_id: string;
  category: string;
  createdAt: number;
  width?: number;
  height?: number;
}

export async function saveCloudImage(img: CloudImage) {
  try {
    const existing = await AsyncStorage.getItem(LOCAL_KEY);
    const list: CloudImage[] = existing ? JSON.parse(existing) : [];
    const alreadyExists = list.some(i => i.public_id === img.public_id);
    if (!alreadyExists) {
      list.unshift(img);
      await AsyncStorage.setItem(LOCAL_KEY, JSON.stringify(list.slice(0, 300)));
    }
  } catch {}
}

export async function saveGeneratedImageToCloud(
  b64_json: string,
  mimeType: string,
  category: string = 'ai',
): Promise<CloudImage | null> {
  try {
    // Use category as the subfolder so persona+style photos land in the right place
    const folder = category === 'ai' ? 'my-girls' : `my-girls/${category}`;
    const result = await uploadToCloudinary(b64_json, mimeType, folder);
    const img: CloudImage = {
      url: result.url,
      public_id: result.public_id,
      category,
      createdAt: Date.now(),
      width: result.width,
      height: result.height,
    };
    await saveCloudImage(img);
    return img;
  } catch {
    return null;
  }
}

const CATEGORIES = [
  { key: 'all',      label: 'All',       icon: '🖼️' },
  { key: 'ai',       label: 'AI',        icon: '🤖' },
  { key: 'faceswap', label: 'Face Swap', icon: '🤳' },
  { key: 'group',    label: 'Group',     icon: '👥' },
  { key: 'app-icon', label: 'App Icon',  icon: '🎯' },
];

const APP_ICON_KEY = 'my_girls_app_icons';
const CLOUD_SECRETS_KEY = 'my_girls_cloud_secrets';

export default function CloudStorageScreen() {
  const router = useRouter();
  const [images, setImages] = useState<CloudImage[]>([]);
  const [activeCategory, setActiveCategory] = useState('all');
  const [preview, setPreview] = useState<CloudImage | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [fetchingCloud, setFetchingCloud] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleteConfirm, setDeleteConfirm] = useState<CloudImage | null>(null);
  const [uploadingIcon, setUploadingIcon] = useState(false);
  const [appIcons, setAppIcons] = useState<CloudImage[]>([]);

  const [secretsModal, setSecretsModal] = useState(false);
  const [cloudName, setCloudName] = useState('');
  const [cloudApiKey, setCloudApiKey] = useState('');
  const [cloudApiSecret, setCloudApiSecret] = useState('');
  const [secretsSaved, setSecretsSaved] = useState(false);
  const [savingSecrets, setSavingSecrets] = useState(false);

  const loadLocalImages = useCallback(async () => {
    try {
      const raw = await AsyncStorage.getItem(LOCAL_KEY);
      const list: CloudImage[] = raw ? JSON.parse(raw) : [];
      setImages(list);
    } catch {}
    try {
      const raw2 = await AsyncStorage.getItem(APP_ICON_KEY);
      const icons: CloudImage[] = raw2 ? JSON.parse(raw2) : [];
      setAppIcons(icons);
    } catch {}
    try {
      const raw3 = await AsyncStorage.getItem(CLOUD_SECRETS_KEY);
      if (raw3) {
        const s = JSON.parse(raw3);
        if (s.cloudName) setCloudName(s.cloudName);
        if (s.cloudApiKey) setCloudApiKey(s.cloudApiKey);
        if (s.cloudApiSecret) setCloudApiSecret(s.cloudApiSecret);
        setSecretsSaved(!!(s.cloudName && s.cloudApiKey && s.cloudApiSecret));
      }
    } catch {}
    setLoading(false);
    setRefreshing(false);
  }, []);

  const saveSecrets = useCallback(async () => {
    if (!cloudName.trim() || !cloudApiKey.trim() || !cloudApiSecret.trim()) {
      Alert.alert('பிழை', 'மூன்று fields-உம் fill பண்ணுங்க');
      return;
    }
    setSavingSecrets(true);
    try {
      await AsyncStorage.setItem(CLOUD_SECRETS_KEY, JSON.stringify({
        cloudName: cloudName.trim(),
        cloudApiKey: cloudApiKey.trim(),
        cloudApiSecret: cloudApiSecret.trim(),
      }));
      setSecretsSaved(true);
      setSecretsModal(false);
      Alert.alert('✅ Saved!', 'Cloud secrets securely saved ஆனது!');
    } catch {
      Alert.alert('பிழை', 'Save பண்ண முடியல');
    } finally {
      setSavingSecrets(false);
    }
  }, [cloudName, cloudApiKey, cloudApiSecret]);

  const clearSecrets = useCallback(async () => {
    await AsyncStorage.removeItem(CLOUD_SECRETS_KEY);
    setCloudName(''); setCloudApiKey(''); setCloudApiSecret('');
    setSecretsSaved(false);
    setSecretsModal(false);
    Alert.alert('🗑️ Cleared', 'Cloud secrets delete ஆனது');
  }, []);

  const uploadAppIcon = useCallback(async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Permission வேணும்', 'Gallery access allow பண்ணுங்க');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.9,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    setUploadingIcon(true);
    try {
      const data = await uploadUriToCloudinary(asset.uri, 'image/jpeg', 'my-girls/app-icon');
      const newIcon: CloudImage = {
        url: data.url,
        public_id: data.public_id,
        category: 'app-icon',
        createdAt: Date.now(),
        width: data.width,
        height: data.height,
      };
      const existing = await AsyncStorage.getItem(APP_ICON_KEY);
      const list: CloudImage[] = existing ? JSON.parse(existing) : [];
      list.unshift(newIcon);
      await AsyncStorage.setItem(APP_ICON_KEY, JSON.stringify(list.slice(0, 10)));
      setAppIcons(list.slice(0, 10));
      Alert.alert('✅ Upload ஆச்சு!', 'App Icon Cloudinary-ல் save ஆனது.\nAPK build trigger பண்ணினா புது icon-ஓட APK கிடைக்கும்!');
    } catch (e: any) {
      Alert.alert('Upload பிழை', e?.message || 'மீண்டும் try பண்ணுங்க');
    } finally {
      setUploadingIcon(false);
    }
  }, []);

  const deleteAppIcon = useCallback(async (icon: CloudImage) => {
    setDeleteConfirm(null);
    try { await deleteFromCloudinary(icon.public_id); } catch {}
    const existing = await AsyncStorage.getItem(APP_ICON_KEY);
    const list: CloudImage[] = existing ? JSON.parse(existing) : [];
    const updated = list.filter(i => i.public_id !== icon.public_id);
    await AsyncStorage.setItem(APP_ICON_KEY, JSON.stringify(updated));
    setAppIcons(updated);
    setPreview(null);
  }, []);

  const syncFromCloud = useCallback(async () => {
    setFetchingCloud(true);
    try {
      const cloudImgs = await listCloudinaryImages('my-girls');
      const local = await AsyncStorage.getItem(LOCAL_KEY);
      const localList: CloudImage[] = local ? JSON.parse(local) : [];

      const merged = [...localList];
      for (const ci of cloudImgs) {
        if (!merged.some(i => i.public_id === ci.public_id)) {
          merged.push({
            url: ci.url,
            public_id: ci.public_id,
            category: 'ai',
            createdAt: Date.now(),
          });
        }
      }
      merged.sort((a, b) => b.createdAt - a.createdAt);
      await AsyncStorage.setItem(LOCAL_KEY, JSON.stringify(merged.slice(0, 300)));
      setImages(merged);
    } catch (e: any) {
      const errMsg = e?.message || '';
      const isServer = errMsg.includes('fetch') || errMsg.includes('network') || errMsg.includes('connect') || errMsg.includes('timeout');
      if (isServer) {
        Alert.alert(
          '⚠️ Server Wake ஆகுது',
          `Render server sleep mode-ல் இருக்கு.\n\n⏳ 30-60 seconds காத்திரு, பிறகு Retry பண்ணு.\n\nSettings → Custom Server URL-ல் வேற server set பண்ணலாம்.`,
          [
            { text: 'Cancel', style: 'cancel' },
            { text: '🔄 Retry (30s)', onPress: () => setTimeout(() => syncFromCloud(), 30000) },
          ]
        );
      } else {
        Alert.alert('Sync பிழை', errMsg || 'Cloud sync வேலை செய்யல');
      }
    } finally {
      setFetchingCloud(false);
    }
  }, []);

  useEffect(() => {
    loadLocalImages();
  }, []);

  const filtered = activeCategory === 'all'
    ? images
    : images.filter(img => img.category === activeCategory);

  const removeFromState = async (ids: string[]) => {
    const idSet = new Set(ids);
    const raw = await AsyncStorage.getItem(LOCAL_KEY);
    const list: CloudImage[] = raw ? JSON.parse(raw) : [];
    const updated = list.filter(i => !idSet.has(i.public_id));
    await AsyncStorage.setItem(LOCAL_KEY, JSON.stringify(updated));
    setImages(updated);
    setPreview(null);
    setSelectionMode(false);
    setSelectedIds(new Set());
  };

  const doDeleteImage = async (img: CloudImage) => {
    setDeleteConfirm(null);
    try { await deleteFromCloudinary(img.public_id); } catch {}
    await removeFromState([img.public_id]);
  };

  const deleteImage = (img: CloudImage) => {
    setDeleteConfirm(img);
  };

  const deleteSelected = async () => {
    const ids = [...selectedIds];
    exitSelectionMode();
    for (const id of ids) { try { await deleteFromCloudinary(id); } catch {} }
    await removeFromState(ids);
  };

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const enterSelectionMode = (id: string) => {
    setSelectionMode(true);
    setSelectedIds(new Set([id]));
  };

  const exitSelectionMode = () => { setSelectionMode(false); setSelectedIds(new Set()); };

  const categoryCounts = CATEGORIES.map(c => ({
    ...c,
    count: c.key === 'all'
      ? images.length
      : c.key === 'app-icon'
        ? appIcons.length
        : images.filter(i => i.category === c.key).length,
  }));

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.headerCloud}>☁️</Text>
          <Text style={styles.headerTitle}>My Cloud</Text>
        </View>
        <View style={styles.headerRight}>
          <TouchableOpacity style={styles.syncBtn} onPress={syncFromCloud} disabled={fetchingCloud}>
            {fetchingCloud
              ? <ActivityIndicator color="#fff" size="small" />
              : <Text style={styles.syncBtnTxt}>🔄 Sync</Text>
            }
          </TouchableOpacity>
          <TouchableOpacity style={styles.secretBtn} onPress={() => setSecretsModal(true)}>
            <Text style={styles.secretBtnTxt}>{secretsSaved ? '🔐' : '🔓'}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => router.push('/settings')}>
            <Text style={styles.headerGear}>⚙️</Text>
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView
        style={styles.scroll}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); loadLocalImages(); }}
            tintColor="#6C63FF"
          />
        }
      >
        {/* ☁️ Cloud Secrets Card */}
        <View style={styles.secretsCard}>
          <View style={styles.secretsCardHeader}>
            <Text style={styles.secretsCardTitle}>
              {secretsSaved ? '🔐' : '🔓'} Cloud Secrets
            </Text>
            <TouchableOpacity style={styles.secretsEditBtn} onPress={() => setSecretsModal(true)}>
              <Text style={styles.secretsEditTxt}>{secretsSaved ? 'Edit' : '+ Add'}</Text>
            </TouchableOpacity>
          </View>

          {secretsSaved ? (
            <View style={styles.secretsChips}>
              {/* Cloud Name chip */}
              <TouchableOpacity
                style={styles.secretChip}
                onPress={async () => { await Clipboard.setStringAsync(cloudName); Alert.alert('📋', 'Cloud Name copied!'); }}
                activeOpacity={0.7}
              >
                <Text style={styles.secretChipIcon}>☁️</Text>
                <View style={styles.secretChipInfo}>
                  <Text style={styles.secretChipLabel}>CLOUD NAME</Text>
                  <Text style={styles.secretChipValue}>{cloudName}</Text>
                </View>
                <Text style={styles.secretChipCopy}>📋</Text>
              </TouchableOpacity>

              {/* API Key chip */}
              <TouchableOpacity
                style={styles.secretChip}
                onPress={async () => { await Clipboard.setStringAsync(cloudApiKey); Alert.alert('📋', 'API Key copied!'); }}
                activeOpacity={0.7}
              >
                <Text style={styles.secretChipIcon}>🔑</Text>
                <View style={styles.secretChipInfo}>
                  <Text style={styles.secretChipLabel}>API KEY</Text>
                  <Text style={styles.secretChipValue}>{cloudApiKey.slice(0, 6)}{'●'.repeat(Math.max(0, cloudApiKey.length - 6))}</Text>
                </View>
                <Text style={styles.secretChipCopy}>📋</Text>
              </TouchableOpacity>

              {/* API Secret chip */}
              <TouchableOpacity
                style={styles.secretChip}
                onPress={async () => { await Clipboard.setStringAsync(cloudApiSecret); Alert.alert('📋', 'API Secret copied!'); }}
                activeOpacity={0.7}
              >
                <Text style={styles.secretChipIcon}>🔒</Text>
                <View style={styles.secretChipInfo}>
                  <Text style={styles.secretChipLabel}>API SECRET</Text>
                  <Text style={styles.secretChipValue}>{'●'.repeat(Math.min(cloudApiSecret.length, 20))}</Text>
                </View>
                <Text style={styles.secretChipCopy}>📋</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity style={styles.secretsEmptyBtn} onPress={() => setSecretsModal(true)}>
              <Text style={styles.secretsEmptyTxt}>🔓 Tap to add Cloudinary credentials</Text>
            </TouchableOpacity>
          )}
        </View>

        <Text style={styles.sectionLabel}>STORAGE</Text>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.catScroll}
          contentContainerStyle={styles.catRow}
        >
          {categoryCounts.map(cat => (
            <TouchableOpacity
              key={cat.key}
              style={[styles.catCard, activeCategory === cat.key && styles.catCardActive]}
              onPress={() => setActiveCategory(cat.key)}
            >
              <Text style={styles.catIcon}>{cat.icon}</Text>
              <Text style={[styles.catLabel, activeCategory === cat.key && styles.catLabelActive]}>
                {cat.label}
              </Text>
              {cat.count > 0 && (
                <View style={styles.catBadge}>
                  <Text style={styles.catBadgeText}>{cat.count}</Text>
                </View>
              )}
            </TouchableOpacity>
          ))}
        </ScrollView>

        <View style={styles.storageInfo}>
          <Text style={styles.storageTitle}>☁️ Cloudinary — my-girls folder</Text>
          <Text style={styles.storageCount}>{images.length} images</Text>
        </View>

        {images.length === 0 && !loading && (
          <View style={styles.syncCard}>
            <Text style={styles.syncCardTitle}>Cloud-ல் images இல்லை</Text>
            <Text style={styles.syncCardText}>
              Chat-ல் AI image generate பண்ணா auto-save ஆகும்.{'\n'}
              🔄 Sync button tap பண்ணி Cloudinary-ல் உள்ள images fetch பண்ணலாம்.
            </Text>
            <TouchableOpacity style={styles.syncCardBtn} onPress={syncFromCloud} disabled={fetchingCloud}>
              {fetchingCloud
                ? <ActivityIndicator color="#fff" size="small" />
                : <Text style={styles.syncCardBtnTxt}>🔄 Sync from Cloud</Text>
              }
            </TouchableOpacity>
          </View>
        )}

        {selectionMode && selectedIds.size > 0 && (
          <View style={styles.selBar}>
            <TouchableOpacity onPress={exitSelectionMode}>
              <Text style={styles.selBarCancel}>✕</Text>
            </TouchableOpacity>
            <Text style={styles.selBarCount}>{selectedIds.size} selected</Text>
            <TouchableOpacity style={styles.selBarDelete} onPress={deleteSelected}>
              <Text style={styles.selBarDeleteTxt}>🗑️ Delete</Text>
            </TouchableOpacity>
          </View>
        )}

        {activeCategory === 'app-icon' ? (
          <View style={styles.appIconSection}>
            <View style={styles.appIconHeader}>
              <View>
                <Text style={styles.appIconTitle}>🎯 App Icon Folder</Text>
                <Text style={styles.appIconSub}>Cloudinary: my-girls/app-icon/</Text>
              </View>
              <TouchableOpacity
                style={[styles.appIconUploadBtn, uploadingIcon && { opacity: 0.6 }]}
                onPress={uploadAppIcon}
                disabled={uploadingIcon}
              >
                {uploadingIcon
                  ? <ActivityIndicator color="#fff" size="small" />
                  : <Text style={styles.appIconUploadTxt}>📤 Upload Icon</Text>
                }
              </TouchableOpacity>
            </View>

            <View style={styles.appIconInfo}>
              <Text style={styles.appIconInfoTxt}>
                📌 Photo select → 1:1 crop → Cloudinary upload{'\n'}
                🔨 APK build-ல் latest icon auto-fetch ஆகும்
              </Text>
            </View>

            {appIcons.length === 0 ? (
              <View style={styles.appIconEmpty}>
                <Text style={styles.appIconEmptyIcon}>🎯</Text>
                <Text style={styles.appIconEmptyTxt}>Icon upload ஆகல</Text>
                <Text style={styles.appIconEmptyHint}>Upload பண்ணினா APK-ல் உங்கள் icon வரும்!</Text>
              </View>
            ) : (
              <View style={styles.appIconGrid}>
                {appIcons.map((icon, idx) => (
                  <View key={icon.public_id} style={styles.appIconItem}>
                    <Image source={{ uri: icon.url }} style={styles.appIconThumb} resizeMode="cover" />
                    {idx === 0 && (
                      <View style={styles.appIconLatestBadge}>
                        <Text style={styles.appIconLatestTxt}>LATEST</Text>
                      </View>
                    )}
                    <TouchableOpacity
                      style={styles.appIconDeleteBtn}
                      onPress={() => setDeleteConfirm(icon)}
                    >
                      <Text style={styles.appIconDeleteTxt}>🗑️</Text>
                    </TouchableOpacity>
                    <Text style={styles.appIconDate}>
                      {new Date(icon.createdAt).toLocaleDateString('ta-IN')}
                    </Text>
                  </View>
                ))}
              </View>
            )}
          </View>
        ) : loading ? (
          <ActivityIndicator color="#6C63FF" size="large" style={{ marginTop: 60 }} />
        ) : filtered.length === 0 && images.length > 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>🔍</Text>
            <Text style={styles.emptyText}>{activeCategory} category-ல் images இல்லை</Text>
          </View>
        ) : (
          <View style={styles.grid}>
            {filtered.map(img => {
              const isSel = selectedIds.has(img.public_id);
              return (
                <TouchableOpacity
                  key={img.public_id}
                  onPress={() => selectionMode ? toggleSelect(img.public_id) : setPreview(img)}
                  onLongPress={() => enterSelectionMode(img.public_id)}
                  style={{ position: 'relative' }}
                >
                  <Image source={{ uri: img.url }} style={[styles.thumb, isSel && { opacity: 0.6 }]} resizeMode="cover" />
                  {isSel && (
                    <View style={styles.thumbCheck}>
                      <Text style={styles.thumbCheckTxt}>✓</Text>
                    </View>
                  )}
                </TouchableOpacity>
              );
            })}
          </View>
        )}
      </ScrollView>

      <Modal visible={!!preview} transparent animationType="fade" onRequestClose={() => setPreview(null)}>
        {preview && (
          <View style={styles.modalBg}>
            <TouchableOpacity style={styles.modalClose} onPress={() => setPreview(null)}>
              <Text style={styles.modalCloseText}>✕</Text>
            </TouchableOpacity>
            <Image source={{ uri: preview.url }} style={styles.fullImg} resizeMode="contain" />
            <View style={styles.modalActions}>
              <View>
                <Text style={styles.modalCat}>{preview.category.toUpperCase()}</Text>
                <Text style={styles.modalDate}>
                  {new Date(preview.createdAt).toLocaleDateString('ta-IN')}
                </Text>
              </View>
              <TouchableOpacity style={styles.deleteBtn} onPress={() => deleteImage(preview)}>
                <Text style={styles.deleteBtnText}>🗑️ Delete</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </Modal>

      {/* ☁️ Cloud Secret Box Modal */}
      <Modal visible={secretsModal} transparent animationType="slide" onRequestClose={() => setSecretsModal(false)}>
        <View style={styles.secOverlay}>
          <View style={styles.secBox}>
            <View style={styles.secHeaderRow}>
              <Text style={styles.secTitle}>☁️ Cloud Secret Box</Text>
              <TouchableOpacity onPress={() => setSecretsModal(false)}>
                <Text style={styles.secClose}>✕</Text>
              </TouchableOpacity>
            </View>

            {secretsSaved && (
              <View style={styles.secSavedBanner}>
                <Text style={styles.secSavedTxt}>🔐 Secrets saved & ready!</Text>
              </View>
            )}

            <Text style={styles.secInfo}>
              Cloudinary credentials-ஐ securely app-ல் store பண்ணு.{'\n'}
              cloudinary.com → Dashboard-ல் பார்க்கலாம்.
            </Text>

            {/* Cloud Name */}
            <Text style={styles.secLabel}>☁️ Cloud Name</Text>
            <View style={styles.secInputRow}>
              <TextInput
                style={styles.secInput}
                value={cloudName}
                onChangeText={setCloudName}
                placeholder="e.g. dazmrxsyc"
                placeholderTextColor="#555"
                autoCapitalize="none"
                autoCorrect={false}
              />
              {cloudName.length > 0 && (
                <TouchableOpacity style={styles.secCopyBtn} onPress={async () => { await Clipboard.setStringAsync(cloudName); Alert.alert('📋 Copied!', 'Cloud Name copied'); }}>
                  <Text style={styles.secCopyTxt}>📋</Text>
                </TouchableOpacity>
              )}
            </View>

            {/* API Key */}
            <Text style={styles.secLabel}>🔑 API Key</Text>
            <View style={styles.secInputRow}>
              <TextInput
                style={styles.secInput}
                value={cloudApiKey}
                onChangeText={setCloudApiKey}
                placeholder="123456789012345"
                placeholderTextColor="#555"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="numeric"
              />
              {cloudApiKey.length > 0 && (
                <TouchableOpacity style={styles.secCopyBtn} onPress={async () => { await Clipboard.setStringAsync(cloudApiKey); Alert.alert('📋 Copied!', 'API Key copied'); }}>
                  <Text style={styles.secCopyTxt}>📋</Text>
                </TouchableOpacity>
              )}
            </View>

            {/* API Secret */}
            <Text style={styles.secLabel}>🔒 API Secret</Text>
            <View style={styles.secInputRow}>
              <TextInput
                style={styles.secInput}
                value={cloudApiSecret}
                onChangeText={setCloudApiSecret}
                placeholder="xxxxxxxxxxxxxxxxxxxxxxxx"
                placeholderTextColor="#555"
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
              />
              {cloudApiSecret.length > 0 && (
                <TouchableOpacity style={styles.secCopyBtn} onPress={async () => { await Clipboard.setStringAsync(cloudApiSecret); Alert.alert('📋 Copied!', 'API Secret copied'); }}>
                  <Text style={styles.secCopyTxt}>📋</Text>
                </TouchableOpacity>
              )}
            </View>

            {/* Buttons */}
            <View style={styles.secBtns}>
              {secretsSaved && (
                <TouchableOpacity style={styles.secClearBtn} onPress={() => Alert.alert('Delete?', 'Secrets delete பண்ணட்டுமா?', [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: clearSecrets }])}>
                  <Text style={styles.secClearTxt}>🗑 Clear</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity style={styles.secSaveBtn} onPress={saveSecrets} disabled={savingSecrets}>
                {savingSecrets
                  ? <ActivityIndicator color="#fff" size="small" />
                  : <Text style={styles.secSaveTxt}>💾 Save Secrets</Text>
                }
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Custom delete confirm (Alert blocked in Chrome web) */}
      {deleteConfirm && (
        <View style={styles.confirmOverlay}>
          <View style={styles.confirmBox}>
            <Text style={styles.confirmIcon}>🗑️</Text>
            <Text style={styles.confirmTitle}>Delete பண்ணட்டுமா?</Text>
            <Text style={styles.confirmSub}>Cloud-லயும் local-லயும் remove ஆகும்</Text>
            <View style={styles.confirmBtns}>
              <TouchableOpacity style={styles.confirmCancel} onPress={() => setDeleteConfirm(null)}>
                <Text style={styles.confirmCancelTxt}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.confirmDelete} onPress={() => doDeleteImage(deleteConfirm)}>
                <Text style={styles.confirmDeleteTxt}>Delete</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#1a1a2e' },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 14, backgroundColor: '#16213e',
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  headerCloud: { fontSize: 24 },
  headerTitle: { color: '#fff', fontSize: 22, fontWeight: 'bold' },
  headerGear: { fontSize: 22 },
  syncBtn: {
    backgroundColor: '#6C63FF', borderRadius: 8,
    paddingHorizontal: 12, paddingVertical: 6, minWidth: 70, alignItems: 'center',
  },
  syncBtnTxt: { color: '#fff', fontSize: 13, fontWeight: '700' },
  scroll: { flex: 1 },
  sectionLabel: {
    color: '#aaa', fontSize: 11, fontWeight: '700', letterSpacing: 1.5,
    paddingHorizontal: 16, paddingTop: 18, paddingBottom: 10,
  },
  catScroll: { marginBottom: 4 },
  catRow: { paddingHorizontal: 12, gap: 10, paddingBottom: 8 },
  catCard: {
    width: 80, alignItems: 'center', paddingVertical: 14, paddingHorizontal: 8,
    backgroundColor: '#16213e', borderRadius: 16, borderWidth: 1.5, borderColor: '#2a2a4a',
  },
  catCardActive: { borderColor: '#6C63FF', backgroundColor: '#2d2b55' },
  catIcon: { fontSize: 28, marginBottom: 6 },
  catLabel: { color: '#aaa', fontSize: 11, fontWeight: '600', textAlign: 'center' },
  catLabelActive: { color: '#6C63FF' },
  catBadge: {
    position: 'absolute', top: 6, right: 6, backgroundColor: '#6C63FF',
    borderRadius: 8, minWidth: 16, height: 16, justifyContent: 'center', alignItems: 'center',
  },
  catBadgeText: { color: '#fff', fontSize: 9, fontWeight: 'bold' },
  storageInfo: {
    margin: 16, padding: 14, backgroundColor: '#16213e', borderRadius: 12,
    borderWidth: 1, borderColor: '#2a2a4a',
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
  },
  storageTitle: { color: '#fff', fontSize: 13, fontWeight: '600' },
  storageCount: { color: '#6C63FF', fontSize: 13, fontWeight: 'bold' },
  syncCard: {
    margin: 16, padding: 20, backgroundColor: '#16213e',
    borderRadius: 16, borderWidth: 1, borderColor: '#2a2a4a', alignItems: 'center',
  },
  syncCardTitle: { color: '#fff', fontSize: 16, fontWeight: 'bold', marginBottom: 10 },
  syncCardText: { color: '#aaa', fontSize: 13, textAlign: 'center', lineHeight: 20, marginBottom: 16 },
  syncCardBtn: {
    backgroundColor: '#6C63FF', borderRadius: 10,
    paddingHorizontal: 24, paddingVertical: 12,
  },
  syncCardBtnTxt: { color: '#fff', fontWeight: 'bold', fontSize: 14 },
  selBar: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#1a1a4a',
    paddingHorizontal: 14, paddingVertical: 10, gap: 10,
  },
  selBarCancel: { color: '#aaa', fontSize: 18, fontWeight: 'bold', paddingRight: 4 },
  selBarCount: { flex: 1, color: '#fff', fontWeight: '700', fontSize: 14 },
  selBarDelete: { backgroundColor: '#c62828', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 7 },
  selBarDeleteTxt: { color: '#fff', fontWeight: 'bold', fontSize: 13 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 2, paddingHorizontal: 2 },
  thumb: { width: THUMB, height: THUMB, backgroundColor: '#2a2a4a' },
  thumbCheck: {
    position: 'absolute', inset: 0,
    backgroundColor: 'rgba(21,101,192,0.35)',
    justifyContent: 'center', alignItems: 'center',
  },
  thumbCheckTxt: { color: '#fff', fontSize: 28, fontWeight: 'bold' },
  empty: { alignItems: 'center', paddingTop: 60, paddingHorizontal: 40 },
  emptyIcon: { fontSize: 48, marginBottom: 12 },
  emptyText: { color: '#888', fontSize: 15, textAlign: 'center' },
  modalBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.95)', justifyContent: 'center' },
  modalClose: { position: 'absolute', top: 50, right: 20, zIndex: 10, padding: 8 },
  modalCloseText: { color: '#fff', fontSize: 22, fontWeight: 'bold' },
  fullImg: { width, height: width, alignSelf: 'center' },
  modalActions: {
    position: 'absolute', bottom: 60, left: 0, right: 0,
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'center', paddingHorizontal: 20,
  },
  modalCat: { color: '#6C63FF', fontSize: 12, fontWeight: '700', letterSpacing: 1 },
  modalDate: { color: '#aaa', fontSize: 12, marginTop: 2 },
  deleteBtn: { backgroundColor: '#c62828', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10 },
  deleteBtnText: { color: '#fff', fontWeight: 'bold' },
  confirmOverlay: {
    ...StyleSheet.absoluteFillObject, zIndex: 200,
    backgroundColor: 'rgba(0,0,0,0.75)', justifyContent: 'center', alignItems: 'center', padding: 30,
  },
  confirmBox: { backgroundColor: '#1f2937', borderRadius: 18, padding: 24, width: '100%', alignItems: 'center' },
  confirmIcon: { fontSize: 40, marginBottom: 10 },
  confirmTitle: { color: '#fff', fontSize: 18, fontWeight: 'bold', marginBottom: 6 },
  confirmSub: { color: '#aaa', fontSize: 13, textAlign: 'center', marginBottom: 20 },
  confirmBtns: { flexDirection: 'row', gap: 12, width: '100%' },
  confirmCancel: { flex: 1, backgroundColor: '#374151', borderRadius: 10, paddingVertical: 13, alignItems: 'center' },
  confirmCancelTxt: { color: '#ccc', fontWeight: '700', fontSize: 15 },
  confirmDelete: { flex: 1, backgroundColor: '#c62828', borderRadius: 10, paddingVertical: 13, alignItems: 'center' },
  confirmDeleteTxt: { color: '#fff', fontWeight: '800', fontSize: 15 },

  appIconSection: { margin: 14 },
  appIconHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: '#16213e', borderRadius: 14, padding: 14, marginBottom: 10,
    borderWidth: 1, borderColor: '#6C63FF',
  },
  appIconTitle: { color: '#fff', fontSize: 16, fontWeight: 'bold' },
  appIconSub: { color: '#6C63FF', fontSize: 11, marginTop: 3 },
  appIconUploadBtn: {
    backgroundColor: '#6C63FF', borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 10, minWidth: 100, alignItems: 'center',
  },
  appIconUploadTxt: { color: '#fff', fontWeight: 'bold', fontSize: 13 },
  appIconInfo: {
    backgroundColor: '#0d2137', borderRadius: 12, padding: 12, marginBottom: 14,
    borderWidth: 1, borderColor: '#1565C0',
  },
  appIconInfoTxt: { color: '#58a6ff', fontSize: 12, lineHeight: 20 },
  appIconEmpty: { alignItems: 'center', paddingVertical: 50 },
  appIconEmptyIcon: { fontSize: 56, marginBottom: 12 },
  appIconEmptyTxt: { color: '#fff', fontSize: 16, fontWeight: 'bold', marginBottom: 6 },
  appIconEmptyHint: { color: '#aaa', fontSize: 13, textAlign: 'center' },
  appIconGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  appIconItem: { width: (width - 52) / 3, alignItems: 'center' },
  appIconThumb: {
    width: (width - 52) / 3, height: (width - 52) / 3,
    borderRadius: 16, backgroundColor: '#2a2a4a',
    borderWidth: 2, borderColor: '#6C63FF',
  },
  appIconLatestBadge: {
    position: 'absolute', top: 6, left: 0, right: 0,
    alignItems: 'center',
  },
  appIconLatestTxt: {
    backgroundColor: '#00C853', color: '#fff', fontSize: 9,
    fontWeight: 'bold', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6,
  },
  appIconDeleteBtn: {
    marginTop: 6, backgroundColor: '#c62828', borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 4,
  },
  appIconDeleteTxt: { fontSize: 13 },
  appIconDate: { color: '#888', fontSize: 10, marginTop: 4, textAlign: 'center' },

  secretBtn: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.1)',
    justifyContent: 'center', alignItems: 'center',
  },
  secretBtnTxt: { fontSize: 20 },

  secretsCard: {
    marginHorizontal: 14, marginTop: 14, marginBottom: 4,
    backgroundColor: '#0d1b2a', borderRadius: 16,
    borderWidth: 1.5, borderColor: '#1e3a5f',
    overflow: 'hidden',
  },
  secretsCardHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: '#1e3a5f',
  },
  secretsCardTitle: { color: '#e2e8f0', fontSize: 15, fontWeight: '700' },
  secretsEditBtn: {
    backgroundColor: '#1e3a5f', borderRadius: 8,
    paddingHorizontal: 12, paddingVertical: 5,
  },
  secretsEditTxt: { color: '#60a5fa', fontSize: 12, fontWeight: '700' },
  secretsChips: { paddingHorizontal: 12, paddingVertical: 10, gap: 8 },
  secretChip: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#111e2e', borderRadius: 12,
    borderWidth: 1, borderColor: '#1e3a5f',
    paddingHorizontal: 14, paddingVertical: 11,
    marginBottom: 6,
  },
  secretChipIcon: { fontSize: 18, marginRight: 12 },
  secretChipInfo: { flex: 1 },
  secretChipLabel: {
    color: '#64748b', fontSize: 10, fontWeight: '800',
    letterSpacing: 1, marginBottom: 3,
  },
  secretChipValue: { color: '#94a3b8', fontSize: 13, fontFamily: 'monospace' },
  secretChipCopy: { fontSize: 18, marginLeft: 8 },
  secretsEmptyBtn: {
    margin: 12, backgroundColor: '#111e2e', borderRadius: 12,
    paddingVertical: 16, alignItems: 'center',
    borderWidth: 1, borderColor: '#1e3a5f', borderStyle: 'dashed',
  },
  secretsEmptyTxt: { color: '#64748b', fontSize: 13 },

  secOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.85)',
    justifyContent: 'flex-end',
  },
  secBox: {
    backgroundColor: '#111827', borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: 24, paddingBottom: 40,
  },
  secHeaderRow: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'center', marginBottom: 14,
  },
  secTitle: { color: '#fff', fontSize: 20, fontWeight: 'bold' },
  secClose: { color: '#9ca3af', fontSize: 22, fontWeight: 'bold', padding: 4 },
  secSavedBanner: {
    backgroundColor: '#064e3b', borderRadius: 10,
    paddingVertical: 8, paddingHorizontal: 14,
    marginBottom: 14, borderWidth: 1, borderColor: '#10b981',
  },
  secSavedTxt: { color: '#10b981', fontWeight: '700', fontSize: 13 },
  secInfo: {
    color: '#6b7280', fontSize: 12, lineHeight: 18,
    marginBottom: 18, backgroundColor: '#1f2937',
    borderRadius: 10, padding: 12,
  },
  secLabel: { color: '#9ca3af', fontSize: 12, fontWeight: '700', marginBottom: 6, letterSpacing: 0.5 },
  secInputRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#1f2937', borderRadius: 12,
    borderWidth: 1, borderColor: '#374151',
    marginBottom: 14,
  },
  secInput: {
    flex: 1, color: '#e5e7eb', fontSize: 14,
    paddingHorizontal: 14, paddingVertical: 13,
    fontFamily: 'monospace',
  },
  secCopyBtn: {
    paddingHorizontal: 12, paddingVertical: 10,
    borderLeftWidth: 1, borderLeftColor: '#374151',
  },
  secCopyTxt: { fontSize: 18 },
  secBtns: { flexDirection: 'row', gap: 12, marginTop: 6 },
  secClearBtn: {
    flex: 1, backgroundColor: '#374151', borderRadius: 12,
    paddingVertical: 14, alignItems: 'center',
    borderWidth: 1, borderColor: '#c62828',
  },
  secClearTxt: { color: '#f87171', fontWeight: '700', fontSize: 14 },
  secSaveBtn: {
    flex: 2, backgroundColor: '#0d6e7a', borderRadius: 12,
    paddingVertical: 14, alignItems: 'center',
  },
  secSaveTxt: { color: '#fff', fontWeight: '800', fontSize: 15 },
});
