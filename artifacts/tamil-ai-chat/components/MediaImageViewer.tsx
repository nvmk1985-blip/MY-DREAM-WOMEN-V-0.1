import React, { useRef, useCallback } from 'react';
import {
  Modal, View, TouchableOpacity, Text, StatusBar,
  StyleSheet, Dimensions, ScrollView, Image, Platform,
} from 'react-native';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system';

const { width: W, height: H } = Dimensions.get('window');

interface Props {
  uri: string | null;
  onClose: () => void;
  onPrompt?: (uri: string) => void;
}

export default function MediaImageViewer({ uri, onClose, onPrompt }: Props) {
  const scrollRef = useRef<ScrollView>(null);
  const lastTapRef = useRef(0);
  const zoomedRef = useRef(false);

  const handleDoubleTap = useCallback(() => {
    const now = Date.now();
    if (now - lastTapRef.current < 300) {
      if (zoomedRef.current) {
        scrollRef.current?.scrollTo({ x: 0, y: 0, animated: false });
        (scrollRef.current as any)?.setZoomScale?.(1, true);
        zoomedRef.current = false;
      } else {
        (scrollRef.current as any)?.setZoomScale?.(3, true);
        zoomedRef.current = true;
      }
    }
    lastTapRef.current = now;
  }, []);

  const handleSave = async () => {
    if (!uri) return;
    try {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status !== 'granted') return;
      let localUri = uri;
      if (uri.startsWith('http')) {
        const dest = FileSystem.cacheDirectory + 'save_img_' + Date.now() + '.jpg';
        const dl = await FileSystem.downloadAsync(uri, dest);
        localUri = dl.uri;
      }
      await MediaLibrary.saveToLibraryAsync(localUri);
    } catch {}
  };

  return (
    <Modal
      visible={!!uri}
      transparent={false}
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <StatusBar hidden />
      <View style={styles.container}>
        <ScrollView
          ref={scrollRef}
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          maximumZoomScale={6}
          minimumZoomScale={1}
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
          centerContent
          bouncesZoom
          scrollEventThrottle={16}
        >
          <TouchableOpacity activeOpacity={1} onPress={handleDoubleTap}>
            {uri ? (
              <Image
                source={{ uri }}
                style={styles.image}
                resizeMode="contain"
              />
            ) : null}
          </TouchableOpacity>
        </ScrollView>

        <TouchableOpacity style={styles.closeBtn} onPress={onClose}>
          <Text style={styles.closeTxt}>✕</Text>
        </TouchableOpacity>

        <View style={styles.bottomBar}>
          <TouchableOpacity style={styles.actionBtn} onPress={handleSave}>
            <Text style={styles.actionTxt}>💾 Save</Text>
          </TouchableOpacity>
          {onPrompt && uri ? (
            <TouchableOpacity style={styles.actionBtn} onPress={() => onPrompt(uri)}>
              <Text style={styles.actionTxt}>📋 Prompt</Text>
            </TouchableOpacity>
          ) : null}
        </View>

        <Text style={styles.hint}>Pinch to zoom  •  Double-tap to toggle</Text>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    minHeight: H,
    minWidth: W,
  },
  image: {
    width: W,
    height: H,
  },
  closeBtn: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 54 : 36,
    right: 18,
    zIndex: 20,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 20,
    width: 36,
    height: 36,
    justifyContent: 'center',
    alignItems: 'center',
  },
  closeTxt: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
  },
  bottomBar: {
    position: 'absolute',
    bottom: Platform.OS === 'ios' ? 40 : 24,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 16,
    zIndex: 20,
  },
  actionBtn: {
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 22,
    paddingVertical: 10,
    paddingHorizontal: 22,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
  },
  actionTxt: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  hint: {
    position: 'absolute',
    bottom: Platform.OS === 'ios' ? 86 : 70,
    alignSelf: 'center',
    color: 'rgba(255,255,255,0.35)',
    fontSize: 11,
    zIndex: 10,
  },
});
