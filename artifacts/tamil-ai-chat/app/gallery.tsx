import React, { useState, useCallback, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Alert,
  ActivityIndicator, Image, Dimensions, ScrollView, FlatList,
  Platform, TextInput, Modal, BackHandler,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useRouter, useLocalSearchParams, useFocusEffect } from 'expo-router';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { uploadUriToCloudinary, listCloudinaryImages, deleteFromCloudinary } from '../services/api';

const { width } = Dimensions.get('window');
const COLS = 3;
const THUMB = (width - (COLS + 1) * 2) / COLS;

interface CloudFile { url: string; public_id: string; isVideo?: boolean }
interface SubFolder  { id: string; label: string }

const ALBUM_META: Record<string, { label: string; emoji: string; color: string; mediaType: MediaLibrary.MediaTypeValue[] }> = {
  pictures:    { label: 'Pictures',    emoji: '🖼️',  color: '#4A90D9', mediaType: [MediaLibrary.MediaType.photo] },
  camera:      { label: 'Camera',      emoji: '📷',  color: '#E8821A', mediaType: [MediaLibrary.MediaType.photo] },
  movies:      { label: 'Movies',      emoji: '🎬',  color: '#C0392B', mediaType: [MediaLibrary.MediaType.video] },
  screenshots: { label: 'Screenshots', emoji: '📱',  color: '#27AE60', mediaType: [MediaLibrary.MediaType.photo] },
  downloads:   { label: 'Downloads',   emoji: '⬇️',  color: '#8E6BBE', mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video] },
  documents:   { label: 'Documents',   emoji: '📄',  color: '#3498DB', mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video] },
  music:       { label: 'Music',       emoji: '🎵',  color: '#9B59B6', mediaType: [MediaLibrary.MediaType.audio] },
  projects:    { label: 'Projects',    emoji: '💼',  color: '#8E44AD', mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video] },
};

function foldersKey(album: string)           { return `storage_folders_${album}`; }
function filesKey(album: string, sub?: string) {
  return sub ? `storage_files_${album}_${sub}` : `storage_files_${album}`;
}

export default function GalleryScreen() {
  const router = useRouter();
  const { album } = useLocalSearchParams<{ album: string }>();
  const albumKey = (album ?? 'pictures') as string;
  const meta = ALBUM_META[albumKey] ?? ALBUM_META.pictures;

  // ── Cloud view state ─────────────────────────────────────────────
  const [depth, setDepth]               = useState<0 | 1>(0);
  const [currentFolder, setCurrentFolder] = useState<SubFolder | null>(null);
  const [subFolders, setSubFolders]     = useState<SubFolder[]>([]);
  const [files, setFiles]               = useState<CloudFile[]>([]);
  const [loading, setLoading]           = useState(false);
  const [fullView, setFullView]         = useState<CloudFile | null>(null);
  const [cloudSelIds, setCloudSelIds]   = useState<Set<string>>(new Set());
  const [cloudSelMode, setCloudSelMode] = useState(false);
  const [folderDialog, setFolderDialog] = useState(false);
  const [folderName, setFolderName]     = useState('');

  // ── Phone folder browser state ───────────────────────────────────
  const [showAlbums, setShowAlbums]         = useState(false);
  const [phoneAlbums, setPhoneAlbums]       = useState<MediaLibrary.Album[]>([]);
  const [loadingAlbums, setLoadingAlbums]   = useState(false);
  const [showAssets, setShowAssets]         = useState(false);
  const [phoneAssets, setPhoneAssets]       = useState<MediaLibrary.Asset[]>([]);
  const [loadingAssets, setLoadingAssets]   = useState(false);
  const [selectedAlbumLib, setSelectedAlbumLib] = useState<MediaLibrary.Album | null>(null);
  const [pickerSel, setPickerSel]           = useState<Set<string>>(new Set());
  const [uploading, setUploading]           = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadTotal, setUploadTotal]       = useState(0);

  // ── MediaLibrary permission ──────────────────────────────────────
  const [mlPermission, requestMlPermission] = MediaLibrary.usePermissions();

  const depthRef = React.useRef(depth);
  useEffect(() => { depthRef.current = depth; }, [depth]);

  useFocusEffect(useCallback(() => {
    const onBack = () => {
      if (showAssets) { setShowAssets(false); return true; }
      if (showAlbums) { setShowAlbums(false); return true; }
      if (depthRef.current === 1) { goUp(); return true; }
      router.back(); return false;
    };
    const sub = BackHandler.addEventListener('hardwareBackPress', onBack);
    return () => sub.remove();
  }, [router, showAlbums, showAssets]));

  useEffect(() => {
    AsyncStorage.getItem(foldersKey(albumKey))
      .then(v => { if (v) setSubFolders(JSON.parse(v)); }).catch(() => {});
  }, [albumKey]);

  useEffect(() => {
    if (depth === 0) loadCloudFiles(undefined);
  }, [depth, albumKey]);

  // ── Load uploaded cloud files ────────────────────────────────────
  const loadCloudFiles = useCallback(async (sub?: SubFolder) => {
    setLoading(true);
    setFiles([]);
    try {
      const key = filesKey(albumKey, sub?.id);
      const cached = await AsyncStorage.getItem(key);
      const local: CloudFile[] = cached ? JSON.parse(cached) : [];
      if (local.length > 0) setFiles(local);
      try {
        const folder = sub
          ? `my-girls/storage/${albumKey}/${sub.id}`
          : `my-girls/storage/${albumKey}`;
        const cloud = await listCloudinaryImages(folder);
        if (cloud.length > 0) {
          const cloudIds = new Set(cloud.map(p => p.public_id));
          const merged = [...cloud, ...local.filter(p => !cloudIds.has(p.public_id))];
          setFiles(merged);
          await AsyncStorage.setItem(key, JSON.stringify(merged));
        }
      } catch {}
    } catch {}
    setLoading(false);
  }, [albumKey]);

  const goIntoFolder = (folder: SubFolder) => {
    setCurrentFolder(folder);
    setDepth(1);
    setFiles([]);
    loadCloudFiles(folder);
  };

  const goUp = () => {
    setDepth(0);
    setCurrentFolder(null);
    loadCloudFiles(undefined);
  };

  // ── Open phone folder browser ────────────────────────────────────
  const openFolderBrowser = async () => {
    // 1. Get / request permission
    let perm = mlPermission;
    if (!perm?.granted) {
      perm = await requestMlPermission();
    }
    if (!perm?.granted) {
      Alert.alert('Permission வேணும்', 'Settings → My Girls → Permissions → Files & Media → Allow all');
      return;
    }

    // 2. Load phone albums
    setLoadingAlbums(true);
    setShowAlbums(true);
    try {
      const all = await MediaLibrary.getAlbumsAsync({ includeSmartAlbums: true });
      // Sort: non-empty first, then alphabetical
      all.sort((a, b) => (b.assetCount ?? 0) - (a.assetCount ?? 0));
      setPhoneAlbums(all);
    } catch (e: any) {
      Alert.alert('பிழை', 'Folders load ஆகல: ' + (e?.message ?? ''));
      setShowAlbums(false);
    }
    setLoadingAlbums(false);
  };

  // ── Open files inside a phone album ─────────────────────────────
  const openAlbumAssets = async (lib: MediaLibrary.Album) => {
    setSelectedAlbumLib(lib);
    setPickerSel(new Set());
    setLoadingAssets(true);
    setShowAssets(true);
    try {
      const page = await MediaLibrary.getAssetsAsync({
        album: lib,
        mediaType: meta.mediaType,
        first: 300,
        sortBy: MediaLibrary.SortBy.creationTime,
      });
      setPhoneAssets(page.assets);
    } catch (e: any) {
      Alert.alert('பிழை', 'Files load ஆகல: ' + (e?.message ?? ''));
      setShowAssets(false);
    }
    setLoadingAssets(false);
  };

  // ── Toggle file selection in picker ─────────────────────────────
  const togglePickerSel = (id: string) => {
    setPickerSel(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // ── Confirm selection → Cut / Copy ──────────────────────────────
  const confirmSelection = () => {
    if (pickerSel.size === 0) { Alert.alert('Files தேர்வு பண்ணுங்க'); return; }
    const count = pickerSel.size;
    Alert.alert(
      `${count} file${count > 1 ? 's' : ''} select ஆச்சு`,
      'Cloud-ல் எப்படி save பண்ணணும்?',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: '📋 Copy  (Phone-ல் இருக்கும்)',
          onPress: () => { setShowAssets(false); setShowAlbums(false); doMediaUpload('copy'); } },
        { text: '✂️ Cut  (Phone-ல் delete ஆகும்)', style: 'destructive',
          onPress: () => { setShowAssets(false); setShowAlbums(false); doMediaUpload('cut'); } },
      ],
    );
  };

  // ── Upload selected MediaLibrary assets ─────────────────────────
  const doMediaUpload = async (mode: 'copy' | 'cut') => {
    const selected = phoneAssets.filter(a => pickerSel.has(a.id));
    if (!selected.length) return;

    const total = selected.length;
    setUploading(true);
    setUploadProgress(0);
    setUploadTotal(total);

    const folder = currentFolder
      ? `my-girls/storage/${albumKey}/${currentFolder.id}`
      : `my-girls/storage/${albumKey}`;

    const uploaded: { cloudFile: CloudFile; asset: MediaLibrary.Asset }[] = [];
    const failures: { name: string; reason: string }[] = [];

    // Lazy-import expo-file-system/legacy for content:// → file:// cache copy
    const Legacy = await import('expo-file-system/legacy').catch(() => null as any);
    const cacheDir = Legacy?.cacheDirectory || '';

    for (let i = 0; i < selected.length; i++) {
      const asset = selected[i];
      const fname = asset.filename || `file_${i + 1}`;
      let cachedTmp: string | null = null;
      try {
        // getAssetInfoAsync fails for screenshots/Chrome downloads (ExifInterface restricted)
        // Fall back to basic asset URI to avoid blocking the upload
        let localUri = asset.uri;
        try {
          const info = await MediaLibrary.getAssetInfoAsync(asset);
          localUri = info.localUri ?? info.uri ?? asset.uri;
        } catch {
          localUri = asset.uri;
        }
        const srcUri = localUri;
        if (!srcUri) throw new Error('URI கிடைக்கல');
        const mime   = asset.mediaType === 'video' ? 'video/mp4' : 'image/jpeg';

        // HMOS fix: copy content:// → file:// in app cache so upload works reliably
        let uploadUri = srcUri;
        if (Legacy && cacheDir && (srcUri.startsWith('content://') || srcUri.startsWith('ph://'))) {
          const ext = asset.mediaType === 'video' ? 'mp4' : 'jpg';
          cachedTmp = `${cacheDir}upload_${Date.now()}_${i}.${ext}`;
          try {
            await Legacy.copyAsync({ from: srcUri, to: cachedTmp });
            uploadUri = cachedTmp;
          } catch (copyErr: any) {
            // copy failed — fall back to original URI (upload may still try)
            console.warn('Cache copy failed, using original URI:', copyErr?.message);
            cachedTmp = null;
          }
        }

        const result = await uploadUriToCloudinary(uploadUri, mime, folder);
        uploaded.push({ cloudFile: { url: result.url, public_id: result.public_id, isVideo: asset.mediaType === 'video' }, asset });
      } catch (e: any) {
        const reason = (e?.message || String(e) || 'unknown').slice(0, 120);
        failures.push({ name: fname, reason });
        console.warn(`Upload failed for asset ${i} (${fname}):`, reason);
      } finally {
        if (cachedTmp && Legacy) {
          try { await Legacy.deleteAsync(cachedTmp, { idempotent: true }); } catch {}
        }
      }
      setUploadProgress(i + 1);
    }

    // Save to local cache + update screen
    if (uploaded.length > 0) {
      const key = filesKey(albumKey, currentFolder?.id);
      const existing = await AsyncStorage.getItem(key).catch(() => null);
      const prev: CloudFile[] = existing ? JSON.parse(existing) : [];
      const existingIds = new Set(prev.map(f => f.public_id));
      const newOnes = uploaded.map(u => u.cloudFile).filter(f => !existingIds.has(f.public_id));
      const updated = [...newOnes, ...prev];
      await AsyncStorage.setItem(key, JSON.stringify(updated));
      setFiles(updated);
    }

    // Cut: delete from phone
    if (mode === 'cut' && uploaded.length > 0) {
      try {
        await MediaLibrary.deleteAssetsAsync(uploaded.map(u => u.asset));
      } catch {
        // Some devices need MANAGE_MEDIA permission — silent fail, show note
        Alert.alert(
          '⚠️ Delete பண்ண முடியல',
          'Upload ஆச்சு ✅ ஆனா phone-ல் delete பண்ண permission இல்லை. Settings → My Girls → Permissions → Files → Delete முடிக்கணும்.',
        );
      }
    }

    setUploading(false);
    setUploadProgress(0);
    setUploadTotal(0);
    setPickerSel(new Set());

    const reasonsText = failures.length
      ? '\n\nFail reasons:\n' + failures.slice(0, 3).map(f => `• ${f.name}: ${f.reason}`).join('\n')
      : '';
    if (uploaded.length === 0 && total > 0) {
      Alert.alert('❌ Upload பிழை', `0/${total} files saved.` + reasonsText);
    } else if (!(mode === 'cut')) {
      Alert.alert(
        failures.length ? '⚠️ Partial Upload' : '✅ Upload ஆச்சு!',
        `${uploaded.length}/${total} files cloud-ல் save ஆச்சு.` + reasonsText,
      );
    } else if (uploaded.length > 0) {
      Alert.alert(
        failures.length ? '⚠️ Partial Cut' : '✅ Cut & Upload ஆச்சு!',
        `${uploaded.length}/${total} files cloud-ல் save ஆச்சு.` + reasonsText,
      );
    }
  };

  // ── New cloud sub-folder ─────────────────────────────────────────
  const confirmNewFolder = async () => {
    const name = folderName.trim();
    if (!name) { Alert.alert('பிழை', 'Folder பெயர் உள்ளிடுங்க'); return; }
    const id = name.toLowerCase().replace(/\s+/g, '_') + '_' + Date.now();
    const updated = [...subFolders, { id, label: name }];
    setSubFolders(updated);
    await AsyncStorage.setItem(foldersKey(albumKey), JSON.stringify(updated));
    setFolderDialog(false);
    setFolderName('');
    Alert.alert('✅', `"${name}" folder உருவாக்கப்பட்டது!`);
  };

  // ── Delete selected cloud files ──────────────────────────────────
  const deleteCloudSelected = async () => {
    const ids = [...cloudSelIds];
    setCloudSelMode(false);
    setCloudSelIds(new Set());
    for (const id of ids) { try { await deleteFromCloudinary(id); } catch {} }
    const key = filesKey(albumKey, currentFolder?.id);
    const idSet = new Set(ids);
    setFiles(prev => {
      const updated = prev.filter(f => !idSet.has(f.public_id));
      AsyncStorage.setItem(key, JSON.stringify(updated)).catch(() => {});
      return updated;
    });
  };

  // ─────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────
  const headerTitle = depth === 1 && currentFolder
    ? `${meta.emoji} ${currentFolder.label}`
    : `${meta.emoji} ${meta.label}`;

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Header */}
      <View style={[s.header, { backgroundColor: meta.color }]}>
        <TouchableOpacity onPress={depth === 1 ? goUp : () => router.back()} style={s.backBtn}>
          <Text style={s.backTxt}>{depth === 1 ? '‹ Back' : '‹'}</Text>
        </TouchableOpacity>
        <Text style={s.headerTitle} numberOfLines={1}>{headerTitle}</Text>
        {cloudSelMode
          ? <TouchableOpacity onPress={() => { setCloudSelMode(false); setCloudSelIds(new Set()); }} style={s.backBtn}>
              <Text style={s.backTxt}>✕</Text>
            </TouchableOpacity>
          : <View style={{ width: 60 }} />}
      </View>

      {/* Upload progress */}
      {uploading && (
        <View style={s.uploadBar}>
          <ActivityIndicator color="#fff" size="small" />
          <Text style={s.uploadBarTxt}>Upload பண்றேன்... {uploadProgress}/{uploadTotal}</Text>
        </View>
      )}

      {/* Cloud selection bar */}
      {cloudSelMode && cloudSelIds.size > 0 && (
        <View style={s.selBar}>
          <Text style={s.selCount}>{cloudSelIds.size} selected</Text>
          <TouchableOpacity style={s.selDelBtn} onPress={deleteCloudSelected}>
            <Text style={s.selDelTxt}>🗑️ Delete</Text>
          </TouchableOpacity>
        </View>
      )}

      <ScrollView style={{ flex: 1, backgroundColor: '#111' }} contentContainerStyle={{ paddingBottom: 24 }}>

        {/* Action buttons */}
        <View style={s.actionRow}>
          <TouchableOpacity style={s.uploadBtn} onPress={openFolderBrowser} disabled={uploading}>
            <Text style={s.uploadBtnTxt}>⬆ Upload</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.newFolderBtn} onPress={() => { setFolderName(''); setFolderDialog(true); }}>
            <Text style={s.newFolderTxt}>📁 New Folder</Text>
          </TouchableOpacity>
        </View>

        {/* Sub-folders */}
        {depth === 0 && subFolders.length > 0 && (
          <View style={s.foldersRow}>
            {subFolders.map(folder => (
              <TouchableOpacity key={folder.id} style={s.folderChip} onPress={() => goIntoFolder(folder)}>
                <Text style={s.folderChipEmoji}>📁</Text>
                <Text style={s.folderChipLabel} numberOfLines={1}>{folder.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Cloud files grid */}
        {loading ? (
          <View style={s.center}>
            <ActivityIndicator color={meta.color} size="large" />
            <Text style={s.loadingTxt}>Cloud-ல் இருந்து load பண்றேன்...</Text>
          </View>
        ) : files.length === 0 ? (
          <View style={s.center}>
            <Text style={s.emptyEmoji}>{meta.emoji}</Text>
            <Text style={s.emptyTxt}>
              {depth === 1 ? `${currentFolder?.label} empty` : `${meta.label} empty`}
              {'\n'}⬆ Upload பண்ணுங்க
            </Text>
          </View>
        ) : (
          <View style={s.grid}>
            {files.map(file => {
              const isSel = cloudSelIds.has(file.public_id);
              return (
                <TouchableOpacity key={file.public_id}
                  style={[s.thumb, isSel && s.thumbSel]}
                  onPress={() => cloudSelMode ? setCloudSelIds(prev => { const n = new Set(prev); n.has(file.public_id) ? n.delete(file.public_id) : n.add(file.public_id); return n; }) : setFullView(file)}
                  onLongPress={() => { setCloudSelMode(true); setCloudSelIds(new Set([file.public_id])); }}
                  activeOpacity={0.85}>
                  {file.isVideo
                    ? <View style={[s.thumbImg, s.videoThumb]}><Text style={s.videoPlay}>▶</Text></View>
                    : <Image source={{ uri: file.url }} style={s.thumbImg} resizeMode="cover" />}
                  {isSel && <View style={s.checkOverlay}><Text style={s.checkTxt}>✓</Text></View>}
                </TouchableOpacity>
              );
            })}
          </View>
        )}
      </ScrollView>

      {/* ── MODAL 1: Phone Albums browser ───────────────────────── */}
      <Modal visible={showAlbums} animationType="slide" onRequestClose={() => setShowAlbums(false)}>
        <SafeAreaView style={[s.safe, { backgroundColor: '#1a1a1a' }]} edges={['top','bottom']}>
          <View style={[s.header, { backgroundColor: meta.color }]}>
            <TouchableOpacity onPress={() => setShowAlbums(false)} style={s.backBtn}>
              <Text style={s.backTxt}>✕</Text>
            </TouchableOpacity>
            <Text style={s.headerTitle}>📂 Phone Folders</Text>
            <View style={{ width: 60 }} />
          </View>
          {loadingAlbums ? (
            <View style={s.center}>
              <ActivityIndicator color={meta.color} size="large" />
              <Text style={s.loadingTxt}>Folders load பண்றேன்...</Text>
            </View>
          ) : (
            <FlatList
              data={phoneAlbums}
              keyExtractor={a => a.id}
              contentContainerStyle={{ paddingVertical: 8 }}
              renderItem={({ item }) => (
                <TouchableOpacity style={s.albumRow} onPress={() => openAlbumAssets(item)}>
                  <Text style={s.albumIcon}>📁</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={s.albumName}>{item.title}</Text>
                    <Text style={s.albumCount}>{item.assetCount ?? 0} files</Text>
                  </View>
                  <Text style={s.albumArrow}>›</Text>
                </TouchableOpacity>
              )}
              ItemSeparatorComponent={() => <View style={s.sep} />}
            />
          )}
        </SafeAreaView>
      </Modal>

      {/* ── MODAL 2: Files in selected album ────────────────────── */}
      <Modal visible={showAssets} animationType="slide" onRequestClose={() => setShowAssets(false)}>
        <SafeAreaView style={[s.safe, { backgroundColor: '#111' }]} edges={['top','bottom']}>
          <View style={[s.header, { backgroundColor: meta.color }]}>
            <TouchableOpacity onPress={() => setShowAssets(false)} style={s.backBtn}>
              <Text style={s.backTxt}>‹ Back</Text>
            </TouchableOpacity>
            <Text style={s.headerTitle} numberOfLines={1}>
              {selectedAlbumLib?.title ?? 'Files'}
            </Text>
            {pickerSel.size > 0 ? (
              <TouchableOpacity onPress={confirmSelection} style={[s.doneBtn, { backgroundColor: meta.color }]}>
                <Text style={s.doneBtnTxt}>Done ({pickerSel.size})</Text>
              </TouchableOpacity>
            ) : <View style={{ width: 80 }} />}
          </View>

          {pickerSel.size > 0 && (
            <View style={s.pickerSelBar}>
              <Text style={s.pickerSelTxt}>{pickerSel.size} file{pickerSel.size > 1 ? 's' : ''} select ஆச்சு</Text>
              <TouchableOpacity style={[s.selDelBtn, { backgroundColor: meta.color }]} onPress={confirmSelection}>
                <Text style={s.selDelTxt}>⬆ Upload</Text>
              </TouchableOpacity>
            </View>
          )}

          {loadingAssets ? (
            <View style={s.center}>
              <ActivityIndicator color={meta.color} size="large" />
              <Text style={s.loadingTxt}>Files load பண்றேன்...</Text>
            </View>
          ) : phoneAssets.length === 0 ? (
            <View style={s.center}>
              <Text style={s.emptyEmoji}>📭</Text>
              <Text style={s.emptyTxt}>இந்த folder-ல் files இல்லை</Text>
            </View>
          ) : (
            <FlatList
              data={phoneAssets}
              keyExtractor={a => a.id}
              numColumns={COLS}
              contentContainerStyle={{ gap: 2, padding: 2 }}
              columnWrapperStyle={{ gap: 2 }}
              renderItem={({ item }) => {
                const isSel = pickerSel.has(item.id);
                return (
                  <TouchableOpacity
                    style={[s.thumb, isSel && s.thumbSel]}
                    onPress={() => togglePickerSel(item.id)}
                    activeOpacity={0.8}>
                    <Image source={{ uri: item.uri }} style={s.thumbImg} resizeMode="cover" />
                    {item.mediaType === 'video' && (
                      <View style={s.videoTag}><Text style={s.videoTagTxt}>▶</Text></View>
                    )}
                    {isSel && <View style={s.checkOverlay}><Text style={s.checkTxt}>✓</Text></View>}
                  </TouchableOpacity>
                );
              }}
            />
          )}
        </SafeAreaView>
      </Modal>

      {/* Full view modal */}
      <Modal visible={!!fullView} transparent animationType="fade" onRequestClose={() => setFullView(null)}>
        {fullView && (
          <View style={s.previewBg}>
            <TouchableOpacity style={s.previewClose} onPress={() => setFullView(null)}>
              <Text style={s.previewCloseTxt}>✕</Text>
            </TouchableOpacity>
            {fullView.isVideo
              ? <View style={s.videoPreview}><Text style={{ fontSize: 64 }}>▶</Text></View>
              : <Image source={{ uri: fullView.url }} style={s.previewImg} resizeMode="contain" />}
          </View>
        )}
      </Modal>

      {/* New cloud sub-folder dialog */}
      <Modal visible={folderDialog} transparent animationType="fade" onRequestClose={() => setFolderDialog(false)}>
        <View style={s.dialogOverlay}>
          <View style={s.dialog}>
            <Text style={s.dialogTitle}>📁 New Folder</Text>
            <TextInput style={s.dialogInput} placeholder="Folder பெயர்..." placeholderTextColor="#aaa"
              value={folderName} onChangeText={setFolderName} autoFocus onSubmitEditing={confirmNewFolder} />
            <View style={s.dialogBtns}>
              <TouchableOpacity style={s.dialogCancel} onPress={() => setFolderDialog(false)}>
                <Text style={s.dialogCancelTxt}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.dialogOk, { backgroundColor: meta.color }]} onPress={confirmNewFolder}>
                <Text style={s.dialogOkTxt}>உருவாக்கு</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe:           { flex: 1, backgroundColor: '#111' },
  header:         { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 12 },
  backBtn:        { minWidth: 60 },
  backTxt:        { color: '#fff', fontSize: 17, fontWeight: '600' },
  headerTitle:    { flex: 1, color: '#fff', fontSize: 18, fontWeight: 'bold', textAlign: 'center' },
  doneBtn:        { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, minWidth: 80, alignItems: 'center' },
  doneBtnTxt:     { color: '#fff', fontSize: 14, fontWeight: 'bold' },
  uploadBar:      { flexDirection: 'row', backgroundColor: '#1565C0', padding: 10, gap: 10, alignItems: 'center' },
  uploadBarTxt:   { color: '#fff', fontSize: 14 },
  selBar:         { flexDirection: 'row', backgroundColor: '#333', padding: 10, alignItems: 'center', gap: 12 },
  selCount:       { color: '#fff', fontSize: 14, flex: 1 },
  selDelBtn:      { backgroundColor: '#c62828', paddingHorizontal: 14, paddingVertical: 7, borderRadius: 8 },
  selDelTxt:      { color: '#fff', fontSize: 13, fontWeight: '600' },
  pickerSelBar:   { flexDirection: 'row', backgroundColor: '#222', padding: 10, alignItems: 'center', gap: 12 },
  pickerSelTxt:   { color: '#fff', fontSize: 14, flex: 1 },
  actionRow:      { flexDirection: 'row', gap: 12, padding: 14 },
  uploadBtn:      { flex: 1, backgroundColor: '#E8821A', borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  uploadBtnTxt:   { color: '#fff', fontSize: 16, fontWeight: 'bold' },
  newFolderBtn:   { flex: 1, backgroundColor: '#444', borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  newFolderTxt:   { color: '#ccc', fontSize: 16, fontWeight: '600' },
  foldersRow:     { flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingHorizontal: 14, paddingBottom: 10 },
  folderChip:     { backgroundColor: '#2a2a2a', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 6 },
  folderChipEmoji:{ fontSize: 18 },
  folderChipLabel:{ color: '#ddd', fontSize: 13, fontWeight: '500' },
  grid:           { flexDirection: 'row', flexWrap: 'wrap', gap: 2, paddingHorizontal: 2 },
  thumb:          { width: THUMB, height: THUMB, overflow: 'hidden' },
  thumbSel:       { opacity: 0.55 },
  thumbImg:       { width: THUMB, height: THUMB },
  videoThumb:     { backgroundColor: '#1a1a1a', justifyContent: 'center', alignItems: 'center' },
  videoPlay:      { fontSize: 32, color: '#fff' },
  videoTag:       { position: 'absolute', bottom: 4, right: 4, backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 4, padding: 2 },
  videoTagTxt:    { color: '#fff', fontSize: 10 },
  checkOverlay:   { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center' },
  checkTxt:       { color: '#fff', fontSize: 28, fontWeight: 'bold' },
  center:         { alignItems: 'center', justifyContent: 'center', paddingTop: 80 },
  loadingTxt:     { color: '#aaa', marginTop: 14, fontSize: 14 },
  emptyEmoji:     { fontSize: 56, marginBottom: 12 },
  emptyTxt:       { color: '#888', fontSize: 15, textAlign: 'center', lineHeight: 24 },
  albumRow:       { flexDirection: 'row', alignItems: 'center', padding: 16, backgroundColor: '#1e1e1e' },
  albumIcon:      { fontSize: 28, marginRight: 12 },
  albumName:      { color: '#fff', fontSize: 16, fontWeight: '600' },
  albumCount:     { color: '#888', fontSize: 12, marginTop: 2 },
  albumArrow:     { color: '#888', fontSize: 24 },
  sep:            { height: 1, backgroundColor: '#2a2a2a' },
  previewBg:      { flex: 1, backgroundColor: '#000', justifyContent: 'center', alignItems: 'center' },
  previewClose:   { position: 'absolute', top: 50, right: 20, zIndex: 10, padding: 10 },
  previewCloseTxt:{ color: '#fff', fontSize: 24 },
  previewImg:     { width: '100%', height: '80%' },
  videoPreview:   { alignItems: 'center', justifyContent: 'center' },
  dialogOverlay:  { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', alignItems: 'center', padding: 24 },
  dialog:         { backgroundColor: '#222', borderRadius: 16, padding: 24, width: '100%' },
  dialogTitle:    { color: '#fff', fontSize: 18, fontWeight: 'bold', marginBottom: 16 },
  dialogInput:    { backgroundColor: '#333', color: '#fff', borderRadius: 10, padding: 12, fontSize: 15, marginBottom: 20 },
  dialogBtns:     { flexDirection: 'row', gap: 12 },
  dialogCancel:   { flex: 1, backgroundColor: '#444', borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  dialogCancelTxt:{ color: '#ccc', fontSize: 15 },
  dialogOk:       { flex: 1, borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  dialogOkTxt:    { color: '#fff', fontSize: 15, fontWeight: 'bold' },
});
