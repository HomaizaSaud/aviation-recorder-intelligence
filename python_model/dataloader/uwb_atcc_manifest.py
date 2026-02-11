"""
Dataloader for UWB-ATCC stress detection audio dataset using manifest files.
"""
from pathlib import Path
import pandas as pd
import torch
from torch.utils.data import Dataset, DataLoader
import soundfile as sf
import logging

# Label mapping
LABEL2ID = {"normal": 0, "stress": 1}
ID2LABEL = {0: "normal", 1: "stress"}


class ManifestAudioDataset(Dataset):
    """
    Audio dataset that loads from a manifest CSV file.

    Manifest CSV format:
    - path: absolute or relative path to audio file
    - label: 'normal' or 'stress'
    """

    def __init__(self, manifest_csv: str, audio_duration: float = 4.0, is_train: bool = True):
        """
        Args:
            manifest_csv: Path to manifest CSV file
            audio_duration: Target audio duration in seconds
            is_train: Whether this is training data (affects augmentation, etc.)
        """
        self.manifest_csv = manifest_csv
        self.audio_duration = audio_duration
        self.is_train = is_train

        # Load manifest
        try:
            self.df = pd.read_csv(manifest_csv)
            logging.info(f"Loaded {len(self.df)} samples from {manifest_csv}")
        except Exception as e:
            logging.error(f"Failed to load manifest {manifest_csv}: {e}")
            raise

        # Validate manifest has required columns
        if 'path' not in self.df.columns or 'label' not in self.df.columns:
            raise ValueError(f"Manifest must have 'path' and 'label' columns. "
                             f"Found: {self.df.columns.tolist()}")

        # Check for invalid labels
        invalid_labels = set(self.df['label'].unique()) - set(LABEL2ID.keys())
        if invalid_labels:
            raise ValueError(f"Invalid labels found in manifest: {invalid_labels}. "
                             f"Valid labels are: {list(LABEL2ID.keys())}")

        # Log label distribution
        label_counts = self.df['label'].value_counts()
        logging.info(f"Label distribution: {label_counts.to_dict()}")

    def __len__(self):
        return len(self.df)

    def __getitem__(self, idx):
        """
        Returns:
            wav: Audio waveform tensor [T]
            label: Integer label (0 or 1)
            length: Actual length of the audio
        """
        row = self.df.iloc[idx]
        wav_path = row["path"]
        label_str = row["label"]

        try:
            # Load audio
            wav, sr = sf.read(wav_path, dtype="float32")

            # Convert to tensor
            wav = torch.from_numpy(wav).float()

            # Handle stereo to mono
            if wav.dim() > 1:
                wav = wav.mean(dim=-1)

            # Fixed duration: trim or pad
            target_len = int(sr * self.audio_duration)
            if wav.numel() > target_len:
                # Trim to target length
                wav = wav[:target_len]
            elif wav.numel() < target_len:
                # Pad with zeros
                pad = target_len - wav.numel()
                wav = torch.nn.functional.pad(wav, (0, pad))

            length = torch.tensor(wav.numel(), dtype=torch.long)
            label = torch.tensor(LABEL2ID[label_str], dtype=torch.long)

            return wav, label, length

        except Exception as e:
            logging.error(f"Error loading audio {wav_path}: {e}")
            # Return a dummy sample to avoid breaking the batch
            # In production, you might want to handle this differently
            target_len = int(16000 * self.audio_duration)  # Assume 16kHz
            dummy_wav = torch.zeros(target_len, dtype=torch.float32)
            dummy_length = torch.tensor(target_len, dtype=torch.long)
            dummy_label = torch.tensor(0, dtype=torch.long)
            return dummy_wav, dummy_label, dummy_length


def make_dataloader(
        manifest_csv: str,
        batch_size: int,
        audio_duration: float,
        is_train: bool,
        num_workers: int = 2
):
    """
    Create a DataLoader for the audio dataset.

    Args:
        manifest_csv: Path to manifest CSV file
        batch_size: Batch size
        audio_duration: Target audio duration in seconds
        is_train: Whether this is training data (affects shuffling)
        num_workers: Number of worker processes for data loading

    Returns:
        DataLoader object
    """
    dataset = ManifestAudioDataset(
        manifest_csv,
        audio_duration=audio_duration,
        is_train=is_train
    )

    # Note: On Windows, num_workers > 0 can cause issues
    # Set to 0 if you encounter multiprocessing errors
    if num_workers > 0:
        try:
            import platform
            if platform.system() == 'Windows':
                logging.warning("Windows detected: setting num_workers=0 to avoid "
                                "multiprocessing issues")
                num_workers = 0
        except:
            pass

    dataloader = DataLoader(
        dataset,
        batch_size=batch_size,
        shuffle=is_train,
        num_workers=num_workers,
        pin_memory=torch.cuda.is_available(),
        drop_last=is_train
    )

    return dataloader


def class_weights_from_manifest(train_manifest_csv: str):
    """
    Calculate class weights from training manifest for handling class imbalance.

    Weights are inversely proportional to class frequencies.

    Args:
        train_manifest_csv: Path to training manifest CSV

    Returns:
        torch.Tensor: Class weights [num_classes]
    """
    try:
        df = pd.read_csv(train_manifest_csv)
    except Exception as e:
        logging.error(f"Failed to load training manifest: {e}")
        raise

    # Count samples per class
    counts = df["label"].value_counts().to_dict()
    n_normal = counts.get("normal", 1)
    n_stress = counts.get("stress", 1)

    total = n_normal + n_stress

    # Calculate weights inversely proportional to frequency
    # Using the "effective number of samples" approach
    w_normal = total / (2.0 * n_normal)
    w_stress = total / (2.0 * n_stress)

    # Normalize so minimum weight is 1.0
    min_weight = min(w_normal, w_stress)
    w_normal /= min_weight
    w_stress /= min_weight

    logging.info(f"Class counts: normal={n_normal}, stress={n_stress}")
    logging.info(f"Class weights: normal={w_normal:.3f}, stress={w_stress:.3f}")

    # Order must match LABEL2ID: [normal, stress]
    weights = torch.tensor([w_normal, w_stress], dtype=torch.float32)

    return weights


def verify_manifest_paths(manifest_csv: str):
    """
    Verify that all audio paths in the manifest exist.

    Args:
        manifest_csv: Path to manifest CSV file

    Returns:
        tuple: (num_valid, num_invalid, invalid_paths)
    """
    df = pd.read_csv(manifest_csv)

    valid_count = 0
    invalid_count = 0
    invalid_paths = []

    for idx, row in df.iterrows():
        path = Path(row['path'])
        if path.exists():
            valid_count += 1
        else:
            invalid_count += 1
            invalid_paths.append(str(path))

    return valid_count, invalid_count, invalid_paths


if __name__ == "__main__":
    """
    Test the dataloader with a sample manifest.
    """
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=str, required=True,
                        help="Path to manifest CSV file")
    parser.add_argument("--batch_size", type=int, default=4)
    parser.add_argument("--audio_duration", type=float, default=4.0)
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO)

    # Test loading
    print(f"\n{'=' * 60}")
    print(f"Testing dataloader with manifest: {args.manifest}")
    print(f"{'=' * 60}\n")

    # Verify paths
    print("Verifying audio paths...")
    valid, invalid, invalid_paths = verify_manifest_paths(args.manifest)
    print(f"Valid paths: {valid}")
    print(f"Invalid paths: {invalid}")
    if invalid > 0:
        print("\nFirst 5 invalid paths:")
        for path in invalid_paths[:5]:
            print(f"  - {path}")

    # Create dataloader
    print(f"\nCreating dataloader...")
    dataloader = make_dataloader(
        args.manifest,
        batch_size=args.batch_size,
        audio_duration=args.audio_duration,
        is_train=True,
        num_workers=0
    )

    # Test one batch
    print(f"\nLoading one batch...")
    try:
        batch = next(iter(dataloader))
        wav, label, length = batch

        print(f"\nBatch shapes:")
        print(f"  wav: {wav.shape}")
        print(f"  label: {label.shape}")
        print(f"  length: {length.shape}")

        print(f"\nBatch info:")
        print(f"  Labels in batch: {label.tolist()}")
        print(f"  Lengths in batch: {length.tolist()}")

        print("\n✓ Dataloader test successful!")

    except Exception as e:
        print(f"\n✗ Error loading batch: {e}")
        import traceback

        traceback.print_exc()