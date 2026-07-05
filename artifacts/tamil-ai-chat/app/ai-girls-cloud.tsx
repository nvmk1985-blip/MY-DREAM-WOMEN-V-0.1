import React, { useState, useCallback, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, FlatList,
  StyleSheet, Alert, ActivityIndicator,
  Image, Dimensions, ScrollView, Platform, TextInput, Modal, BackHandler,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useRouter, useFocusEffect } from 'expo-router';
import * as FileSystem from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import * as ImagePicker from 'expo-image-picker';
import { ALL_PERSONAS } from '../constants/personas';
import {
  listCloudinaryImages,
  listCloudinarySubfolders,
  uploadToCloudinary,
  uploadUriToCloudinary,
  deleteFromCloudinary,
  createCloudinaryFolder,
} from '../services/api';
import AsyncStorage from '@react-native-async-storage/async-storage';

const CUSTOM_CHARS_KEY = 'cloud_custom_chars';
const CUSTOM_STYLES_KEY = 'cloud_custom_styles';

const { width } = Dimensions.get('window');
const PHOTO_COL = 3;
const PHOTO_SIZE = (width - 4 * (PHOTO_COL + 1)) / PHOTO_COL;

const PHOTO_STYLES = [
  { id: 'breast',    label: 'Breast Show'  },
  { id: 'buttocks',  label: 'Buttocks'     },
  { id: 'cleavage',  label: 'Cleavage'     },
  { id: 'halfbreast',label: 'Half Breast'  },
  { id: 'highslit',  label: 'High Slit'    },
  { id: 'legs',      label: 'Legs Spread'  },
  { id: 'lingerie',  label: 'Lingerie'     },
  { id: 'lowneck',   label: 'Low Neckline' },
  { id: 'normal',    label: 'Normal Photo' },
  { id: 'nude',      label: 'Nude'         },
  { id: 'seductive', label: 'Seductive'    },
  { id: 'seminude',  label: 'Semi Nude'    },
  { id: 'sleeping',  label: 'Sleeping'     },
  { id: 'wet',       label: 'Wet Clothes'  },
  { id: 'saree',     label: 'Saree Tuck'   },
];

interface CloudPhoto { url: string; public_id: string }

type Depth = 0 | 1 | 2;

const FOLDER_COLORS = ['#E91E63','#9C27B0','#3F51B5','#2196F3','#009688','#FF5722','#795548','#607D8B'];

export default function AIGirlsCloudScreen() {
  const router = useRouter();

  const [depth, setDepth] = useState<Depth>(0);
  const [selectedChar, setSelectedChar] = useState<{ id: string; name: string; color: string; letter: string } | null>(null);
  const [selectedStyle, setSelectedStyle] = useState<{ id: string; label: string } | null>(null);

  // Photos state (depth 2)
  const [photos, setPhotos] = useState<CloudPhoto[]>([]);
  const [loadingPhotos, setLoadingPhotos] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [fullView, setFullView] = useState<CloudPhoto | null>(null);
  const [savingPhoto, setSavingPhoto] = useState(false);

  // Custom folders
  const [customChars, setCustomChars] = useState<{ id: string; name: string; color: string; letter: string }[]>([]);
  const [customStyles, setCustomStyles] = useState<{ id: string; label: string }[]>([]);

  // New Folder dialog
  const [folderDialog, setFolderDialog] = useState(false);
  const [folderName, setFolderName] = useState('');

  // Photo multi-select
  const [photoSelMode, setPhotoSelMode] = useState(false);
  const [photoSelIds, setPhotoSelIds] = useState<Set<string>>(new Set());

  // Custom delete confirm (Alert.alert blocked on Chrome web)
  const [deleteTarget, setDeleteTarget] = useState<CloudPhoto | null>(null);
  const [deleteFolderTarget, setDeleteFolderTarget] = useState<{ id: string; name: string; type: 'char' | 'style' } | null>(null);

  // Upload progress
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadTotal, setUploadTotal] = useState(0);


  // Load custom folders from storage — auto-sync from Cloudinary if cache is empty (e.g. after reinstall)
  useEffect(() => {
    const CHAR_COLORS = ['#E91E8C', '#9C27B0', '#3F51B5', '#00BCD4', '#4CAF50', '#FF5722', '#FF9800', '#795548'];
    const init = async () => {
      const charsRaw = await AsyncStorage.getItem(CUSTOM_CHARS_KEY).catch(() => null);
      if (charsRaw) {
        setCustomChars(JSON.parse(charsRaw));
      } else {
        // Reinstall detected: cache empty — auto-rebuild character list from Cloudinary
        try {
          const folders = await listCloudinarySubfolders('my-girls');
          // Exclude built-in persona IDs and known non-char folders
          const builtInIds = new Set(
            ALL_PERSONAS.filter(p => p.gender === 'female').map(p => p.id)
          );
          builtInIds.add('videos');
          const customFolders = folders.filter((f: string) => !builtInIds.has(f));
          if (customFolders.length > 0) {
            const recovered = customFolders.map((folderId: string, i: number) => {
              const namePart = folderId.replace(/-/g, ' ');
              const name = namePart.charAt(0).toUpperCase() + namePart.slice(1);
              return { id: folderId, name, color: CHAR_COLORS[i % CHAR_COLORS.length], letter: name.charAt(0).toUpperCase() };
            });
            setCustomChars(recovered);
            await AsyncStorage.setItem(CUSTOM_CHARS_KEY, JSON.stringify(recovered));
          }
        } catch { /* silent — will show empty list */ }
      }
      const stylesRaw = await AsyncStorage.getItem(CUSTOM_STYLES_KEY).catch(() => null);
      if (stylesRaw) setCustomStyles(JSON.parse(stylesRaw));
    };
    init();
  }, []);

  // Base personas
  const basePersonas = ALL_PERSONAS.filter(p => p.gender === 'female').map(p => ({
    id: p.id,
    name: p.name,
    color: p.avatarColor,
    letter: p.avatarLetter || p.name.charAt(0),
  }));

  const personas = [...basePersonas, ...customChars];
  const photoStyles = [...PHOTO_STYLES, ...customStyles];

  const handleNewFolder = () => {
    setFolderName('');
    setFolderDialog(true);
  };

  // ── Upload via System Picker (Cut / Copy) ────────────────────────────────

  const doUpload = async (
    pickedAssets: ImagePicker.ImagePickerAsset[],
    charId: string,
    styleId: string,
    styleLabel: string,
    action: 'cut' | 'copy',
  ) => {
    const total = pickedAssets.length;
    setUploading(true);
    setUploadProgress(0);
    setUploadTotal(total);

    const newPhotos: CloudPhoto[] = [];
    const failures: { name: string; reason: string }[] = [];
    let done = 0;

    for (let i = 0; i < pickedAssets.length; i++) {
      const asset = pickedAssets[i];
      const fname = asset.fileName || `file_${i + 1}`;
      try {
        const folder = `my-girls/${charId}/${styleId}`;
        const mime = asset.mimeType || (asset.type === 'video' ? 'video/mp4' : 'image/jpeg');
        const uploaded = await uploadUriToCloudinary(asset.uri, mime, folder);
        newPhotos.push({ url: uploaded.url, public_id: uploaded.public_id });
        done++;
      } catch (e: any) {
        const reason = (e?.message || String(e) || 'unknown').slice(0, 120);
        failures.push({ name: fname, reason });
        console.warn(`Upload failed (${fname}):`, reason);
      }
      setUploadProgress(i + 1);
    }

    // Save to cache + update UI
    if (newPhotos.length) {
      const key = `cloud_photos_${charId}_${styleId}`;
      const cached = await AsyncStorage.getItem(key);
      const existing: CloudPhoto[] = cached ? JSON.parse(cached) : [];
      const merged = [...newPhotos, ...existing];
      await AsyncStorage.setItem(key, JSON.stringify(merged));
      if (selectedChar?.id === charId && selectedStyle?.id === styleId) {
        setPhotos(merged);
      }
    }

    // CUT: delete originals from device after successful upload
    if (action === 'cut' && done > 0) {
      try {
        const writePerm = await MediaLibrary.requestPermissionsAsync(true);
        if (writePerm.granted) {
          // Method 1: Use assetId directly (most reliable on Android/HarmonyOS)
          const assetIds = pickedAssets
            .filter(a => a.assetId)
            .map(a => a.assetId as string);
          if (assetIds.length > 0) {
            await MediaLibrary.deleteAssetsAsync(assetIds);
          } else {
            // Method 2: file:// URI → FileSystem.deleteAsync directly
            for (const a of pickedAssets) {
              if (a.uri.startsWith('file://')) {
                await FileSystem.deleteAsync(a.uri, { idempotent: true }).catch(() => {});
              }
            }
            // Method 3: Fallback — scan MediaLibrary by filename
            const filenames = new Set(pickedAssets.map(a => a.uri.split('/').pop()).filter(Boolean));
            if (filenames.size > 0) {
              const toDelete: string[] = [];
              let cursor: string | undefined;
              do {
                const res = await MediaLibrary.getAssetsAsync({ mediaType: 'photo', first: 500, after: cursor });
                for (const ma of res.assets) {
                  if (filenames.has(ma.filename)) toDelete.push(ma.id);
                }
                cursor = res.hasNextPage ? res.endCursor : undefined;
              } while (cursor && toDelete.length < pickedAssets.length);
              if (toDelete.length > 0) await MediaLibrary.deleteAssetsAsync(toDelete);
            }
          }
        }
      } catch { /* deletion failed — upload still succeeded */ }
    }

    setUploading(false);
    setUploadProgress(0);
    setUploadTotal(0);

    const reasonsText = failures.length
      ? '\n\nFail reasons:\n' + failures.slice(0, 3).map(f => `• ${f.name}: ${f.reason}`).join('\n')
      : '';
    if (done > 0) {
      const head = action === 'cut'
        ? `${done}/${total} photos cloud-ல் save ஆச்சு. Mobile-ல் delete ஆச்சு.`
        : `${done}/${total} photos "${styleLabel}" cloud folder-ல் save ஆச்சு.`;
      Alert.alert(
        failures.length ? '⚠️ Partial Upload' : '✅ Upload ஆச்சு!',
        head + (failures.length ? `\n${failures.length} fail ஆச்சு.` : '') + reasonsText,
      );
    } else {
      Alert.alert('Upload பிழை', `0/${total} upload ஆச்சு.` + reasonsText);
    }
  };

  const openImagePicker = async (charId: string, charName: string, styleId: string, styleLabel: string) => {
    if (Platform.OS === 'web') { Alert.alert('Web', 'Upload mobile-ல் மட்டும் வேலை செய்யும்'); return; }

    try {
      // Explicitly request permission first — avoids silent failure on Honor HMOS
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission வேணும்', 'Settings → My Girls → Permissions → Photos → Allow all');
        return;
      }
    } catch { /* permission API not available on this device — proceed anyway */ }

    let result: ImagePicker.ImagePickerResult;
    try {
      // ActivityResultLauncher registration settle panna wait pannrom
      await new Promise(r => setTimeout(r, 350));
      result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'] as any,
        allowsMultipleSelection: true,
        quality: 0.9,
        exif: false,
      });
    } catch (e: any) {
      Alert.alert('பிழை', 'Photo picker திறக்கல: ' + (e?.message ?? 'unknown'));
      return;
    }

    if (result.canceled || result.assets.length === 0) return;

    const count = result.assets.length;
    const picked = result.assets;

    Alert.alert(
      `${count} photo${count > 1 ? 's' : ''} select ஆச்சு`,
      'Cloud-ல் எப்படி save பண்ணணும்?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: '📋 Copy  (Phone-ல் இருக்கும்)',
          onPress: () => doUpload(picked, charId, styleId, styleLabel, 'copy'),
        },
        {
          text: '✂️ Cut  (Phone-ல் delete ஆகும்)',
          style: 'destructive',
          onPress: () => doUpload(picked, charId, styleId, styleLabel, 'cut'),
        },
      ],
    );
  };

  const handleUpload = () => {
    if (!selectedChar || !selectedStyle) return;
    openImagePicker(selectedChar.id, selectedChar.name, selectedStyle.id, selectedStyle.label);
  };

  const handleQuickUpload = (char: typeof personas[0], style: typeof photoStyles[0]) => {
    openImagePicker(char.id, char.name, style.id, style.label);
  };

  const togglePhotoSel = (id: string) => {
    setPhotoSelIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const exitPhotoSel = () => { setPhotoSelMode(false); setPhotoSelIds(new Set()); };

  const deleteSelectedPhotos = async () => {
    const ids = [...photoSelIds];
    exitPhotoSel();
    for (const id of ids) { try { await deleteFromCloudinary(id); } catch {} }
    setPhotos(prev => {
      const idSet = new Set(ids);
      const updated = prev.filter(p => !idSet.has(p.public_id));
      if (selectedChar && selectedStyle) {
        const key = `cloud_photos_${selectedChar.id}_${selectedStyle.id}`;
        AsyncStorage.setItem(key, JSON.stringify(updated)).catch(() => {});
      }
      return updated;
    });
  };

  const confirmNewFolder = async () => {
    const name = folderName.trim();
    if (!name) { Alert.alert('பிழை', 'Folder பெயர் உள்ளிடுங்க'); return; }
    setFolderDialog(false);

    if (depth === 0) {
      // Add custom character folder
      // ID must be stable — never use Date.now() — Cloudinary path = my-girls/${id}/...
      const id = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') || 'folder';
      const color = FOLDER_COLORS[Math.floor(Math.random() * FOLDER_COLORS.length)];
      const newChar = { id, name, color, letter: name.charAt(0).toUpperCase() };
      const updated = [...customChars, newChar];
      setCustomChars(updated);
      await AsyncStorage.setItem(CUSTOM_CHARS_KEY, JSON.stringify(updated));
    } else if (depth === 1) {
      // Add custom style folder
      // ID must be stable — never use Date.now()
      const id = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') || 'style';
      const newStyle = { id, label: name };
      const updated = [...customStyles, newStyle];
      setCustomStyles(updated);
      await AsyncStorage.setItem(CUSTOM_STYLES_KEY, JSON.stringify(updated));
    }
    Alert.alert('✅ Folder உருவாக்கப்பட்டது!', `"${name}" folder add ஆச்சு.`);
  };

  const loadPhotos = useCallback(async (charId: string, styleId: string) => {
    setLoadingPhotos(true);
    setPhotos([]);
    try {
      // 1. Load from AsyncStorage first (instant, works offline)
      const key = `cloud_photos_${charId}_${styleId}`;
      const cached = await AsyncStorage.getItem(key);
      const local: CloudPhoto[] = cached ? JSON.parse(cached) : [];
      if (local.length > 0) setPhotos(local);

      // 2. Try Cloudinary list in background and merge
      try {
        const folder = `my-girls/${charId}/${styleId}`;
        const cloud = await listCloudinaryImages(folder);
        if (cloud.length > 0) {
          // Merge: cloud list wins, add any local-only items
          const cloudIds = new Set(cloud.map(p => p.public_id));
          const localOnly = local.filter(p => !cloudIds.has(p.public_id));
          const merged = [...cloud, ...localOnly];
          setPhotos(merged);
          // Update cache with merged result
          await AsyncStorage.setItem(key, JSON.stringify(merged));
        } else if (local.length === 0) {
          // Both cloud and cache empty — folder genuinely empty (after reinstall or deleted)
          await AsyncStorage.removeItem(key);
          setPhotos([]);
        }
        // If cloud returns empty but local cache has items, keep showing local cache
      } catch {
        // Cloudinary list failed — local cache is still shown
      }
    } catch {
      // ignore
    } finally {
      setLoadingPhotos(false);
    }
  }, []);

  const depthRef = React.useRef(depth);
  useEffect(() => { depthRef.current = depth; }, [depth]);

  const goBack = useCallback(() => {
    if (depthRef.current === 2) { setDepth(1); setPhotos([]); return true; }
    if (depthRef.current === 1) { setDepth(0); setSelectedChar(null); return true; }
    router.back(); return false;
  }, [router]);

  // Native: intercept hardware back button
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS === 'web') return;
      const sub = BackHandler.addEventListener('hardwareBackPress', goBack);
      return () => sub.remove();
    }, [goBack])
  );

  // Web: intercept browser back button via History API
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    // Push an initial history state so the first back press triggers popstate
    window.history.pushState({ cloudDepth: 0 }, '');

    const onPopState = () => {
      const d = depthRef.current;
      if (d > 0) {
        // Stay on this screen, go back one depth level
        goBack();
        // Re-push a state so the next back press is also intercepted
        window.history.pushState({ cloudDepth: d - 1 }, '');
      }
      // d === 0 → let browser navigate naturally to previous page
    };

    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []); // run once on mount

  const selectChar = (char: typeof personas[0]) => {
    setSelectedChar(char);
    setDepth(1);
  };

  const selectStyle = (style: typeof PHOTO_STYLES[0]) => {
    setSelectedStyle(style);
    setDepth(2);
    if (selectedChar) {
      createCloudinaryFolder(`my-girls/${selectedChar.id}/${style.id}`).catch(() => {});
      loadPhotos(selectedChar.id, style.id);
    }
  };

  const doDeletePhoto = async (photo: CloudPhoto) => {
    try { await deleteFromCloudinary(photo.public_id); } catch {}
    setPhotos(prev => {
      const updated = prev.filter(p => p.public_id !== photo.public_id);
      if (selectedChar && selectedStyle) {
        const key = `cloud_photos_${selectedChar.id}_${selectedStyle.id}`;
        AsyncStorage.setItem(key, JSON.stringify(updated)).catch(() => {});
      }
      return updated;
    });
    setFullView(null);
    setDeleteTarget(null);
  };

  const handleDeletePhoto = (photo: CloudPhoto) => {
    setDeleteTarget(photo);
  };

  const handleSaveToGallery = async (photo: CloudPhoto) => {
    if (savingPhoto) return;
    setSavingPhoto(true);
    try {
      const { status } = await MediaLibrary.requestPermissionsAsync(true);
      if (status !== 'granted') {
        Alert.alert('Permission இல்லை', 'Gallery-ல் save பண்ண permission தேவை');
        return;
      }
      const fileUri = FileSystem.cacheDirectory + 'save_' + Date.now() + '.jpg';
      const { uri } = await FileSystem.downloadAsync(photo.url, fileUri);
      await MediaLibrary.createAssetAsync(uri);
      Alert.alert('✅ Saved!', 'Photo Camera Roll-ல் save ஆச்சு');
    } catch {
      Alert.alert('Error', 'Save பண்ண முடியல — Try again');
    } finally {
      setSavingPhoto(false);
    }
  };

  const handleDeleteFolder = (id: string, name: string, type: 'char' | 'style') => {
    const isBuiltIn = type === 'char'
      ? basePersonas.some(p => p.id === id)
      : PHOTO_STYLES.some(s => s.id === id);
    if (isBuiltIn) return; // built-in folders cannot be deleted
    setDeleteFolderTarget({ id, name, type });
  };

  const doDeleteFolder = async () => {
    if (!deleteFolderTarget) return;
    const { id, name, type } = deleteFolderTarget;
    setDeleteFolderTarget(null);
    if (type === 'char') {
      const updated = customChars.filter(c => c.id !== id);
      setCustomChars(updated);
      await AsyncStorage.setItem(CUSTOM_CHARS_KEY, JSON.stringify(updated));
      // Delete all Cloudinary photos in each style subfolder
      try {
        const allStyles = [...PHOTO_STYLES, ...customStyles];
        for (const style of allStyles) {
          const imgs = await listCloudinaryImages(`my-girls/${id}/${style.id}`).catch(() => []);
          for (const img of imgs) { deleteFromCloudinary(img.public_id).catch(() => {}); }
        }
      } catch {}
    } else {
      const updated = customStyles.filter(s => s.id !== id);
      setCustomStyles(updated);
      await AsyncStorage.setItem(CUSTOM_STYLES_KEY, JSON.stringify(updated));
      // Delete all Cloudinary photos in this style folder (for current character)
      if (selectedChar) {
        try {
          const imgs = await listCloudinaryImages(`my-girls/${selectedChar.id}/${id}`).catch(() => []);
          for (const img of imgs) { deleteFromCloudinary(img.public_id).catch(() => {}); }
        } catch {}
      }
    }
    // Clear local AsyncStorage cache for deleted folder
    const cacheKey = type === 'style' && selectedChar
      ? `cloud_photos_${selectedChar.id}_${id}`
      : null;
    if (cacheKey) AsyncStorage.removeItem(cacheKey).catch(() => {});
  };

  // Breadcrumb
  const renderBreadcrumb = () => (
    <View style={s.breadcrumb}>
      <Text style={s.breadcrumbTxt}>
        <Text style={s.breadcrumbHome}>🏠 Home</Text>
        <Text style={s.breadcrumbSep}> › </Text>
        <Text style={s.breadcrumbCur}>My AI Girls</Text>
        {selectedChar && (
          <>
            <Text style={s.breadcrumbSep}> › </Text>
            <Text style={s.breadcrumbCur}>{selectedChar.name}</Text>
          </>
        )}
        {selectedStyle && (
          <>
            <Text style={s.breadcrumbSep}> › </Text>
            <Text style={s.breadcrumbCur}>{selectedStyle.label}</Text>
          </>
        )}
      </Text>
    </View>
  );

  // Top action buttons (Upload + New Folder)
  const renderActionBar = () => (
    <View style={s.actionBar}>
      {depth === 2 ? (
        <TouchableOpacity style={s.uploadBtn} onPress={handleUpload} disabled={uploading}>
          {uploading
            ? <ActivityIndicator color="#fff" size="small" />
            : <Text style={s.uploadBtnTxt}>⬆ Upload</Text>
          }
        </TouchableOpacity>
      ) : (
        <View style={[s.uploadBtn, { backgroundColor: '#ccc' }]}>
          <Text style={[s.uploadBtnTxt, { color: '#888' }]}>⬆ Upload</Text>
        </View>
      )}
      {depth !== 2 ? (
        <TouchableOpacity style={s.newFolderBtn} onPress={handleNewFolder}>
          <Text style={s.newFolderTxt}>📁 New Folder</Text>
        </TouchableOpacity>
      ) : (
        <View style={[s.newFolderBtn, { backgroundColor: '#555' }]}>
          <Text style={[s.newFolderTxt, { color: '#999' }]}>📁 New Folder</Text>
        </View>
      )}
    </View>
  );

  // DEPTH 0: Character list
  const renderCharList = () => (
    <>
      {renderBreadcrumb()}
      {renderActionBar()}
      <Text style={s.sectionLabel}>FOLDERS</Text>
      <FlatList
        data={personas}
        keyExtractor={p => p.id}
        renderItem={({ item }) => (
          <TouchableOpacity style={s.row} onPress={() => selectChar(item)} activeOpacity={0.7}>
            <View style={[s.rowIcon, { backgroundColor: item.color }]}>
              <Text style={s.rowIconTxt}>{item.letter}</Text>
            </View>
            <Text style={s.rowName}>{item.name}</Text>
            <Text style={s.rowArrow}>›</Text>
            <TouchableOpacity style={s.trashBtn} onPress={() => handleDeleteFolder(item.id, item.name, 'char')}>
              <Text style={s.trashIcon}>🗑</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        )}
        ItemSeparatorComponent={() => <View style={s.sep} />}
        contentContainerStyle={{ paddingBottom: 30 }}
      />
    </>
  );

  // DEPTH 1: Photo style list
  const renderStyleList = () => (
    <>
      {renderBreadcrumb()}
      {renderActionBar()}
      <Text style={s.sectionLabel}>FOLDERS</Text>
      <FlatList
        data={photoStyles}
        keyExtractor={p => p.id}
        renderItem={({ item }) => (
          <TouchableOpacity style={s.row} onPress={() => selectStyle(item)} activeOpacity={0.7}>
            <Text style={s.styleIcon}>📷✨</Text>
            <Text style={s.styleRowName}>{item.label}</Text>
            {selectedChar && (
              <TouchableOpacity
                style={s.quickUploadBtn}
                onPress={() => selectedChar && handleQuickUpload(selectedChar, item)}
              >
                <Text style={s.quickUploadTxt}>⬆️</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={s.trashBtn} onPress={() => handleDeleteFolder(item.id, item.label, 'style')}>
              <Text style={s.trashIcon}>🗑</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        )}
        ItemSeparatorComponent={() => <View style={s.sep} />}
        contentContainerStyle={{ paddingBottom: 30 }}
      />
    </>
  );

  // DEPTH 2: Photos grid (phone-gallery style)
  const renderPhotos = () => {
    const today = new Date();
    const dateStr = today.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
    const timeStr = today.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

    return (
      <>
        {renderBreadcrumb()}
        {renderActionBar()}
        {loadingPhotos ? (
          <View style={s.centerWrap}>
            <ActivityIndicator size="large" color="#E67E22" />
            <Text style={s.loadingTxt}>Cloud-ல் இருந்து photos load பண்றேன்...</Text>
          </View>
        ) : photos.length === 0 ? (
          <View style={s.centerWrap}>
            <Text style={s.emptyIcon}>☁️</Text>
            <Text style={s.emptyTxt}>இந்த folder-ல் photos இல்லை{'\n'}⬆ Upload பண்ணுங்க</Text>
          </View>
        ) : (
          <>
            {photoSelMode && photoSelIds.size > 0 && (
              <View style={s.photoSelBar}>
                <TouchableOpacity onPress={exitPhotoSel}>
                  <Text style={s.photoSelCancel}>✕</Text>
                </TouchableOpacity>
                <Text style={s.photoSelCount}>{photoSelIds.size} selected</Text>
                <TouchableOpacity style={s.photoSelDeleteBtn} onPress={deleteSelectedPhotos}>
                  <Text style={s.photoSelDeleteTxt}>🗑️ Delete</Text>
                </TouchableOpacity>
              </View>
            )}
            <ScrollView style={{ flex: 1, backgroundColor: '#111' }}>
              {/* Date header — phone gallery style */}
              <View style={s.dateHeader}>
                <Text style={s.dateHeaderTxt}>{dateStr}</Text>
                <Text style={s.dateHeaderSub}>{timeStr} · {photos.length} photos</Text>
              </View>
              <View style={s.photoGrid}>
                {photos.map(photo => {
                  const isSel = photoSelIds.has(photo.public_id);
                  return (
                    <View key={photo.public_id} style={s.photoWrap}>
                      <TouchableOpacity
                        onPress={() => photoSelMode ? togglePhotoSel(photo.public_id) : setFullView(photo)}
                        onLongPress={() => { setPhotoSelMode(true); setPhotoSelIds(new Set([photo.public_id])); }}
                        activeOpacity={0.85}
                      >
                        <Image
                          source={{ uri: photo.url }}
                          style={[s.photoThumb, isSel && { opacity: 0.6 }]}
                          resizeMode="cover"
                        />
                        {isSel && (
                          <View style={s.photoSelOverlay}>
                            <Text style={s.photoSelCheck}>✓</Text>
                          </View>
                        )}
                      </TouchableOpacity>
                      {!photoSelMode && (
                        <TouchableOpacity style={s.photoDelete} onPress={() => handleDeletePhoto(photo)}>
                          <Text style={s.photoDeleteTxt}>🗑</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  );
                })}
              </View>
            </ScrollView>
          </>
        )}
      </>
    );
  };

  const headerTitle =
    depth === 0 ? 'My AI Girls' :
    depth === 1 ? selectedChar?.name ?? 'My AI Girls' :
    selectedStyle?.label ?? 'Photos';

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity onPress={goBack} style={s.backBtn}>
          <Text style={s.backTxt}>‹</Text>
        </TouchableOpacity>
        <Text style={s.headerTitle} numberOfLines={1}>{headerTitle}</Text>
        <TouchableOpacity style={s.refreshBtn} onPress={() => {
          if (depth === 2 && selectedChar && selectedStyle) {
            loadPhotos(selectedChar.id, selectedStyle.id);
          }
        }}>
          <Text style={s.refreshTxt}>↻</Text>
        </TouchableOpacity>
      </View>

      {/* Content */}
      <View style={s.content}>
        {depth === 0 && renderCharList()}
        {depth === 1 && renderStyleList()}
        {depth === 2 && renderPhotos()}
      </View>

      {/* Full view modal */}
      {fullView && (
        <View style={s.fullViewBg}>
          <TouchableOpacity style={s.fullViewClose} onPress={() => setFullView(null)}>
            <Text style={s.fullViewCloseTxt}>✕</Text>
          </TouchableOpacity>
          <Image source={{ uri: fullView.url }} style={s.fullViewImg} resizeMode="contain" />
          <View style={s.fullViewActions}>
            <TouchableOpacity style={s.fullViewSave} onPress={() => handleSaveToGallery(fullView)} disabled={savingPhoto}>
              <Text style={s.fullViewSaveTxt}>{savingPhoto ? '⏳ Saving...' : '⬇️ Gallery Save'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.fullViewDelete} onPress={() => { setFullView(null); handleDeletePhoto(fullView); }}>
              <Text style={s.fullViewDeleteTxt}>🗑 Delete</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Custom delete confirm (Alert.alert blocked in Chrome web) */}
      {deleteTarget && (
        <View style={s.confirmOverlay}>
          <View style={s.confirmBox}>
            <Text style={s.confirmIcon}>🗑️</Text>
            <Text style={s.confirmTitle}>Delete பண்ணட்டுமா?</Text>
            <Text style={s.confirmSub}>இந்த photo Cloud-ல் இருந்து நிரந்தரமா delete ஆகும்.</Text>
            <View style={s.confirmBtns}>
              <TouchableOpacity style={s.confirmCancel} onPress={() => setDeleteTarget(null)}>
                <Text style={s.confirmCancelTxt}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.confirmDelete} onPress={() => doDeletePhoto(deleteTarget)}>
                <Text style={s.confirmDeleteTxt}>Delete</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}


      {/* Upload progress overlay */}
      {uploading && uploadTotal > 0 && (
        <View style={s.confirmOverlay}>
          <View style={s.progressBox}>
            <ActivityIndicator size="large" color="#E67E22" />
            <Text style={s.progressTitle}>Upload பண்றேன்...</Text>
            <Text style={s.progressCount}>{uploadProgress} / {uploadTotal} photos</Text>
            <View style={s.progressBarBg}>
              <View style={[s.progressBarFill, { width: `${uploadTotal > 0 ? (uploadProgress / uploadTotal) * 100 : 0}%` as any }]} />
            </View>
          </View>
        </View>
      )}

      {/* Folder delete confirm modal */}
      {deleteFolderTarget && (
        <View style={s.confirmOverlay}>
          <View style={s.confirmBox}>
            <Text style={s.confirmIcon}>🗑️</Text>
            <Text style={s.confirmTitle}>Folder Delete பண்ணட்டுமா?</Text>
            <Text style={s.confirmSub}>"{deleteFolderTarget.name}" folder remove ஆகும்.</Text>
            <View style={s.confirmBtns}>
              <TouchableOpacity style={s.confirmCancel} onPress={() => setDeleteFolderTarget(null)}>
                <Text style={s.confirmCancelTxt}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.confirmDelete} onPress={doDeleteFolder}>
                <Text style={s.confirmDeleteTxt}>Delete</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}

      {/* New Folder dialog */}
      <Modal visible={folderDialog} transparent animationType="fade" onRequestClose={() => setFolderDialog(false)}>
        <View style={s.dialogOverlay}>
          <View style={s.dialogBox}>
            <Text style={s.dialogTitle}>📁 புதிய Folder</Text>
            <Text style={s.dialogSub}>
              {depth === 0 ? 'புதிய character folder பெயர்:' : 'புதிய style folder பெயர்:'}
            </Text>
            <TextInput
              style={s.dialogInput}
              placeholder="Folder பெயர் உள்ளிடுங்க"
              placeholderTextColor="#aaa"
              value={folderName}
              onChangeText={setFolderName}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={confirmNewFolder}
            />
            <View style={s.dialogBtns}>
              <TouchableOpacity style={s.dialogCancel} onPress={() => setFolderDialog(false)}>
                <Text style={s.dialogCancelTxt}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.dialogOk} onPress={confirmNewFolder}>
                <Text style={s.dialogOkTxt}>✅ உருவாக்கு</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#fff' },

  // Header
  header: {
    backgroundColor: '#1565C0',
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 8, paddingVertical: 14,
  },
  backBtn: { padding: 8 },
  backTxt: { color: '#fff', fontSize: 28, fontWeight: 'bold', lineHeight: 30 },
  headerTitle: { flex: 1, color: '#fff', fontSize: 18, fontWeight: 'bold', marginLeft: 4 },
  refreshBtn: { padding: 8 },
  refreshTxt: { color: '#fff', fontSize: 22, fontWeight: 'bold' },

  // Breadcrumb
  breadcrumb: {
    backgroundColor: '#1a2340', paddingHorizontal: 14, paddingVertical: 10,
  },
  breadcrumbTxt: { fontSize: 13 },
  breadcrumbHome: { color: '#E67E22', fontWeight: '600' },
  breadcrumbSep: { color: '#aaa' },
  breadcrumbCur: { color: '#E67E22', fontWeight: '600' },

  // Action bar
  actionBar: {
    flexDirection: 'row', gap: 12,
    padding: 14, backgroundColor: '#fff',
    borderBottomWidth: 1, borderBottomColor: '#eee',
  },
  uploadBtn: {
    flex: 1, backgroundColor: '#E67E22', borderRadius: 8,
    paddingVertical: 12, alignItems: 'center', justifyContent: 'center',
  },
  uploadBtnTxt: { color: '#fff', fontWeight: '800', fontSize: 15 },
  newFolderBtn: {
    flex: 1, backgroundColor: '#1a2340', borderRadius: 8,
    paddingVertical: 12, alignItems: 'center',
  },
  newFolderTxt: { color: '#FFD700', fontWeight: '700', fontSize: 15 },

  // Section label
  sectionLabel: {
    fontSize: 12, fontWeight: '800', color: '#777',
    letterSpacing: 1.5, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 8,
  },

  // Row (character or style)
  content: { flex: 1 },
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 14, backgroundColor: '#fff',
  },
  rowIcon: {
    width: 38, height: 38, borderRadius: 19,
    justifyContent: 'center', alignItems: 'center', marginRight: 14,
  },
  rowIconTxt: { color: '#fff', fontWeight: 'bold', fontSize: 15 },
  rowName: { flex: 1, fontSize: 15.5, color: '#E67E22', fontWeight: '600' },
  rowArrow: { color: '#aaa', fontSize: 20, marginRight: 10 },
  trashBtn: { padding: 6 },
  trashIcon: { fontSize: 18 },
  quickUploadBtn: { padding: 6, marginRight: 4 },
  quickUploadTxt: { fontSize: 18 },

  // Style row
  styleIcon: { fontSize: 20, marginRight: 14 },
  styleRowName: { flex: 1, fontSize: 15.5, color: '#E91E63', fontWeight: '600' },

  sep: { height: 1, backgroundColor: '#f0f0f0', marginLeft: 68 },

  // Photo grid
  centerWrap: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 14 },
  loadingTxt: { color: '#888', fontSize: 14, textAlign: 'center', marginTop: 10 },
  emptyIcon: { fontSize: 60 },
  emptyTxt: { color: '#888', fontSize: 15, textAlign: 'center', lineHeight: 26 },
  dateHeader: {
    paddingHorizontal: 14, paddingTop: 14, paddingBottom: 8,
    backgroundColor: '#111',
  },
  dateHeaderTxt: { color: '#fff', fontSize: 15, fontWeight: '700' },
  dateHeaderSub: { color: '#aaa', fontSize: 12, marginTop: 2 },
  photoGrid: {
    flexDirection: 'row', flexWrap: 'wrap',
    padding: 2, gap: 2, backgroundColor: '#111',
  },
  photoSelBar: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#1a1a1a',
    paddingHorizontal: 14, paddingVertical: 10, gap: 10,
  },
  photoSelCancel: { color: '#aaa', fontSize: 18, fontWeight: 'bold' },
  photoSelCount: { flex: 1, color: '#fff', fontWeight: '700', fontSize: 14 },
  photoSelDeleteBtn: { backgroundColor: '#c62828', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 7 },
  photoSelDeleteTxt: { color: '#fff', fontWeight: 'bold', fontSize: 13 },
  photoWrap: { position: 'relative' },
  photoThumb: { width: PHOTO_SIZE, height: PHOTO_SIZE, borderRadius: 4 },
  photoSelOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(21,101,192,0.35)', borderRadius: 4,
    justifyContent: 'center', alignItems: 'center',
  },
  photoSelCheck: { color: '#fff', fontSize: 26, fontWeight: 'bold' },
  photoDelete: {
    position: 'absolute', bottom: 4, right: 4,
    backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 12,
    paddingHorizontal: 6, paddingVertical: 2,
  },
  photoDeleteTxt: { fontSize: 13 },

  // Full view
  fullViewBg: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000', zIndex: 100,
    justifyContent: 'center', alignItems: 'center',
  },
  fullViewClose: { position: 'absolute', top: 50, right: 20, zIndex: 10, padding: 10 },
  fullViewCloseTxt: { color: '#fff', fontSize: 24, fontWeight: 'bold' },
  fullViewImg: { width, height: width * 1.3 },
  fullViewActions: {
    position: 'absolute', bottom: 50,
    flexDirection: 'row', gap: 12,
    paddingHorizontal: 20,
  },
  fullViewSave: {
    flex: 1, backgroundColor: '#1B5E20', borderRadius: 12,
    paddingVertical: 14, alignItems: 'center',
  },
  fullViewSaveTxt: { color: '#fff', fontWeight: '700', fontSize: 15 },
  fullViewDelete: {
    flex: 1, backgroundColor: '#C62828', borderRadius: 12,
    paddingVertical: 14, alignItems: 'center',
  },
  fullViewDeleteTxt: { color: '#fff', fontWeight: '700', fontSize: 15 },

  // New Folder dialog
  confirmOverlay: {
    ...StyleSheet.absoluteFillObject, zIndex: 200,
    backgroundColor: 'rgba(0,0,0,0.75)', justifyContent: 'center', alignItems: 'center', padding: 30,
  },
  confirmBox: { backgroundColor: '#1a2340', borderRadius: 18, padding: 24, width: '100%', alignItems: 'center' },
  confirmIcon: { fontSize: 40, marginBottom: 10 },
  confirmTitle: { color: '#fff', fontSize: 18, fontWeight: 'bold', marginBottom: 6 },
  confirmSub: { color: '#aaa', fontSize: 13, textAlign: 'center', marginBottom: 20 },
  confirmBtns: { flexDirection: 'row', gap: 12, width: '100%' },
  confirmCancel: { flex: 1, backgroundColor: '#444', borderRadius: 10, paddingVertical: 13, alignItems: 'center' },
  confirmCancelTxt: { color: '#ccc', fontWeight: '700', fontSize: 15 },
  confirmDelete: { flex: 1, backgroundColor: '#c62828', borderRadius: 10, paddingVertical: 13, alignItems: 'center' },
  confirmDeleteTxt: { color: '#fff', fontWeight: '800', fontSize: 15 },
  dialogOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center', alignItems: 'center', padding: 30,
  },
  dialogBox: {
    backgroundColor: '#1a2340', borderRadius: 16,
    padding: 24, width: '100%',
  },
  dialogTitle: { color: '#FFD700', fontSize: 20, fontWeight: '800', marginBottom: 8 },
  dialogSub: { color: '#aaa', fontSize: 13, marginBottom: 16 },
  dialogInput: {
    backgroundColor: '#fff', borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 12,
    fontSize: 16, color: '#111', marginBottom: 20,
  },
  dialogBtns: { flexDirection: 'row', gap: 12 },
  dialogCancel: {
    flex: 1, backgroundColor: '#444', borderRadius: 10,
    paddingVertical: 13, alignItems: 'center',
  },
  dialogCancelTxt: { color: '#fff', fontWeight: '700', fontSize: 15 },
  dialogOk: {
    flex: 2, backgroundColor: '#E67E22', borderRadius: 10,
    paddingVertical: 13, alignItems: 'center',
  },
  dialogOkTxt: { color: '#fff', fontWeight: '800', fontSize: 15 },

  // Upload progress
  progressBox: {
    backgroundColor: '#1a2340', borderRadius: 18, padding: 30,
    width: '100%', alignItems: 'center', gap: 12,
  },
  progressTitle: { color: '#fff', fontSize: 18, fontWeight: '700' },
  progressCount: { color: '#E67E22', fontSize: 22, fontWeight: '800' },
  progressBarBg: {
    width: '100%', height: 10, backgroundColor: '#333',
    borderRadius: 5, overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%', backgroundColor: '#E67E22', borderRadius: 5,
  },

  // ── Folder Browser styles ─────────────────────────────────────────────────
  fbSafe: { flex: 1, backgroundColor: '#0d1117' },
  fbHeader: {
    backgroundColor: '#1565C0', flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, paddingVertical: 14, gap: 10,
  },
  fbBackBtn: { paddingHorizontal: 6, paddingVertical: 4 },
  fbBackTxt: { color: '#fff', fontSize: 15, fontWeight: '700' },
  fbHeaderCenter: { flex: 1 },
  fbHeaderTitle: { color: '#fff', fontSize: 17, fontWeight: '800' },
  fbHeaderSub: { color: 'rgba(255,255,255,0.7)', fontSize: 11, marginTop: 1 },
  fbSelCount: {
    backgroundColor: '#E67E22', color: '#fff', fontWeight: '800',
    fontSize: 13, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12,
  },

  // Albums list
  fbCenter: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 14 },
  fbLoadTxt: { color: '#aaa', fontSize: 14 },
  fbAlbumRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 14, paddingVertical: 10, backgroundColor: '#111827',
  },
  fbAlbumThumbWrap: { marginRight: 14, position: 'relative' },
  fbAlbumThumb: { width: 60, height: 60, borderRadius: 8 },
  fbFolderIconBadge: { position: 'absolute', bottom: 0, right: 0, backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 4, padding: 1 },
  fbAlbumInfo: { flex: 1 },
  fbAlbumName: { color: '#e5e7eb', fontSize: 15, fontWeight: '600' },
  fbAlbumCount: { color: '#6b7280', fontSize: 12, marginTop: 2 },
  fbAlbumArrow: { color: '#6b7280', fontSize: 22 },
  fbSep: { height: 1, backgroundColor: '#1f2937', marginLeft: 88 },

  // Photos grid
  fbAssetWrap: {
    width: width / 3 - 2, height: width / 3 - 2, margin: 1, position: 'relative',
  },
  fbAssetThumb: { width: '100%', height: '100%' },
  fbAssetOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(21,101,192,0.45)',
    justifyContent: 'flex-start', alignItems: 'flex-end',
    padding: 5,
  },
  fbAssetCheck: {
    width: 24, height: 24, borderRadius: 12,
    backgroundColor: '#1565C0', borderWidth: 2, borderColor: '#fff',
    justifyContent: 'center', alignItems: 'center',
  },
  fbAssetCheckTxt: { color: '#fff', fontSize: 13, fontWeight: 'bold' },
  fbAssetCheckEmpty: {
    position: 'absolute', top: 5, right: 5,
    width: 22, height: 22, borderRadius: 11,
    borderWidth: 2, borderColor: 'rgba(255,255,255,0.6)',
  },

  // Bottom Cut/Copy bar
  fbBottomBar: {
    position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 99,
    backgroundColor: '#0f172a', borderTopWidth: 2, borderTopColor: '#E67E22',
    paddingHorizontal: 14, paddingVertical: 12, gap: 8,
  },
  fbBottomCount: {
    color: '#e5e7eb', fontSize: 13, fontWeight: '700', textAlign: 'center', marginBottom: 4,
  },
  // CUT — big orange primary button
  fbCutBtnBig: {
    backgroundColor: '#E67E22', borderRadius: 14,
    paddingVertical: 16, alignItems: 'center',
  },
  fbCutBtnBigTxt: { color: '#fff', fontSize: 15, fontWeight: '800' },
  // COPY — smaller secondary button
  fbCopyBtnSmall: {
    backgroundColor: '#1f2937', borderRadius: 14, borderWidth: 1, borderColor: '#374151',
    paddingVertical: 10, alignItems: 'center',
  },
  fbCopyBtnSmallTxt: { color: '#9ca3af', fontSize: 13, fontWeight: '600' },
});
