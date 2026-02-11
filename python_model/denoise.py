import argparse
import librosa
import soundfile as sf
import torch
from denoiser import pretrained
from denoiser.dsp import convert_audio


def facebook_denoise_aggressive(input_file, output_file):
    """
    Denoise using Facebook/Meta denoiser master64 model.
    """
    print(f"Processing: {input_file}")

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"Using device: {device}")

    print("Loading master64 model...")
    model = pretrained.master64().to(device)
    model.eval()

    print("Loading audio...")
    audio, sr = librosa.load(input_file, sr=None, mono=True)
    wav = torch.from_numpy(audio).float().unsqueeze(0).unsqueeze(0)

    wav = convert_audio(wav, sr, model.sample_rate, model.chin)
    wav = wav.to(device)

    print("Denoising...")
    with torch.no_grad():
        denoised = model(wav)[0]

    denoised_audio = denoised.squeeze().cpu().numpy()
    sf.write(output_file, denoised_audio, model.sample_rate)
    print(f"Saved: {output_file}")


def main():
    parser = argparse.ArgumentParser(description="CVR denoise pipeline")
    parser.add_argument("--input", required=True, help="Input WAV path")
    parser.add_argument("--output", required=True, help="Output WAV path")
    parser.add_argument(
        "--method",
        choices=["facebook_denoiser"],
        default="facebook_denoiser",
        help="Denoise method",
    )
    args = parser.parse_args()
    facebook_denoise_aggressive(args.input, args.output)


if __name__ == "__main__":
    main()
