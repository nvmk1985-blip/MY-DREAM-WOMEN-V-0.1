import React, { useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  ScrollView, Linking, StatusBar,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack } from 'expo-router';

const VIDMAGE_URL = 'https://vidmage.ai/face-swap';

export default function FaceSwapScreen() {
  const openVidmage = () => {
    Linking.openURL(VIDMAGE_URL).catch(() => {});
  };

  useEffect(() => {
    openVidmage();
  }, []);

  return (
    <SafeAreaView style={s.container} edges={['top', 'bottom']}>
      <StatusBar backgroundColor="#075E54" barStyle="light-content" />
      <Stack.Screen options={{
        title: '🤳 Face Swap',
        headerStyle: { backgroundColor: '#075E54' },
        headerTintColor: '#fff',
        headerTitleStyle: { fontWeight: 'bold' },
      }} />

      <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>

        <View style={s.logoBanner}>
          <Text style={s.logoText}>🤳</Text>
          <Text style={s.title}>AI Face Swap</Text>
          <Text style={s.sub}>Powered by vidmage.ai</Text>
        </View>

        <View style={s.card}>
          <Text style={s.cardTitle}>எப்படி use பண்றது?</Text>
          <View style={s.step}><Text style={s.stepNum}>1</Text><Text style={s.stepTxt}>உன் selfie (முக photo) upload பண்ணு</Text></View>
          <View style={s.step}><Text style={s.stepNum}>2</Text><Text style={s.stepTxt}>Character photo (target) upload பண்ணு</Text></View>
          <View style={s.step}><Text style={s.stepNum}>3</Text><Text style={s.stepTxt}>"Swap Face" button tap பண்ணு</Text></View>
          <View style={s.step}><Text style={s.stepNum}>4</Text><Text style={s.stepTxt}>Result download பண்ணு!</Text></View>
        </View>

        <View style={s.freeBox}>
          <Text style={s.freeTxt}>✅ Free • Daily 15 Photo swaps • 20s Video swaps</Text>
        </View>

        <TouchableOpacity style={s.mainBtn} onPress={openVidmage}>
          <Text style={s.mainBtnTxt}>🌐 vidmage.ai Face Swap திற</Text>
        </TouchableOpacity>

        <Text style={s.hint}>Browser-ல் திறக்கும் — Face Swap use பண்ணி result save பண்ணலாம்</Text>

        <TouchableOpacity style={s.secondBtn} onPress={openVidmage}>
          <Text style={s.secondBtnTxt}>↗ மீண்டும் திற</Text>
        </TouchableOpacity>

      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f0f7f4' },
  scroll: { padding: 20, paddingBottom: 40, alignItems: 'center' },

  logoBanner: { alignItems: 'center', marginTop: 10, marginBottom: 24 },
  logoText: { fontSize: 64, marginBottom: 8 },
  title: { fontSize: 26, fontWeight: '800', color: '#075E54', marginBottom: 4 },
  sub: { fontSize: 14, color: '#888', fontWeight: '500' },

  card: {
    backgroundColor: '#fff', borderRadius: 18, padding: 20, width: '100%',
    marginBottom: 16, elevation: 2, shadowColor: '#000',
    shadowOpacity: 0.08, shadowRadius: 8, shadowOffset: { width: 0, height: 2 },
  },
  cardTitle: { fontSize: 16, fontWeight: '700', color: '#333', marginBottom: 14 },
  step: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 10 },
  stepNum: {
    width: 28, height: 28, borderRadius: 14, backgroundColor: '#075E54',
    color: '#fff', fontWeight: '800', fontSize: 14, textAlign: 'center',
    lineHeight: 28,
  },
  stepTxt: { flex: 1, fontSize: 14, color: '#444', lineHeight: 20 },

  freeBox: {
    backgroundColor: '#e8f5e9', borderRadius: 12, padding: 12,
    marginBottom: 20, width: '100%', alignItems: 'center',
  },
  freeTxt: { fontSize: 13, fontWeight: '600', color: '#2e7d32' },

  mainBtn: {
    backgroundColor: '#075E54', borderRadius: 18, paddingVertical: 18,
    paddingHorizontal: 32, width: '100%', alignItems: 'center',
    elevation: 4, marginBottom: 10,
    shadowColor: '#075E54', shadowOpacity: 0.4, shadowRadius: 8, shadowOffset: { width: 0, height: 4 },
  },
  mainBtnTxt: { color: '#fff', fontSize: 18, fontWeight: '800' },

  hint: { fontSize: 12, color: '#888', textAlign: 'center', marginBottom: 16, lineHeight: 18 },

  secondBtn: {
    backgroundColor: '#f0f0f0', borderRadius: 12, paddingVertical: 12,
    paddingHorizontal: 24, width: '100%', alignItems: 'center',
  },
  secondBtnTxt: { color: '#075E54', fontSize: 14, fontWeight: '700' },
});
