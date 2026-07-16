#!/usr/bin/env python3
"""
CVR Channel Separation
Runs speaker diarization only (no ASR) and slices the input audio into one
playable clip per detected speaker, by concatenating that speaker's segments.
"""

import argparse
import json
import os
from pathlib import Path
from typing import Dict, List, Optional

import torch
import torchaudio
from pyannote.audio import Pipeline

# Fix for PyTorch 2.6+ compatibility with pyannote
import torch.serialization
torch.serialization.add_safe_globals([torch.torch_version.TorchVersion])


class ChannelSeparator:
    """Diarizes an audio file and exports one concatenated clip per speaker."""

    def __init__(
        self,
        diar_model: str = "pyannote/speaker-diarization-3.1",
        device: Optional[str] = None,
    ):
        if device is None:
            self.device = "cuda" if torch.cuda.is_available() else "cpu"
        else:
            self.device = device

        print(f"Using device: {self.device}")

        print("Loading diarization model...")
        hf_token = os.getenv("HF_TOKEN") or os.getenv("PYANNOTE_TOKEN") or os.getenv("HUGGINGFACE_TOKEN")

        original_load = torch.load

        def safe_load(*args, **kwargs):
            kwargs["weights_only"] = False
            return original_load(*args, **kwargs)

        torch.load = safe_load

        try:
            self.diar_pipeline = Pipeline.from_pretrained(diar_model, token=hf_token)
        except Exception:
            try:
                self.diar_pipeline = Pipeline.from_pretrained(diar_model, token=hf_token)
            except Exception:
                self.diar_pipeline = Pipeline.from_pretrained(diar_model)

        torch.load = original_load

        if torch.cuda.is_available() and self.device == "cuda":
            self.diar_pipeline.to(torch.device("cuda"))

        print("Model loaded successfully!\n")

    def _diarize(self, waveform: torch.Tensor, sample_rate: int) -> List[Dict]:
        audio_input = {"waveform": waveform, "sample_rate": sample_rate}
        try:
            diarization = self.diar_pipeline(audio_input)
        except RuntimeError as exc:
            message = str(exc).lower()
            is_gpu_issue = self.device == "cuda" and (
                "cuda" in message or "nvrtc" in message or "cudnn" in message
            )
            if not is_gpu_issue:
                raise
            print(f"  GPU diarization failed ({exc}); retrying on CPU...")
            self.diar_pipeline.to(torch.device("cpu"))
            self.device = "cpu"
            diarization = self.diar_pipeline(audio_input)

        speaker_segments = []
        if hasattr(diarization, "speaker_diarization"):
            annotation = diarization.speaker_diarization
            for segment, _, speaker in annotation.itertracks(yield_label=True):
                speaker_segments.append(
                    {"speaker": speaker, "start": segment.start, "end": segment.end}
                )
        else:
            rttm_lines = str(diarization).strip().split("\n")
            for line in rttm_lines:
                if line.startswith("SPEAKER"):
                    parts = line.split()
                    if len(parts) >= 8:
                        start = float(parts[3])
                        duration = float(parts[4])
                        speaker = parts[7]
                        speaker_segments.append(
                            {"speaker": speaker, "start": start, "end": start + duration}
                        )

        return speaker_segments

    def process_file(self, audio_path: str, output_dir: str) -> Dict:
        print(f"Processing: {audio_path}")

        waveform, sample_rate = torchaudio.load(audio_path)
        if waveform.shape[0] > 1:
            waveform = torch.mean(waveform, dim=0, keepdim=True)

        print("  Running diarization...")
        speaker_segments = self._diarize(waveform, sample_rate)
        print(f"  Found {len(speaker_segments)} speaker segments")

        speakers = sorted(set(seg["speaker"] for seg in speaker_segments))
        output_dir_path = Path(output_dir)
        output_dir_path.mkdir(parents=True, exist_ok=True)

        channels = []
        for speaker in speakers:
            speaker_segs = [seg for seg in speaker_segments if seg["speaker"] == speaker]
            clips = []
            for seg in speaker_segs:
                start_sample = max(0, int(seg["start"] * sample_rate))
                end_sample = min(waveform.shape[1], int(seg["end"] * sample_rate))
                if end_sample > start_sample:
                    clips.append(waveform[:, start_sample:end_sample])

            if not clips:
                continue

            speaker_waveform = torch.cat(clips, dim=1)
            filename = f"speaker_{speaker}.wav"
            output_path = output_dir_path / filename
            torchaudio.save(str(output_path), speaker_waveform, sample_rate)

            channels.append(
                {
                    "speaker": speaker,
                    "filename": filename,
                    "duration": speaker_waveform.shape[1] / sample_rate,
                    "segments": [{"start": seg["start"], "end": seg["end"]} for seg in speaker_segs],
                }
            )
            print(f"  Wrote {filename} ({channels[-1]['duration']:.1f}s, {len(speaker_segs)} segments)")

        return {
            "audio_path": audio_path,
            "total_speakers": len(channels),
            "channels": channels,
        }


def main():
    parser = argparse.ArgumentParser(description="Speaker-based channel separation for CVR audio")
    parser.add_argument("audio_path", help="Path to audio file")
    parser.add_argument("--output-dir", required=True, help="Directory to write per-speaker clips into")
    parser.add_argument("--manifest", required=True, help="Path to write the JSON manifest to")
    parser.add_argument("--diar-model", default="pyannote/speaker-diarization-3.1", help="Diarization model")
    parser.add_argument("--device", choices=["cuda", "cpu"], help="Device")

    args = parser.parse_args()
    audio_path = Path(args.audio_path)
    if not audio_path.exists():
        raise FileNotFoundError(f"Audio file not found: {audio_path}")

    separator = ChannelSeparator(diar_model=args.diar_model, device=args.device)
    result = separator.process_file(str(audio_path), args.output_dir)

    manifest_path = Path(args.manifest)
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    with manifest_path.open("w", encoding="utf-8") as handle:
        json.dump(result, handle, indent=2)


if __name__ == "__main__":
    raise SystemExit(main())
