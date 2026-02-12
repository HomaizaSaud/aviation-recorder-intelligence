#!/usr/bin/env python3
"""
CVR Transcription + Diarization via WhisperX.
"""

import argparse
import json
import os
import warnings
from pathlib import Path

import torch

from transcribe import CVRTranscriber

warnings.filterwarnings("ignore", category=UserWarning)
os.environ.setdefault("TRANSFORMERS_NO_ADVISORY_WARNINGS", "1")


def map_model_name(model_name: str) -> str:
    if model_name.startswith("openai/whisper-"):
        return model_name.replace("openai/whisper-", "")
    return model_name


def main():
    parser = argparse.ArgumentParser(description="Transcribe CVR audio with WhisperX diarization")
    parser.add_argument("audio_path", help="Path to audio file")
    parser.add_argument("--output", required=True, help="Output JSON path")
    parser.add_argument("--model", default="openai/whisper-large-v3")
    parser.add_argument("--model-type", default="transformers", choices=["whisper", "transformers"])
    parser.add_argument("--device", choices=["cuda", "cpu"], help="Device to use (auto-detect if not specified)")
    parser.add_argument("--language", default="en", help="Language code for transcription (default: en)")
    parser.add_argument("--no-timestamps", action="store_true", help="Disable word-level timestamps")
    parser.add_argument("--hf-token", help="HuggingFace token for diarization models")
    args = parser.parse_args()

    try:
        import whisperx
    except ImportError as exc:
        raise RuntimeError("whisperx is required for WhisperX diarization. Install it with `pip install whisperx`.") from exc

    device = args.device or ("cuda" if torch.cuda.is_available() else "cpu")
    compute_type = "float16" if device == "cuda" else "int8"
    model_name = map_model_name(args.model)

    audio_path = Path(args.audio_path)
    if not audio_path.exists():
        raise FileNotFoundError(f"Audio file not found: {audio_path}")

    audio = whisperx.load_audio(str(audio_path))
    model = whisperx.load_model(model_name, device, compute_type=compute_type, language=args.language)
    result = model.transcribe(audio, batch_size=16)

    diarize_model = whisperx.DiarizationPipeline(
        token=args.hf_token or os.getenv("PYANNOTE_TOKEN") or os.getenv("HUGGINGFACE_TOKEN"),
        device=device,
    )
    diarize_segments = diarize_model(audio)
    result = whisperx.assign_word_speakers(diarize_segments, result)

    diarized_transcript = []
    for segment in result.get("segments", []):
        diarized_transcript.append(
            {
                "speaker": segment.get("speaker"),
                "start": segment.get("start"),
                "end": segment.get("end"),
                "text": segment.get("text", "").strip(),
            }
        )

    transcription = result.get("text", "").strip()
    transcriber = CVRTranscriber(
        model_name=args.model,
        model_type=args.model_type,
        device=device,
        language=args.language,
        use_timestamps=not args.no_timestamps,
    )
    transcription_clean = transcriber._remove_speaker_labels(transcription)

    output_payload = [
        {
            "audio_path": str(audio_path),
            "transcription": transcription_clean,
            "words": result.get("segments", []),
            "wer": None,
            "reference": None,
            "model": args.model,
            "sample_rate": 16000,
            "diarization": [],
            "diarized_transcript": diarized_transcript,
            "diarization_error": None,
        }
    ]

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as handle:
        json.dump(output_payload, handle, indent=2)


if __name__ == "__main__":
    main()
