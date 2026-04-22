#!/usr/bin/env python3
"""
Emotion detection CLI using WavLMWrapper model.

Usage:
  python emotion_detection.py --audio path/to/file.wav --checkpoint ./emotion_detection/best.pt
"""
import argparse
import json
import sys
from pathlib import Path
import torch
import torchaudio
import os

# Suppress all non-JSON output
import warnings
warnings.filterwarnings('ignore')
import os
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '3'
os.environ['TRANSFORMERS_VERBOSITY'] = 'error'
import logging
logging.getLogger().setLevel(logging.ERROR)

# Add this import at the top
import logging
logging.basicConfig(level=logging.ERROR)
# Add current directory to path for imports
sys.path.insert(0, str(Path(__file__).parent))

from model.wavlm_plus import WavLMWrapper

LABELS = ["anger", "anxiety", "calm", "confusion", "disgust", "fear"]
TARGET_SR = 16000


def load_audio(path: Path, duration: float = 4.0):
    """Load and preprocess audio file."""
    import soundfile as sf
    
    # Check if MP3, convert to WAV first
    if str(path).lower().endswith('.mp3'):
        from pydub import AudioSegment
        import tempfile
        
        # Convert MP3 to WAV in memory
        audio = AudioSegment.from_mp3(str(path))
        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp:
            audio.export(tmp.name, format='wav')
            waveform, sr = sf.read(tmp.name)
        import os
        os.unlink(tmp.name)
    else:
        # Load WAV/FLAC/OGG directly
        waveform, sr = sf.read(str(path))
    
    # Convert to torch tensor
    waveform = torch.from_numpy(waveform).float()
    
    # Convert to mono if stereo
    if waveform.ndim == 2:
        waveform = waveform.mean(dim=1)
    elif waveform.ndim == 1:
        pass  # Already mono
    else:
        raise ValueError(f"Unexpected audio shape: {waveform.shape}")
    
    # Resample if needed
    if sr != TARGET_SR:
        import torchaudio.transforms as T
        resample = T.Resample(sr, TARGET_SR)
        waveform = resample(waveform)
    
    # Pad or trim to target duration
    target_length = int(TARGET_SR * duration)
    current_length = len(waveform)
    
    if current_length < target_length:
        # Pad
        padding = target_length - current_length
        waveform = torch.nn.functional.pad(waveform, (0, padding))
    elif current_length > target_length:
        # Trim
        waveform = waveform[:target_length]
    
    return waveform  # Return 1D tensor


def load_model(checkpoint_path: Path, device):
    """Load model from checkpoint."""
    # PyTorch 2.6 defaults weights_only=True; this checkpoint needs full load.
    # Only set weights_only=False for trusted checkpoints.
    ckpt = torch.load(checkpoint_path, map_location=device, weights_only=False)
    
    # Get args from checkpoint
    args_dict = ckpt.get("args", {})
    
    # Create a simple namespace object from dict
    class Args:
        pass
    
    args = Args()
    
    # Set defaults for all required attributes
    defaults = {
        'finetune_method': 'lora',
        'downstream_model': 'linear',
        'pooling': 'mean',
        'norm': 'layernorm',
        'num_layers': 2,
        'hidden_size': 256,
        'lora_rank': 16,
        'adapter_hidden_dim': 64,
        'finetune_emb': False,
        'embedding_prompt_dim': 0,
        'use_conv_output': False,
        'pretrain_model': 'wavlm_plus',
        'output_class_num': len(LABELS),  # CRITICAL: set to 6
    }
    
    # First set defaults, then override with checkpoint values
    for key, value in defaults.items():
        setattr(args, key, value)
    
    for key, value in args_dict.items():
        setattr(args, key, value)
    
    # FORCE the correct number of classes (override checkpoint if different)
    args.output_class_num = len(LABELS)
    
    # Create model
    import sys
    from io import StringIO
    old_stdout = sys.stdout
    sys.stdout = StringIO()
    try:
        model = WavLMWrapper(args, output_class_num=len(LABELS))
    finally:
        sys.stdout = old_stdout
    
    # Load weights
    model.load_state_dict(ckpt["model_state_dict"], strict=False)
    model.eval()
    model.to(device)
    
    return model


def predict(model, audio: torch.Tensor, device):
    """Run inference on audio."""
    # Add batch dimension
    audio = audio.unsqueeze(0).to(device)
    
    # Create length tensor
    length = torch.tensor([audio.shape[1]], dtype=torch.long, device=device)
    
    with torch.no_grad():
        logits = model(audio, length=length)
        probs = torch.softmax(logits, dim=-1).squeeze(0)
    
    scores = {LABELS[i]: float(probs[i]) for i in range(len(LABELS))}
    top_idx = int(torch.argmax(probs))
    
    return {"label": LABELS[top_idx], "scores": scores}


def predict_hf(audio: torch.Tensor):
    """Run inference with Hugging Face audio-classification pipeline."""
    from transformers import pipeline

    pipe = pipeline(
        "audio-classification",
        model="superb/wav2vec2-base-superb-er",
        device=0 if torch.cuda.is_available() else -1,
    )

    result = pipe({"array": audio.cpu().numpy(), "sampling_rate": TARGET_SR})
    scores = {item["label"]: float(item["score"]) for item in result}
    top_item = max(result, key=lambda item: item["score"]) if result else {"label": "unknown", "score": 0.0}
    return {"label": top_item["label"], "scores": scores}


def main():
    parser = argparse.ArgumentParser(description="Detect emotion from CVR audio")
    parser.add_argument("--audio", required=True, help="Path to WAV audio file")
    parser.add_argument(
        "--checkpoint",
        default=str(Path(__file__).parent / "emotion_detection" / "best.pt"),
        help="Path to model checkpoint"
    )
    parser.add_argument("--duration", type=float, default=4.0, help="Audio duration in seconds")
    parser.add_argument(
        "--backend",
        default="wavlm",
        choices=["wavlm", "hf_superb"],
        help="Emotion backend to use",
    )
    args = parser.parse_args()

    try:
        # Setup
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        audio_path = Path(args.audio).expanduser().resolve(strict=True)
        checkpoint_path = Path(args.checkpoint).expanduser().resolve(strict=True)
        
        # Load and process audio
        audio = load_audio(audio_path, args.duration)

        if args.backend == "hf_superb":
            result = predict_hf(audio)
        else:
            # Load model
            model = load_model(checkpoint_path, device)
            # Predict
            result = predict(model, audio, device)
        
        # Format output
        payload = {
            "label": result["label"],
            "scores": result["scores"],
            "model": {
                "checkpoint": str(checkpoint_path),
                "labels": LABELS,
            },
            "backend": args.backend,
            "audio": {
                "path": str(audio_path),
                "sample_rate": TARGET_SR,
                "duration_sec": args.duration,
            },
        }
        
        print(json.dumps(payload))
        return 0
        
    except Exception as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
