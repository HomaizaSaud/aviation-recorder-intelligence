#!/usr/bin/env python3
"""
CVR Event Detection Module
Detects alarms, explosions, impacts, and unusual sounds in CVR audio.
"""

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional

import librosa
import numpy as np
import torch
import torchaudio


@dataclass
class AudioEvent:
    timestamp: float
    duration: float
    event_type: str
    confidence: float
    frequency_peak: Optional[float] = None
    metadata: Optional[Dict] = None


class CVREventDetector:
    def __init__(self, device: str = None):
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")

        self.alarm_frequencies = {
            "stall_warning": (800, 1200),
            "gpws": (400, 600),
            "fire_bell": (1000, 1400),
            "master_caution": (500, 800),
        }

    def detect_events(
        self,
        audio_path: str,
        window_size: float = 1.0,
        hop_length: float = 0.5,
        confidence_threshold: float = 0.3,
        methods: List[str] = None,
    ) -> List[AudioEvent]:
        methods = methods or ["spectral", "energy", "frequency"]

        waveform, sample_rate = torchaudio.load(audio_path)
        if waveform.shape[0] > 1:
            waveform = waveform.mean(dim=0, keepdim=True)
        audio_np = waveform.squeeze().numpy()

        all_events: List[AudioEvent] = []

        if "spectral" in methods:
            all_events.extend(
                self._detect_alarms_spectral(audio_np, sample_rate, window_size, hop_length)
            )
        if "energy" in methods:
            all_events.extend(
                self._detect_impacts_energy(audio_np, sample_rate, window_size, hop_length)
            )
        if "frequency" in methods:
            all_events.extend(
                self._detect_frequency_anomalies(audio_np, sample_rate, window_size, hop_length)
            )

        return self._filter_and_merge_events(all_events, confidence_threshold)

    def _detect_alarms_spectral(self, audio, sr, window_size, hop_length):
        events = []
        n_fft = 2048
        hop_samples = int(hop_length * sr)
        stft = librosa.stft(audio, n_fft=n_fft, hop_length=hop_samples)
        magnitude = np.abs(stft)

        freqs = librosa.fft_frequencies(sr=sr, n_fft=n_fft)
        times = librosa.frames_to_time(np.arange(magnitude.shape[1]), sr=sr, hop_length=hop_samples)

        for alarm_type, (f_min, f_max) in self.alarm_frequencies.items():
            freq_mask = (freqs >= f_min) & (freqs <= f_max)
            alarm_energy = magnitude[freq_mask, :].sum(axis=0)
            alarm_energy = alarm_energy / (alarm_energy.max() + 1e-8)
            alarm_active = alarm_energy > 0.6

            diff = np.diff(np.concatenate([[0], alarm_active.astype(int), [0]]))
            starts = np.where(diff == 1)[0]
            ends = np.where(diff == -1)[0]

            for start_idx, end_idx in zip(starts, ends):
                duration = times[end_idx - 1] - times[start_idx]
                if duration > 0.3:
                    events.append(
                        AudioEvent(
                            timestamp=float(times[start_idx]),
                            duration=float(duration),
                            event_type=f"alarm_{alarm_type}",
                            confidence=float(alarm_energy[start_idx:end_idx].mean()),
                            frequency_peak=(f_min + f_max) / 2,
                            metadata={"detection_method": "spectral"},
                        )
                    )
        return events

    def _detect_impacts_energy(self, audio, sr, window_size, hop_length):
        events = []
        window_samples = int(window_size * sr)
        hop_samples = int(hop_length * sr)

        energy = []
        times = []
        for i in range(0, len(audio) - window_samples, hop_samples):
            segment = audio[i : i + window_samples]
            energy.append(np.sum(segment ** 2))
            times.append(i / sr)

        energy = np.array(energy)
        times = np.array(times)
        energy = energy / (energy.max() + 1e-8)

        smoothed = np.convolve(energy, np.ones(5) / 5, mode="same")
        diff = energy - smoothed
        threshold = np.percentile(diff, 95)
        spike_indices = np.where(diff > threshold)[0]

        if len(spike_indices) > 0:
            groups = [[spike_indices[0]]]
            for idx in spike_indices[1:]:
                if idx - groups[-1][-1] < 5:
                    groups[-1].append(idx)
                else:
                    groups.append([idx])

            for group in groups:
                center_idx = group[len(group) // 2]
                timestamp = times[center_idx]
                peak_energy = energy[center_idx]

                if peak_energy > 0.8:
                    event_type = "impact_major"
                elif peak_energy > 0.6:
                    event_type = "impact_moderate"
                else:
                    event_type = "impact_minor"

                events.append(
                    AudioEvent(
                        timestamp=float(timestamp),
                        duration=float(window_size),
                        event_type=event_type,
                        confidence=float(peak_energy),
                        metadata={"detection_method": "energy", "peak_energy": float(peak_energy)},
                    )
                )
        return events

    def _detect_frequency_anomalies(self, audio, sr, window_size, hop_length):
        events = []
        mel_spec = librosa.feature.melspectrogram(
            y=audio,
            sr=sr,
            n_mels=128,
            hop_length=int(hop_length * sr),
        )
        mel_spec_db = librosa.power_to_db(mel_spec, ref=np.max)
        times = librosa.frames_to_time(
            np.arange(mel_spec_db.shape[1]),
            sr=sr,
            hop_length=int(hop_length * sr),
        )
        centroid = librosa.feature.spectral_centroid(
            y=audio,
            sr=sr,
            hop_length=int(hop_length * sr),
        )[0]
        centroid_mean = np.mean(centroid)
        centroid_std = np.std(centroid)
        anomaly_threshold = centroid_mean + 2 * centroid_std
        anomalies = centroid > anomaly_threshold

        diff = np.diff(np.concatenate([[0], anomalies.astype(int), [0]]))
        starts = np.where(diff == 1)[0]
        ends = np.where(diff == -1)[0]
        for start_idx, end_idx in zip(starts, ends):
            if end_idx > start_idx:
                duration = times[min(end_idx - 1, len(times) - 1)] - times[start_idx]
                events.append(
                    AudioEvent(
                        timestamp=float(times[start_idx]),
                        duration=float(duration),
                        event_type="frequency_anomaly",
                        confidence=0.5,
                        frequency_peak=float(centroid[start_idx]),
                        metadata={"detection_method": "frequency"},
                    )
                )
        return events

    def _filter_and_merge_events(self, events, confidence_threshold, merge_window=1.0):
        filtered = [e for e in events if e.confidence >= confidence_threshold]
        if not filtered:
            return []
        filtered.sort(key=lambda x: x.timestamp)
        merged = []
        current = filtered[0]
        for next_event in filtered[1:]:
            if (
                next_event.timestamp - current.timestamp < merge_window
                and current.event_type == next_event.event_type
            ):
                current.duration = next_event.timestamp + next_event.duration - current.timestamp
                current.confidence = (current.confidence + next_event.confidence) / 2
            else:
                merged.append(current)
                current = next_event
        merged.append(current)
        return merged


def main():
    parser = argparse.ArgumentParser(description="Detect events in CVR audio")
    parser.add_argument("audio_file", help="Path to audio file")
    parser.add_argument("--output", required=True, help="Output JSON file for events")
    parser.add_argument("--window", type=float, default=1.0, help="Window size in seconds")
    parser.add_argument("--threshold", type=float, default=0.3, help="Confidence threshold")
    parser.add_argument(
        "--methods",
        nargs="+",
        default=["spectral", "energy", "frequency"],
        help="Detection methods to use",
    )
    args = parser.parse_args()

    detector = CVREventDetector()
    events = detector.detect_events(
        args.audio_file,
        window_size=args.window,
        confidence_threshold=args.threshold,
        methods=args.methods,
    )

    events_dict = [
        {
            "timestamp": e.timestamp,
            "duration": e.duration,
            "event_type": e.event_type,
            "confidence": e.confidence,
            "frequency_peak": e.frequency_peak,
            "metadata": e.metadata,
        }
        for e in events
    ]

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as handle:
        json.dump(events_dict, handle, indent=2)


if __name__ == "__main__":
    main()
