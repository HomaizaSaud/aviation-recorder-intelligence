#!/usr/bin/env python3
"""
CVR Audio Transcription Pipeline
Transcribes CVR audio files from local paths or MinIO and saves outputs locally or to MinIO.
"""

import argparse
import json
import os
import shutil
import tempfile
from pathlib import Path
from typing import Optional, Dict, List, Tuple
from urllib.parse import urlparse

import torch
import torchaudio
from tqdm import tqdm
import whisper
from transformers import pipeline
import difflib


def is_minio_path(path: str) -> bool:
    return isinstance(path, str) and path.startswith("minio://")


def parse_minio_uri(uri: str) -> Tuple[str, str]:
    parsed = urlparse(uri)
    if parsed.scheme != "minio":
        raise ValueError(f"Invalid MinIO URI: {uri}")
    bucket = parsed.netloc
    key = parsed.path.lstrip("/")
    return bucket, key


def build_minio_client(args) -> "Minio":
    try:
        from minio import Minio
    except ImportError as exc:
        raise RuntimeError("minio package is required for MinIO access. Install it first.") from exc

    endpoint = args.minio_endpoint or os.getenv("MINIO_ENDPOINT", "")
    access_key = args.minio_access_key or os.getenv("MINIO_ACCESS_KEY", "")
    secret_key = args.minio_secret_key or os.getenv("MINIO_SECRET_KEY", "")
    secure_env = os.getenv("MINIO_USE_SSL", "")

    if not endpoint:
        raise RuntimeError("MINIO_ENDPOINT is required for MinIO access.")
    if not access_key or not secret_key:
        raise RuntimeError("MINIO_ACCESS_KEY and MINIO_SECRET_KEY are required for MinIO access.")

    parsed = urlparse(endpoint)
    secure = parsed.scheme == "https"
    if secure_env:
        secure = secure_env.strip().lower() in {"true", "1", "yes"}
    host = parsed.netloc or parsed.path

    return Minio(host, access_key=access_key, secret_key=secret_key, secure=secure)


def list_minio_wavs(client, bucket: str, prefix: str) -> List[str]:
    wav_keys = []
    for obj in client.list_objects(bucket, prefix=prefix, recursive=True):
        key = obj.object_name
        if key.lower().endswith(".wav"):
            wav_keys.append(key)
    return sorted(wav_keys)


def download_minio_object(client, bucket: str, key: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    client.fget_object(bucket, key, str(dest))


def upload_minio_object(client, bucket: str, key: str, src: Path) -> None:
    client.fput_object(bucket, key, str(src))


class CVRTranscriber:
    """Handles transcription of CVR audio files."""

    def __init__(
        self,
        model_name: str = "openai/whisper-large-v3",
        model_type: str = "transformers",
        device: Optional[str] = None,
        language: str = "en",
        use_timestamps: bool = True,
    ):
        self.model_name = model_name
        self.model_type = model_type
        self.language = language
        self.use_timestamps = use_timestamps

        if device is None:
            self.device = "cuda" if torch.cuda.is_available() else "cpu"
        else:
            self.device = device

        print(f"Initializing transcriber on {self.device}...")
        self._load_model()

    def _load_model(self):
        if self.model_type == "whisper":
            model_size = self.model_name.split("-")[-1]
            self.model = whisper.load_model(model_size, device=self.device)
            print(f"Loaded Whisper {model_size} model")
        elif self.model_type == "transformers":
            self.pipe = pipeline(
                "automatic-speech-recognition",
                model=self.model_name,
                device=0 if self.device == "cuda" else -1,
                return_timestamps="word" if self.use_timestamps else False,
                chunk_length_s=30,
                stride_length_s=5,
            )
            print(f"Loaded {self.model_name} via transformers")
        else:
            raise ValueError(f"Unknown model_type: {self.model_type}")

    def transcribe_file(
        self,
        audio_path: str,
        reference_transcript: Optional[str] = None,
    ) -> Dict:
        print(f"\nTranscribing: {audio_path}")

        waveform, sample_rate = torchaudio.load(audio_path)
        if waveform.shape[0] > 1:
            waveform = torch.mean(waveform, dim=0, keepdim=True)

        if sample_rate != 16000:
            resampler = torchaudio.transforms.Resample(sample_rate, 16000)
            waveform = resampler(waveform)
            sample_rate = 16000

        audio_np = waveform.squeeze().numpy()

        if self.model_type == "whisper":
            result = self.model.transcribe(
                audio_np,
                language=self.language,
                task="transcribe",
                word_timestamps=self.use_timestamps,
                fp16=(self.device == "cuda"),
            )
            transcription = result["text"].strip()
            segments = result.get("segments", [])
            words = []
            for segment in segments:
                if "words" in segment:
                    words.extend(segment["words"])
        elif self.model_type == "transformers":
            result = self.pipe(audio_np, generate_kwargs={"language": self.language})
            transcription = result["text"].strip()
            words = []
            if self.use_timestamps and "chunks" in result:
                words = [
                    {
                        "word": chunk["text"],
                        "start": chunk["timestamp"][0],
                        "end": chunk["timestamp"][1],
                    }
                    for chunk in result["chunks"]
                    if chunk["timestamp"][0] is not None
                ]

        transcription_clean = self._remove_speaker_labels(transcription)

        wer = None
        if reference_transcript:
            wer = self._calculate_wer(reference_transcript, transcription_clean)
            print(f"Word Error Rate: {wer:.2%}")

        return {
            "audio_path": audio_path,
            "transcription": transcription_clean,
            "words": words,
            "wer": wer,
            "reference": reference_transcript,
            "model": self.model_name,
            "sample_rate": sample_rate,
        }

    def transcribe_batch(
        self,
        audio_files: List[Path],
        reference_dir: Optional[str],
        output_path: Path,
    ) -> List[Dict]:
        if not audio_files:
            print("No .wav files found.")
            return []

        print(f"Found {len(audio_files)} audio files")
        results = []
        for audio_path in tqdm(audio_files, desc="Transcribing"):
            reference = None
            if reference_dir:
                ref_path = Path(reference_dir) / f"{audio_path.stem}.txt"
                if ref_path.exists():
                    reference = ref_path.read_text().strip()
            result = self.transcribe_file(str(audio_path), reference)
            results.append(result)

        self._save_results(results, output_path)
        self._print_summary(results)
        return results

    def _calculate_wer(self, reference: str, hypothesis: str) -> float:
        reference_cleaned = self._remove_speaker_labels(reference)
        ref_words = reference_cleaned.lower().split()
        hyp_words = hypothesis.lower().split()
        sm = difflib.SequenceMatcher(None, ref_words, hyp_words)
        errors = 0
        for tag, i1, i2, j1, j2 in sm.get_opcodes():
            if tag == "replace":
                errors += max(i2 - i1, j2 - j1)
            elif tag == "delete":
                errors += i2 - i1
            elif tag == "insert":
                errors += j2 - j1
        return errors / len(ref_words) if ref_words else 0.0

    def _remove_speaker_labels(self, text: str) -> str:
        import re

        lines = text.split("\n")
        cleaned_lines = []
        patterns = [
            r"^\[SPEAKER_\d+\]\s*",
            r"^\[Speaker\s+\d+\]\s*",
            r"^\[speaker\s+\d+\]\s*",
            r"^SPEAKER_?\d+:?\s*",
            r"^Speaker\s+\d+:?\s*",
            r"^\([Ss]peaker[\s_]?\d+\)\s*",
            r"^[A-Z][A-Z_]+:\s*",
            r"^S\d+:\s*",
        ]

        for line in lines:
            cleaned_line = line.strip()
            for pattern in patterns:
                cleaned_line = re.sub(pattern, "", cleaned_line)
            if cleaned_line:
                cleaned_lines.append(cleaned_line)

        return "\n".join(cleaned_lines)

    def _save_results(self, results: List[Dict], output_path: Path):
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with open(output_path, "w") as f:
            json.dump(results, f, indent=2)
        print(f"\nResults saved to: {output_path}")

        txt_dir = output_path.parent / "transcripts"
        txt_dir.mkdir(exist_ok=True)

        for result in results:
            audio_name = Path(result["audio_path"]).stem
            txt_path = txt_dir / f"{audio_name}.txt"
            formatted_text = self._format_transcription(result["transcription"])
            txt_path.write_text(formatted_text)

        print(f"Transcripts saved to: {txt_dir}")

    def _format_transcription(self, text: str) -> str:
        import re

        sentences = re.split(r"(?<=[.!?])\s+", text)
        formatted_sentences = [s.strip() for s in sentences if s.strip()]
        return "\n".join(formatted_sentences)

    def _print_summary(self, results: List[Dict]):
        print("\n" + "=" * 60)
        print("TRANSCRIPTION SUMMARY")
        print("=" * 60)
        total_files = len(results)
        print(f"Total files transcribed: {total_files}")
        wers = [r["wer"] for r in results if r["wer"] is not None]
        if wers:
            avg_wer = sum(wers) / len(wers)
            min_wer = min(wers)
            max_wer = max(wers)
            print("\nWord Error Rate Statistics:")
            print(f"  Average WER: {avg_wer:.2%}")
            print(f"  Min WER: {min_wer:.2%}")
            print(f"  Max WER: {max_wer:.2%}")
        print("=" * 60)


def main():
    parser = argparse.ArgumentParser(description="Transcribe CVR audio files using ASR models")
    parser.add_argument("audio_path", help="Path or MinIO URI to audio file or directory")
    parser.add_argument("--reference-dir", help="Local path or MinIO URI to reference transcripts")
    parser.add_argument(
        "--output",
        default="transcription_results.json",
        help="Output file path or MinIO URI for results JSON",
    )
    parser.add_argument(
        "--model",
        default="openai/whisper-large-v3",
        choices=[
            "openai/whisper-large-v3",
            "openai/whisper-medium",
            "openai/whisper-small",
            "large-v3",
            "medium",
            "small",
            "facebook/wav2vec2-large-960h-lv60-self",
        ],
        help="ASR model to use",
    )
    parser.add_argument(
        "--model-type",
        default="transformers",
        choices=["whisper", "transformers"],
        help="Model framework (whisper=original, transformers=HF pipeline)",
    )
    parser.add_argument("--device", choices=["cuda", "cpu"], help="Device to use (auto-detect if not specified)")
    parser.add_argument("--language", default="en", help="Language code for transcription (default: en)")
    parser.add_argument("--no-timestamps", action="store_true", help="Disable word-level timestamps")
    parser.add_argument("--minio-endpoint", help="MinIO endpoint (e.g., http://127.0.0.1:9000)")
    parser.add_argument("--minio-access-key", help="MinIO access key")
    parser.add_argument("--minio-secret-key", help="MinIO secret key")
    parser.add_argument("--minio-output-bucket", help="Optional MinIO bucket for outputs")

    args = parser.parse_args()

    transcriber = CVRTranscriber(
        model_name=args.model,
        model_type=args.model_type,
        device=args.device,
        language=args.language,
        use_timestamps=not args.no_timestamps,
    )

    use_minio_input = is_minio_path(args.audio_path)
    use_minio_output = is_minio_path(args.output)
    reference_is_minio = is_minio_path(args.reference_dir) if args.reference_dir else False

    client = None
    if use_minio_input or use_minio_output or reference_is_minio:
        client = build_minio_client(args)

    with tempfile.TemporaryDirectory() as tmpdir:
        staging_dir = Path(tmpdir)
        reference_dir = None

        if reference_is_minio:
            reference_dir = staging_dir / "references"
            reference_dir.mkdir(parents=True, exist_ok=True)
        elif args.reference_dir:
            reference_dir = args.reference_dir

        if use_minio_input:
            bucket, key = parse_minio_uri(args.audio_path)
            if key.lower().endswith(".wav"):
                local_audio = staging_dir / Path(key).name
                download_minio_object(client, bucket, key, local_audio)
                audio_files = [local_audio]
            else:
                wav_keys = list_minio_wavs(client, bucket, key)
                audio_files = []
                for wav_key in wav_keys:
                    local_audio = staging_dir / Path(wav_key).name
                    download_minio_object(client, bucket, wav_key, local_audio)
                    audio_files.append(local_audio)
        else:
            audio_path = Path(args.audio_path)
            if audio_path.is_file():
                audio_files = [audio_path]
            elif audio_path.is_dir():
                audio_files = sorted(audio_path.glob("*.wav"))
            else:
                raise RuntimeError(f"{audio_path} is not a valid file or directory")

        if reference_is_minio and client:
            ref_bucket, ref_prefix = parse_minio_uri(args.reference_dir)
            for audio_file in audio_files:
                ref_key = f"{ref_prefix.rstrip('/')}/{audio_file.stem}.txt"
                dest = Path(reference_dir) / f"{audio_file.stem}.txt"
                try:
                    download_minio_object(client, ref_bucket, ref_key, dest)
                except Exception:
                    pass

        output_bucket = None
        output_key = None
        output_path = Path(args.output)
        if use_minio_output:
            output_bucket, output_key = parse_minio_uri(args.output)
            if not output_key.endswith(".json"):
                output_key = f"{output_key.rstrip('/')}/transcription_results.json"
            output_path = staging_dir / Path(output_key).name

        if len(audio_files) == 1:
            audio_file = audio_files[0]
            reference = None
            if reference_dir:
                ref_path = Path(reference_dir) / f"{audio_file.stem}.txt"
                if ref_path.exists():
                    reference = ref_path.read_text().strip()
            result = transcriber.transcribe_file(str(audio_file), reference)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            with open(output_path, "w") as f:
                json.dump([result], f, indent=2)
            print(f"\nJSON result saved to: {output_path}")
            txt_output = output_path.parent / f"{audio_file.stem}_transcription.txt"
            formatted_text = transcriber._format_transcription(result["transcription"])
            txt_output.write_text(formatted_text)
            print(f"Text transcription saved to: {txt_output}")
        else:
            transcriber.transcribe_batch(audio_files, str(reference_dir) if reference_dir else None, output_path)

        if use_minio_output and client and output_bucket and output_key:
            target_bucket = args.minio_output_bucket or output_bucket
            upload_minio_object(client, target_bucket, output_key, output_path)

            transcripts_dir = output_path.parent / "transcripts"
            if transcripts_dir.exists():
                prefix = str(Path(output_key).parent)
                if prefix == ".":
                    prefix = ""
                for txt_path in transcripts_dir.glob("*.txt"):
                    key_name = f"{prefix}/transcripts/{txt_path.name}" if prefix else f"transcripts/{txt_path.name}"
                    upload_minio_object(client, target_bucket, key_name, txt_path)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
