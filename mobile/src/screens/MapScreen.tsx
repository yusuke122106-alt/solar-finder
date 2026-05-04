import React, { useRef, useState, useCallback, useMemo } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, PanResponder,
  Dimensions, Alert,
} from 'react-native';
import Slider from '@react-native-community/slider';
import MapView, { Marker, PROVIDER_GOOGLE, Region } from 'react-native-maps';
import { COLORS } from '../utils/constants';
import { BoundingBox, SolarPin, ScanProgress } from '../utils/types';
import { fetchSolarPins } from '../services/backendApi';

// ── Layout constants ──────────────────────────────────────
const { width: W, height: H } = Dimensions.get('window');
const BOTTOM_H   = 180;   // bottom control panel height (px)
const RECT_RATIO = 0.72;  // rect height ÷ width  (landscape ratio)
const CORNER     = 22;    // corner bracket length (px)
const DIM        = 'rgba(5,10,20,0.52)'; // dimmed overlay colour

// ── Props ─────────────────────────────────────────────────
interface Props {
  pins: SolarPin[];
  onPinsAdded: (pins: SolarPin[]) => void;
  onClear: () => void;
}

export default function MapScreen({ pins, onPinsAdded, onClear }: Props) {
  const mapRef = useRef<MapView>(null);

  // Map state
  const [region, setRegion] = useState<Region>({
    latitude: 35.6762, longitude: 139.6503,
    latitudeDelta: 0.02, longitudeDelta: 0.02,
  });

  // Actual measured height of the map area (updated by onLayout)
  const [mapAreaH, setMapAreaH] = useState(H - BOTTOM_H);

  // Selection rectangle size (0.15 … 0.85 as fraction of screen width)
  const [rectFraction, setRectFraction] = useState(0.55);

  // Scan state
  const [scanning, setScanning]       = useState(false);
  const [progress, setProgress]       = useState<ScanProgress | null>(null);
  const [selectedPin, setSelectedPin] = useState<SolarPin | null>(null);
  const cancelRef  = useRef(false);
  const abortRef   = useRef<AbortController | null>(null);

  // ── Derived rect geometry ─────────────────────────────
  const rectW    = W * rectFraction;
  const rectH    = rectW * RECT_RATIO;
  const rectLeft = (W - rectW) / 2;
  const rectTop  = (mapAreaH - rectH) / 2;

  // Approximate scan-area size in metres
  const { latM, lngM } = useMemo(() => {
    const lngSpan = rectFraction * region.longitudeDelta;
    const latSpan = (rectH / mapAreaH) * region.latitudeDelta;
    return {
      lngM: Math.round(lngSpan * 111000 * Math.cos(region.latitude * Math.PI / 180)),
      latM: Math.round(latSpan * 111000),
    };
  }, [rectFraction, region, rectH, mapAreaH]);

  // Bounds of the selection rectangle
  const getSelectionBounds = useCallback((): BoundingBox => {
    const lngSpan = rectFraction * region.longitudeDelta;
    const latSpan = (rectH / mapAreaH) * region.latitudeDelta;
    return {
      north: region.latitude  + latSpan / 2,
      south: region.latitude  - latSpan / 2,
      east:  region.longitude + lngSpan / 2,
      west:  region.longitude - lngSpan / 2,
    };
  }, [rectFraction, region, rectH, mapAreaH]);

  // ── Pinch-to-resize ───────────────────────────────────
  // A PanResponder that ONLY claims 2-finger touches.
  // Single-finger touches are NOT intercepted → MapView handles pan.
  const pinchStart = useRef<{ dist: number; frac: number } | null>(null);

  const pinchResponder = useMemo(() => PanResponder.create({
    // Claim only when two fingers are on screen
    onStartShouldSetPanResponder : (e) => e.nativeEvent.touches.length === 2,
    onMoveShouldSetPanResponder  : (e) => e.nativeEvent.touches.length === 2,

    onPanResponderGrant: (e) => {
      const t = e.nativeEvent.touches;
      if (t.length < 2) return;
      pinchStart.current = {
        dist: Math.hypot(t[1].pageX - t[0].pageX, t[1].pageY - t[0].pageY),
        frac: rectFraction,
      };
    },
    onPanResponderMove: (e) => {
      const t = e.nativeEvent.touches;
      if (t.length < 2 || !pinchStart.current) return;
      const dist  = Math.hypot(t[1].pageX - t[0].pageX, t[1].pageY - t[0].pageY);
      const scale = dist / pinchStart.current.dist;
      setRectFraction(clamp(pinchStart.current.frac * scale, 0.15, 0.85));
    },
    onPanResponderRelease: () => { pinchStart.current = null; },
    onPanResponderTerminate: () => { pinchStart.current = null; },
  }), [rectFraction]);

  // ── Scan ──────────────────────────────────────────────
  const startScan = useCallback(async () => {
    const bounds = getSelectionBounds();
    cancelRef.current = false;
    abortRef.current  = new AbortController();
    setScanning(true);
    setProgress({
      phase: 'buildings', current: 0, total: 1,
      message: '🌐 サーバーへ送信中...',
    });

    try {
      // POST bounds → Vercel API → get numbered pins
      const newPins = await fetchSolarPins(bounds, pins.length);

      if (cancelRef.current) return; // user cancelled while waiting

      onPinsAdded(newPins);
      setProgress({
        phase: 'done',
        current: newPins.length,
        total:   newPins.length,
        message: `完了！ ソーラーあり: ${newPins.length}件`,
      });
      setTimeout(() => setProgress(null), 3000);
    } catch (err: any) {
      if (!cancelRef.current) {
        Alert.alert(
          'スキャンエラー',
          err?.message ?? 'サーバーに接続できませんでした。\nネットワークを確認して再試行してください。',
          [{ text: 'OK' }],
        );
      }
      setProgress(null);
    } finally {
      setScanning(false);
      abortRef.current = null;
    }
  }, [getSelectionBounds, onPinsAdded, pins.length]);

  const cancelScan = () => {
    cancelRef.current = true;
    abortRef.current?.abort();
    setScanning(false);
    setProgress(null);
  };

  const confirmClear = () => Alert.alert('クリア', '全ピンを削除しますか？', [
    { text: 'キャンセル', style: 'cancel' },
    { text: '削除', style: 'destructive', onPress: () => { onClear(); setSelectedPin(null); } },
  ]);

  // ── Render ────────────────────────────────────────────
  return (
    <View style={styles.root}>

      {/* ── Map area (flex:1) ─────────────────────────── */}
      <View
        style={styles.mapContainer}
        onLayout={e => setMapAreaH(e.nativeEvent.layout.height)}
      >
        <MapView
          ref={mapRef}
          style={StyleSheet.absoluteFill}
          provider={PROVIDER_GOOGLE}
          mapType="hybrid"
          initialRegion={region}
          onRegionChangeComplete={setRegion}
          rotateEnabled={false}
          pitchEnabled={false}
          showsUserLocation
        >
          {pins.map(pin => (
            <Marker key={pin.uid} coordinate={pin.coordinate} onPress={() => setSelectedPin(pin)}>
              <View style={styles.pinWrapper}>
                <View style={styles.pinDot} />
                <View style={styles.pinTag}>
                  <Text style={styles.pinTagText}>{pin.label}</Text>
                </View>
              </View>
            </Marker>
          ))}
        </MapView>

        {/* Pinch capture layer — transparent, only claims 2-finger gesture */}
        <View
          style={StyleSheet.absoluteFill}
          {...pinchResponder.panHandlers}
        />

        {/* Dim overlay: 4 panels around the selection rect (non-interactive) */}
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          {/* top */}
          <View style={[styles.dim, { top: 0, left: 0, right: 0, height: rectTop }]} />
          {/* bottom */}
          <View style={[styles.dim, { left: 0, right: 0, top: rectTop + rectH, bottom: 0 }]} />
          {/* left */}
          <View style={[styles.dim, { top: rectTop, left: 0, width: rectLeft, height: rectH }]} />
          {/* right */}
          <View style={[styles.dim, { top: rectTop, left: rectLeft + rectW, right: 0, height: rectH }]} />

          {/* ── Corner brackets ─────────────────────── */}
          {/* top-left */}
          <View style={[styles.corner, styles.cornerH, { top: rectTop, left: rectLeft }]} />
          <View style={[styles.corner, styles.cornerV, { top: rectTop, left: rectLeft }]} />
          {/* top-right */}
          <View style={[styles.corner, styles.cornerH, { top: rectTop, right: W - rectLeft - rectW }]} />
          <View style={[styles.corner, styles.cornerV, { top: rectTop, right: W - rectLeft - rectW }]} />
          {/* bottom-left */}
          <View style={[styles.corner, styles.cornerH, { top: rectTop + rectH - 2, left: rectLeft }]} />
          <View style={[styles.corner, styles.cornerV, { top: rectTop + rectH - CORNER, left: rectLeft }]} />
          {/* bottom-right */}
          <View style={[styles.corner, styles.cornerH, { top: rectTop + rectH - 2, right: W - rectLeft - rectW }]} />
          <View style={[styles.corner, styles.cornerV, { top: rectTop + rectH - CORNER, right: W - rectLeft - rectW }]} />

          {/* ── Crosshair at exact centre ────────────── */}
          <View style={[styles.crossH, { top: rectTop + rectH / 2 - 1, left: rectLeft + rectW / 2 - 20 }]} />
          <View style={[styles.crossV, { top: rectTop + rectH / 2 - 20, left: rectLeft + rectW / 2 - 1 }]} />
          <View style={[styles.crossDot, { top: rectTop + rectH / 2 - 4, left: rectLeft + rectW / 2 - 4 }]} />

          {/* Size label inside rect (top-centre) */}
          <View style={[styles.sizeLabel, { top: rectTop + 8, left: rectLeft, width: rectW }]}>
            <Text style={styles.sizeLabelText}>
              {lngM >= 1000 ? `${(lngM/1000).toFixed(1)}km` : `${lngM}m`} ×{' '}
              {latM >= 1000 ? `${(latM/1000).toFixed(1)}km` : `${latM}m`}
            </Text>
          </View>
        </View>

        {/* ── Toolbar (absolute, top of map area) ───── */}
        <View style={styles.toolbar} pointerEvents="box-none">
          <Text style={styles.toolbarTitle}>☀️ Solar Finder</Text>
          <View style={styles.toolbarSpacer} />
          <View style={styles.countBadge}>
            <Text style={styles.countText}>🟢 <Text style={styles.countNum}>{pins.length}</Text>件</Text>
          </View>
          <TouchableOpacity style={styles.btn} onPress={confirmClear} disabled={scanning}>
            <Text style={styles.btnText}>🗑️</Text>
          </TouchableOpacity>
        </View>

        {/* ── Progress panel ────────────────────────── */}
        {progress && (
          <View style={styles.progressPanel} pointerEvents="box-none">
            {progress.phase !== 'done' ? (
              <>
                <Text style={styles.progressTitle}>🛰️ AI スキャン中...</Text>
                <Text style={styles.progressSub}>{progress.message}</Text>
                {/* Indeterminate bar while waiting for server response */}
                <View style={styles.barWrap}>
                  <View style={[styles.bar, styles.barIndeterminate]} />
                </View>
                <TouchableOpacity style={[styles.btn, { marginTop: 10, alignSelf: 'center' }]} onPress={cancelScan}>
                  <Text style={styles.btnText}>キャンセル</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                <Text style={styles.progressTitle}>✅ 完了！</Text>
                <Text style={styles.progressSub}>{progress.message}</Text>
                <View style={styles.barWrap}>
                  <View style={[styles.bar, { width: '100%' as any }]} />
                </View>
              </>
            )}
          </View>
        )}

        {/* ── Pin detail card ───────────────────────── */}
        {selectedPin && !progress && (
          <View style={styles.pinCard}>
            <TouchableOpacity style={styles.pinCardClose} onPress={() => setSelectedPin(null)}>
              <Text style={styles.pinCardCloseText}>✕</Text>
            </TouchableOpacity>
            <Text style={styles.pinCardLabel}>{selectedPin.label}</Text>
            <Text style={styles.pinCardAddress} numberOfLines={3}>{selectedPin.address}</Text>
            <View style={styles.confRow}>
              <Text style={styles.confLabel}>AI確信度</Text>
              <View style={styles.confBarWrap}>
                <View style={[styles.confBar, { width: `${selectedPin.confidence}%` as any }]} />
              </View>
              <Text style={styles.confPct}>{selectedPin.confidence}%</Text>
            </View>
            {!!selectedPin.matchedLabel && (
              <Text style={styles.matchedLabel}>検出: {selectedPin.matchedLabel}</Text>
            )}
          </View>
        )}
      </View>

      {/* ── Bottom control panel ──────────────────────── */}
      <View style={styles.bottomPanel}>

        {/* Instruction hint */}
        <Text style={styles.hintText}>
          地図を動かして中央のターゲットに合わせてください
        </Text>

        {/* Size slider row */}
        <View style={styles.sliderRow}>
          <Text style={styles.sliderIcon}>🔍</Text>
          <Slider
            style={styles.slider}
            minimumValue={0.15}
            maximumValue={0.85}
            value={rectFraction}
            onValueChange={setRectFraction}
            minimumTrackTintColor={COLORS.accent}
            maximumTrackTintColor={COLORS.border}
            thumbTintColor={COLORS.accent}
          />
          <Text style={styles.sliderIcon}>🗺️</Text>
        </View>

        {/* Preset size buttons */}
        <View style={styles.presetRow}>
          {([['S', 0.25], ['M', 0.50], ['L', 0.75]] as [string, number][]).map(([label, val]) => (
            <TouchableOpacity
              key={label}
              style={[styles.presetBtn, Math.abs(rectFraction - val) < 0.05 && styles.presetBtnActive]}
              onPress={() => setRectFraction(val)}
            >
              <Text style={[styles.presetBtnText, Math.abs(rectFraction - val) < 0.05 && styles.presetBtnTextActive]}>
                {label}
              </Text>
            </TouchableOpacity>
          ))}
          <Text style={styles.pinchHint}>　←　ピンチで拡縮</Text>
        </View>

        {/* Scan button */}
        <TouchableOpacity
          style={[styles.scanBtn, scanning && styles.scanBtnDisabled]}
          onPress={startScan}
          disabled={scanning}
          activeOpacity={0.8}
        >
          {scanning
            ? <Text style={styles.scanBtnText}>⏳ スキャン中...</Text>
            : <Text style={styles.scanBtnText}>🔍 このエリアをスキャン</Text>
          }
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ── Utils ─────────────────────────────────────────────────
function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

// ── Styles ────────────────────────────────────────────────
const styles = StyleSheet.create({
  root:         { flex: 1, backgroundColor: COLORS.bg },
  mapContainer: { flex: 1 },

  // Dimming panels
  dim: { position: 'absolute', backgroundColor: DIM },

  // Corner L-bracket pieces
  corner: { position: 'absolute', backgroundColor: COLORS.accent },
  cornerH: { height: 2, width: CORNER },
  cornerV: { width: 2,  height: CORNER },

  // Crosshair
  crossH:   { position: 'absolute', height: 2, width: 40, backgroundColor: 'rgba(245,158,11,0.9)' },
  crossV:   { position: 'absolute', width: 2,  height: 40, backgroundColor: 'rgba(245,158,11,0.9)' },
  crossDot: { position: 'absolute', width: 8, height: 8, borderRadius: 4, backgroundColor: COLORS.accent },

  // Size label inside rect
  sizeLabel:     { position: 'absolute', alignItems: 'center' },
  sizeLabelText: {
    color: 'rgba(245,158,11,0.9)', fontSize: 11, fontWeight: '700',
    backgroundColor: 'rgba(10,15,26,0.6)', paddingHorizontal: 8, paddingVertical: 2,
    borderRadius: 4,
  },

  // Toolbar
  toolbar: {
    position: 'absolute', top: 0, left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 14, paddingVertical: 10,
    backgroundColor: 'rgba(10,15,26,0.88)',
    borderBottomWidth: 1, borderBottomColor: COLORS.border,
    gap: 8,
  },
  toolbarTitle:  { color: COLORS.text, fontWeight: '700', fontSize: 14 },
  toolbarSpacer: { flex: 1 },
  countBadge:    {},
  countText:     { color: COLORS.text2, fontSize: 12 },
  countNum:      { color: COLORS.success, fontWeight: '700' },
  btn: {
    paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: 8, borderWidth: 1, borderColor: COLORS.border,
    backgroundColor: COLORS.surface2,
  },
  btnText: { color: COLORS.text, fontSize: 12, fontWeight: '600' },

  // Progress
  progressPanel: {
    position: 'absolute', bottom: 16, alignSelf: 'center',
    backgroundColor: 'rgba(10,15,26,0.96)',
    borderWidth: 1, borderColor: COLORS.border,
    borderRadius: 14, padding: 16, minWidth: 260,
  },
  progressTitle: { color: COLORS.text,  fontWeight: '700', fontSize: 13, marginBottom: 4, textAlign: 'center' },
  progressSub:   { color: COLORS.text2, fontSize: 11, marginBottom: 10, textAlign: 'center' },
  barWrap: { height: 4, backgroundColor: COLORS.border, borderRadius: 2, overflow: 'hidden' },
  bar:     { height: '100%', backgroundColor: COLORS.accent, borderRadius: 2 },
  // Indeterminate: fill 60% of bar to show "in progress" without a specific %
  barIndeterminate: { width: '60%' as any, opacity: 0.85 },

  // Pin markers
  pinWrapper: { alignItems: 'center' },
  pinDot: {
    width: 14, height: 14, borderRadius: 7,
    backgroundColor: COLORS.success, borderWidth: 2, borderColor: '#fff',
    shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 3, elevation: 4,
  },
  pinTag: {
    backgroundColor: COLORS.bg, borderRadius: 3,
    paddingHorizontal: 4, paddingVertical: 1, marginTop: 2,
    elevation: 3,
  },
  pinTagText: { color: COLORS.accent, fontSize: 9, fontWeight: '700' },

  // Pin detail card
  pinCard: {
    position: 'absolute', bottom: 12, left: 12, right: 12,
    backgroundColor: COLORS.surface,
    borderWidth: 1, borderColor: COLORS.border, borderRadius: 14, padding: 14,
  },
  pinCardClose:      { position: 'absolute', top: 10, right: 12 },
  pinCardCloseText:  { color: COLORS.text2, fontSize: 16 },
  pinCardLabel:      { color: COLORS.accent, fontSize: 20, fontWeight: '700', marginBottom: 5 },
  pinCardAddress:    { color: COLORS.text2, fontSize: 11, lineHeight: 17, marginBottom: 8 },
  confRow:           { flexDirection: 'row', alignItems: 'center', gap: 8 },
  confLabel:         { color: COLORS.text2, fontSize: 11 },
  confBarWrap:       { flex: 1, height: 4, backgroundColor: COLORS.border, borderRadius: 2, overflow: 'hidden' },
  confBar:           { height: '100%', backgroundColor: COLORS.success },
  confPct:           { color: COLORS.text2, fontSize: 11, width: 32 },
  matchedLabel:      { color: COLORS.text3, fontSize: 10, marginTop: 5 },

  // ── Bottom panel ────────────────────────────────────────
  bottomPanel: {
    height: BOTTOM_H,
    backgroundColor: COLORS.surface,
    borderTopWidth: 1, borderTopColor: COLORS.border,
    paddingHorizontal: 16, paddingTop: 10, paddingBottom: 8,
    gap: 6,
  },
  hintText:  { color: COLORS.text3, fontSize: 11, textAlign: 'center' },

  sliderRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sliderIcon:{ fontSize: 16 },
  slider:    { flex: 1, height: 32 },

  presetRow:     { flexDirection: 'row', alignItems: 'center', gap: 8 },
  presetBtn:     {
    paddingHorizontal: 16, paddingVertical: 4,
    borderRadius: 16, borderWidth: 1, borderColor: COLORS.border,
    backgroundColor: COLORS.surface2,
  },
  presetBtnActive:     { backgroundColor: COLORS.accent, borderColor: COLORS.accent },
  presetBtnText:       { color: COLORS.text2, fontSize: 12, fontWeight: '600' },
  presetBtnTextActive: { color: '#000' },
  pinchHint:           { color: COLORS.text3, fontSize: 10, flex: 1 },

  scanBtn: {
    backgroundColor: COLORS.accent2,
    borderRadius: 12, paddingVertical: 12,
    alignItems: 'center', justifyContent: 'center',
  },
  scanBtnDisabled: { opacity: 0.5 },
  scanBtnText:     { color: '#fff', fontWeight: '700', fontSize: 14 },
});
