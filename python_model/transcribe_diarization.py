#!/usr/bin/env python3
"""
CVR Diarization + Transcription Integration
Combines speaker diarization with ASR transcription for a single audio file.
"""

import argparse
import json
import os
from pathlib import Path
from typing import Dict, List, Optional

import torch
import torchaudio
from pyannote.audio import Pipeline
import whisper
from transformers import pipeline as hf_pipeline

# Fix for PyTorch 2.6+ compatibility with pyannote
import torch.serialization
torch.serialization.add_safe_globals([torch.torch_version.TorchVersion])


class DiarizedTranscriber:
    """Combines speaker diarization with transcription"""

    def __init__(
        self,
        diar_model: str = "pyannote/speaker-diarization-3.1",
        asr_model: str = "openai/whisper-large-v3",
        asr_type: str = "transformers",
        device: Optional[str] = None,
        language: str = "en",
    ):
        self.language = language

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

        print("Loading ASR model...")
        self.asr_type = asr_type
        if asr_type == "transformers":
            self.asr_pipeline = hf_pipeline(
                "automatic-speech-recognition",
                model=asr_model,
                device=0 if self.device == "cuda" else -1,
                return_timestamps="word",
                chunk_length_s=30,
                stride_length_s=5,
            )
        elif asr_type == "whisper":
            model_size = asr_model.split("-")[-1]
            self.asr_model = whisper.load_model(model_size, device=self.device)

        print("Models loaded successfully!\n")

    def process_file(self, audio_path: str, reference_transcript: Optional[str] = None) -> Dict:
        print(f"Processing: {audio_path}")

        waveform, sample_rate = torchaudio.load(audio_path)
        if waveform.shape[0] > 1:
            waveform = torch.mean(waveform, dim=0, keepdim=True)

        if sample_rate != 16000:
            resampler = torchaudio.transforms.Resample(sample_rate, 16000)
            waveform_16k = resampler(waveform)
        else:
            waveform_16k = waveform

        audio_np = waveform_16k.squeeze().numpy()

        print("  Running diarization...")
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

        print(f"  Found {len(speaker_segments)} speaker segments")

        print("  Running transcription...")
        if self.asr_type == "transformers":
            asr_result = self.asr_pipeline(
                audio_np,
                generate_kwargs={"language": self.language},
            )
            words = []
            if "chunks" in asr_result:
                for chunk in asr_result["chunks"]:
                    if chunk["timestamp"][0] is not None:
                        words.append(
                            {
                                "word": chunk["text"].strip(),
                                "start": chunk["timestamp"][0],
                                "end": chunk["timestamp"][1],
                            }
                        )
            full_text = asr_result["text"]
        elif self.asr_type == "whisper":
            asr_result = self.asr_model.transcribe(
                audio_np,
                language=self.language,
                word_timestamps=True,
                fp16=(self.device == "cuda"),
            )
            words = []
            for segment in asr_result.get("segments", []):
                if "words" in segment:
                    for word_info in segment["words"]:
                        words.append(
                            {
                                "word": word_info.get("word", "").strip(),
                                "start": word_info.get("start", 0),
                                "end": word_info.get("end", 0),
                            }
                        )
            full_text = asr_result["text"]

        print(f"  Transcribed {len(words)} words")

        print("  Aligning speakers with transcription...")
        aligned_words = self._align_speakers_to_words(words, speaker_segments)
        utterances = self._create_utterances(aligned_words)

        print(f"  Created {len(utterances)} utterances\n")

        return {
            "audio_path": audio_path,
            "transcription": full_text,
            "utterances": utterances,
            "speaker_segments": speaker_segments,
            "total_speakers": len(set(s["speaker"] for s in speaker_segments)),
            "reference_transcript": reference_transcript,
        }

    def _align_speakers_to_words(self, words: List[Dict], speaker_segments: List[Dict]) -> List[Dict]:
        aligned_words = []
        for word in words:
            word_start = word["start"]
            word_end = word["end"]
            word_mid = (word_start + word_end) / 2
            best_speaker = None
            max_overlap = 0

            for seg in speaker_segments:
                overlap_start = max(word_start, seg["start"])
                overlap_end = min(word_end, seg["end"])
                overlap = max(0, overlap_end - overlap_start)
                if overlap > max_overlap:
                    max_overlap = overlap
                    best_speaker = seg["speaker"]

            if best_speaker is None:
                for seg in speaker_segments:
                    if seg["start"] <= word_mid <= seg["end"]:
                        best_speaker = seg["speaker"]
                        break

            if best_speaker is None:
                min_distance = float("inf")
                for seg in speaker_segments:
                    distance = min(abs(word_mid - seg["start"]), abs(word_mid - seg["end"]))
                    if distance < min_distance:
                        min_distance = distance
                        best_speaker = seg["speaker"]

            aligned_words.append({**word, "speaker": best_speaker})

        return aligned_words

    def _create_utterances(self, aligned_words: List[Dict]) -> List[Dict]:
        if not aligned_words:
            return []

        utterances = []
        current_speaker = aligned_words[0]["speaker"]
        current_words = [aligned_words[0]]

        for word in aligned_words[1:]:
            if word["speaker"] == current_speaker:
                current_words.append(word)
            else:
                utterances.append(self._make_utterance(current_speaker, current_words))
                current_speaker = word["speaker"]
                current_words = [word]

        if current_words:
            utterances.append(self._make_utterance(current_speaker, current_words))

        return utterances

    def _make_utterance(self, speaker: str, words: List[Dict]) -> Dict:
        text = " ".join(w["word"] for w in words)
        return {
            "speaker": speaker,
            "start": words[0]["start"],
            "end": words[-1]["end"],
            "text": text,
            "words": words,
        }


def main():
    parser = argparse.ArgumentParser(description="Diarization + Transcription for CVR audio")
    parser.add_argument("audio_path", help="Path to audio file")
    parser.add_argument("--output", required=True, help="Output JSON path")
    parser.add_argument("--diar-model", default="pyannote/speaker-diarization-3.1", help="Diarization model")
    parser.add_argument("--asr-model", default="openai/whisper-large-v3", help="ASR model")
    parser.add_argument("--asr-type", default="transformers", choices=["transformers", "whisper"], help="ASR framework")
    parser.add_argument("--model", help="Alias for --asr-model")
    parser.add_argument("--model-type", choices=["transformers", "whisper"], help="Alias for --asr-type")
    parser.add_argument("--device", choices=["cuda", "cpu"], help="Device")
    parser.add_argument("--language", default="en", help="Language code")

    args = parser.parse_args()
    audio_path = Path(args.audio_path)
    if not audio_path.exists():
        raise FileNotFoundError(f"Audio file not found: {audio_path}")

    asr_model = args.model or args.asr_model
    asr_type = args.model_type or args.asr_type

    processor = DiarizedTranscriber(
        diar_model=args.diar_model,
        asr_model=asr_model,
        asr_type=asr_type,
        device=args.device,
        language=args.language,
    )

    result = processor.process_file(str(audio_path))
    utterances = result.get("utterances", [])
    output_payload = [
        {
            "audio_path": result.get("audio_path"),
            "transcription": result.get("transcription", ""),
            "words": [],
            "wer": None,
            "reference": None,
            "model": asr_model,
            "sample_rate": 16000,
            "diarization": result.get("speaker_segments", []),
            "diarized_transcript": [
                {
                    "speaker": utt["speaker"],
                    "start": utt["start"],
                    "end": utt["end"],
                    "text": utt["text"],
                }
                for utt in utterances
            ],
            "diarization_error": None,
        }
    ]

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as handle:
        json.dump(output_payload, handle, indent=2)


if __name__ == "__main__":
    raise SystemExit(main())
